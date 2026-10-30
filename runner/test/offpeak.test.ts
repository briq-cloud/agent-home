import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextEligible, type PricingSchedule } from '../src/scheduling/offpeak.ts';

const base = {
  flexibleDeadline: true,
  target: { provider: 'deepseek', model: 'flash' },
};
const quote: PricingSchedule = {
  provider: 'deepseek',
  model: 'flash',
  sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
  observedAt: '2026-10-29T00:00:00Z',
  expiresAt: '2026-11-02T00:00:00Z',
  discountPercent: 50,
  windows: [{ start: '22:00', end: '04:00', weekdays: [0, 1, 2, 3, 4, 5, 6] }],
};

test('disabled or undeclared deferral leaves the task immediate', () => {
  const disabled = nextEligible({
    now: '2026-10-30T12:34:56Z',
    deadline: '2026-10-31T12:00:00Z',
    enabled: false,
    policy: base,
  });
  assert.equal(disabled.status, 'eligible');
  assert.equal(disabled.status === 'eligible' && disabled.notBefore, '2026-10-30T12:34:56.000Z');
  assert.equal(disabled.status === 'eligible' && disabled.discount.status, 'none');
  const fixed = nextEligible({
    now: '2026-10-30T12:34:56Z',
    deadline: '2026-10-31T12:00:00Z',
    enabled: true,
    policy: { ...base, flexibleDeadline: false },
  });
  assert.equal(fixed.status === 'eligible' && fixed.basis, 'immediate');
});

test('user window supports a cross-midnight span and anchors weekday to its start date', () => {
  const result = nextEligible({
    now: '2026-10-30T23:30:00Z',
    deadline: '2026-10-31T03:00:00Z',
    enabled: true,
    policy: { ...base, userWindows: [{ start: '22:00', end: '02:00', weekdays: [5] }] },
  });
  assert.equal(result.status, 'eligible');
  if (result.status !== 'eligible') return;
  assert.equal(result.notBefore, '2026-10-30T23:30:00.000Z');
  assert.equal(result.basis, 'user-window');
});

test('explicit excluded UTC date blocks the after-midnight part of a cross-midnight window', () => {
  const result = nextEligible({
    now: '2026-10-31T01:00:00Z',
    deadline: '2026-11-07T03:00:00Z',
    enabled: true,
    policy: {
      ...base,
      userWindows: [{ start: '22:00', end: '02:00', weekdays: [5] }],
      excludedUtcDates: ['2026-10-31'],
    },
  });
  assert.equal(result.status, 'eligible');
  if (result.status !== 'eligible') return;
  assert.equal(result.notBefore, '2026-11-06T22:00:00.000Z');
});

test('weekend weekdays and explicit holidays are both honored without guessing calendars', () => {
  const result = nextEligible({
    now: '2026-10-31T08:00:00Z',
    deadline: '2026-11-05T18:00:00Z',
    enabled: true,
    policy: {
      ...base,
      userWindows: [{ start: '09:00', end: '17:00', weekdays: [1, 2, 3, 4, 5] }],
      excludedUtcDates: ['2026-11-02', '2026-11-03'],
    },
  });
  assert.equal(result.status, 'eligible');
  if (result.status !== 'eligible') return;
  assert.equal(result.notBefore, '2026-11-04T09:00:00.000Z');
});

test('deadline blocks when the next configured window is too late', () => {
  const result = nextEligible({
    now: '2026-10-30T20:00:00Z',
    deadline: '2026-11-01T23:59:00Z',
    enabled: true,
    policy: { ...base, userWindows: [{ start: '09:00', end: '10:00', weekdays: [1] }] },
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /no configured window/);
});

test('fresh matching quote can establish a dated price window and known discount only', () => {
  const result = nextEligible({
    now: '2026-10-30T21:00:00Z',
    deadline: '2026-10-31T02:00:00Z',
    enabled: true,
    policy: { ...base, pricingSchedule: quote },
  });
  assert.equal(result.status, 'eligible');
  if (result.status !== 'eligible') return;
  assert.equal(result.notBefore, '2026-10-30T22:00:00.000Z');
  assert.equal(result.basis, 'pricing-window');
  assert.equal(result.discount.status, 'known');
  assert.equal(result.discount.percent, 50);
  assert.match(result.discount.explanation, /total task savings are not guaranteed/);
});

test('stale or missing quote can use an optional user window but never claims a discount', () => {
  const stale = { ...quote, observedAt: '2026-10-20T00:00:00Z', expiresAt: '2026-10-29T00:00:00Z' };
  const result = nextEligible({
    now: '2026-10-30T12:00:00Z',
    deadline: '2026-10-31T20:00:00Z',
    enabled: true,
    policy: { ...base, pricingSchedule: stale, userWindows: [{ start: '18:00', end: '20:00' }] },
  });
  assert.equal(result.status, 'eligible');
  if (result.status !== 'eligible') return;
  assert.equal(result.notBefore, '2026-10-30T18:00:00.000Z');
  assert.equal(result.basis, 'user-window');
  assert.equal(result.discount.status, 'unknown');
  assert.equal(result.discount.percent, undefined);
  assert.match(result.discount.explanation, /no discount is claimed/);
  const missing = nextEligible({
    now: '2026-10-30T12:00:00Z',
    deadline: '2026-10-31T20:00:00Z',
    enabled: true,
    policy: { ...base, userWindows: [{ start: '18:00', end: '20:00' }] },
  });
  assert.equal(missing.status === 'eligible' && missing.basis, 'user-window');
  assert.equal(missing.status === 'eligible' && missing.discount.status, 'unknown');
});

test('provider/model mismatch does not transfer another quote discount', () => {
  const result = nextEligible({
    now: '2026-10-30T21:00:00Z',
    deadline: '2026-10-31T20:00:00Z',
    enabled: true,
    policy: {
      ...base,
      target: { provider: 'other', model: 'flash' },
      pricingSchedule: quote,
      userWindows: [{ start: '22:00', end: '23:00' }],
    },
  });
  assert.equal(result.status, 'eligible');
  assert.equal(result.status === 'eligible' && result.discount.status, 'unknown');
});

test('invalid windows, timestamps, and holiday dates are rejected as blocked policy', () => {
  const invalid = nextEligible({
    now: '2026-10-30T12:00:00Z',
    deadline: '2026-10-31T12:00:00Z',
    enabled: true,
    policy: { ...base, userWindows: [{ start: '25:00', end: '26:00' }] },
  });
  assert.equal(invalid.status, 'blocked');
  assert.match(invalid.reason, /invalid UTC clock/);
  const invalidDate = nextEligible({
    now: '2026-10-30T12:00:00Z',
    deadline: '2026-10-31T12:00:00Z',
    enabled: true,
    policy: { ...base, userWindows: [{ start: '12:00', end: '13:00' }], excludedUtcDates: ['2026-02-30'] },
  });
  assert.equal(invalidDate.status, 'blocked');
  const invalidTime = nextEligible({
    now: '2026-02-30T12:00:00Z',
    deadline: '2026-03-01T12:00:00Z',
    enabled: true,
    policy: { ...base, userWindows: [{ start: '12:00', end: '13:00' }] },
  });
  assert.equal(invalidTime.status, 'blocked');
  assert.match(invalidTime.reason, /invalid scheduling time/);
});

test('oversized window and exclusion lists are rejected before any search', () => {
  const windows = Array.from({ length: 9 }, () => ({ start: '12:00', end: '13:00' }));
  const windowResult = nextEligible({
    now: '2026-10-30T12:00:00Z',
    deadline: '2026-10-31T12:00:00Z',
    enabled: true,
    policy: { ...base, userWindows: windows },
  });
  assert.equal(windowResult.status, 'blocked');
  assert.match(windowResult.reason, /more than 8 windows/);

  const dateResult = nextEligible({
    now: '2026-10-30T12:00:00Z',
    deadline: '2026-10-31T12:00:00Z',
    enabled: true,
    policy: {
      ...base,
      excludedUtcDates: Array.from({ length: 367 }, (_, index) =>
        new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
      ),
      userWindows: [{ start: '12:00', end: '13:00' }],
    },
  });
  assert.equal(dateResult.status, 'blocked');
  assert.match(dateResult.reason, /more than 366 dates/);
});

test('far-future no-match deadline is rejected within the bounded horizon', () => {
  const startedAt = performance.now();
  const result = nextEligible({
    now: '2026-10-30T12:00:00Z',
    deadline: '2026-12-30T12:00:00Z',
    enabled: true,
    policy: { ...base, userWindows: [{ start: '00:00', end: '00:01', weekdays: [0] }] },
  });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /30-day horizon/);
  assert.ok(elapsedMs < 500, `far-future no-match evaluation took ${elapsedMs.toFixed(1)} ms`);
});
