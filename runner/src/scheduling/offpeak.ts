const MINUTE_MS = 60_000;
const MAX_SEARCH_DAYS = 30;
const MAX_WINDOWS_PER_LIST = 8;
const MAX_EXCLUDED_DATES = 366;

export type UtcWindow = {
  /** Inclusive UTC start clock, e.g. "22:00". */
  start: string;
  /** Exclusive UTC end clock; "24:00" is allowed only as an end. */
  end: string;
  /** UTC weekdays, Sunday=0 through Saturday=6; values apply to the window's start date. */
  weekdays?: number[];
};

export type PricingSchedule = {
  provider: string;
  model: string;
  sourceUrl: string;
  observedAt: string;
  expiresAt: string;
  /** Omit when the source does not establish a numeric discount. */
  discountPercent?: number;
  windows: UtcWindow[];
  /** Explicit source-verified UTC holiday dates only; no inferred country calendar. */
  excludedUtcDates?: string[];
};

export type OffpeakPolicy = {
  /** Only tasks explicitly declared flexible may be deferred. */
  flexibleDeadline: boolean;
  /** Optional user-chosen availability windows, independent of price claims. */
  userWindows?: UtcWindow[];
  /** Target selected provider/model. Required to match a pricing quote. */
  target?: { provider: string; model: string };
  pricingSchedule?: PricingSchedule;
  /** Explicit dates on which this task may not be admitted, in UTC YYYY-MM-DD. */
  excludedUtcDates?: string[];
};

export type DiscountEvidence = {
  status: 'known' | 'unknown' | 'none';
  percent?: number;
  provider?: string;
  model?: string;
  sourceUrl?: string;
  observedAt?: string;
  expiresAt?: string;
  explanation: string;
};

export type Eligibility =
  | {
      status: 'eligible';
      notBefore: string;
      reason: string;
      basis: 'immediate' | 'user-window' | 'pricing-window';
      discount: DiscountEvidence;
    }
  | { status: 'blocked'; reason: string; deadline: string | null };

/**
 * Deterministic UTC admission helper for opt-in deferred routine work.
 *
 * Pricing is caller-supplied and valid only on [observedAt, expiresAt). A stale,
 * missing, or provider/model-mismatched quote never causes a discount claim.
 * User windows can still schedule work, explicitly labeled `user-window`.
 *
 * Dated source reference (pricing is not embedded as live policy): DeepSeek's
 * official pricing page, checked 2026-10-30, lists Flash at $0.15/M uncached
 * input, $0.003/M cached input, and $0.60/M output off-peak, with non-peak
 * periods at half price and Chinese holidays excluded. The page is the source
 * for a caller's bounded quote; callers must supply the observed/expiry times
 * and an explicit holiday-date set. https://api-docs.deepseek.com/quick_start/pricing/
 * This helper computes admission only; it does not submit provider batch jobs
 * or translate subscription-CLI ACP tasks into provider API requests.
 */
export function nextEligible(input: {
  now: Date | string | number;
  deadline: Date | string | number | null;
  policy: OffpeakPolicy;
  enabled: boolean;
}): Eligibility {
  let now: number;
  try {
    now = timestamp(input.now, 'now');
  } catch (error) {
    return { status: 'blocked', reason: `invalid scheduling time: ${errorMessage(error)}`, deadline: null };
  }
  const nowIso = new Date(now).toISOString();
  let deadline: number | null;
  try {
    deadline = input.deadline === null ? null : timestamp(input.deadline, 'deadline');
  } catch (error) {
    return { status: 'blocked', reason: `invalid scheduling deadline: ${errorMessage(error)}`, deadline: null };
  }
  const deadlineIso = deadline === null ? null : new Date(deadline).toISOString();
  if (deadline !== null && deadline < now)
    return { status: 'blocked', reason: 'deadline has elapsed', deadline: deadlineIso };
  if (!input.enabled) return immediate(nowIso, 'deferred scheduling is disabled; start now');
  if (!input.policy.flexibleDeadline) return immediate(nowIso, 'task is not declared deadline-flexible; start now');
  if (deadline === null) return immediate(nowIso, 'no deadline supplied; keep task immediate');

  try {
    validatePolicy(input.policy);
  } catch (error) {
    return { status: 'blocked', reason: `invalid scheduling policy: ${errorMessage(error)}`, deadline: deadlineIso };
  }
  if (deadline - now > MAX_SEARCH_DAYS * 24 * 60 * MINUTE_MS) {
    return {
      status: 'blocked',
      reason: `scheduling deadline exceeds the ${MAX_SEARCH_DAYS}-day horizon`,
      deadline: deadlineIso,
    };
  }

  const policyDates = new Set(input.policy.excludedUtcDates ?? []);
  const schedule = input.policy.pricingSchedule;
  const quoteMatches =
    schedule !== undefined &&
    input.policy.target !== undefined &&
    schedule.provider === input.policy.target.provider &&
    schedule.model === input.policy.target.model;
  const freshSchedule = schedule !== undefined && quoteMatches && quoteFreshAt(schedule, now) ? schedule : undefined;
  const userWindows = input.policy.userWindows ?? [];
  const pricingWindows = freshSchedule?.windows ?? [];
  const allExclusions = new Set([...policyDates, ...(freshSchedule?.excludedUtcDates ?? [])]);

  if (userWindows.length && pricingWindows.length) {
    const together = findWindowTime(
      now,
      deadline,
      userWindows,
      pricingWindows,
      allExclusions,
      freshSchedule?.expiresAt,
    );
    if (together !== undefined) {
      return pricingEligible(together, freshSchedule!);
    }
  }
  if (pricingWindows.length && !userWindows.length) {
    const priced = findWindowTime(now, deadline, pricingWindows, undefined, allExclusions, freshSchedule?.expiresAt);
    if (priced !== undefined) return pricingEligible(priced, freshSchedule!);
  }
  if (userWindows.length) {
    const userTime = findWindowTime(now, deadline, userWindows, undefined, policyDates);
    if (userTime !== undefined) {
      const quoteStatus =
        schedule && !freshSchedule
          ? 'pricing evidence is missing, stale, or does not match the selected provider/model; no discount is claimed'
          : 'user-selected availability window; no pricing discount is claimed';
      return {
        status: 'eligible',
        notBefore: new Date(userTime).toISOString(),
        reason: 'admit in the next user-selected UTC window',
        basis: 'user-window',
        discount: { status: 'unknown', explanation: quoteStatus },
      };
    }
  }
  const staleReason =
    schedule && !freshSchedule && userWindows.length
      ? 'no user window occurs before the deadline; stale or mismatched pricing cannot be used'
      : schedule && !freshSchedule
        ? 'pricing quote is missing, stale, or mismatched and no user window is configured'
        : 'no configured window occurs before the deadline';
  return { status: 'blocked', reason: staleReason, deadline: deadlineIso };
}

function immediate(notBefore: string, reason: string): Eligibility {
  return {
    status: 'eligible',
    notBefore,
    reason,
    basis: 'immediate',
    discount: { status: 'none', explanation: 'no deferral or price claim' },
  };
}

function pricingEligible(at: number, schedule: PricingSchedule): Eligibility {
  const evidence: DiscountEvidence = {
    status: schedule.discountPercent === undefined ? 'unknown' : 'known',
    ...(schedule.discountPercent === undefined ? {} : { percent: schedule.discountPercent }),
    provider: schedule.provider,
    model: schedule.model,
    sourceUrl: schedule.sourceUrl,
    observedAt: schedule.observedAt,
    expiresAt: schedule.expiresAt,
    explanation:
      schedule.discountPercent === undefined
        ? 'fresh matching pricing schedule identifies a window but no discount amount'
        : 'discount amount is from a fresh matching caller-supplied quote; total task savings are not guaranteed',
  };
  return {
    status: 'eligible',
    notBefore: new Date(at).toISOString(),
    reason: 'next matching provider pricing window',
    basis: 'pricing-window',
    discount: evidence,
  };
}

function findWindowTime(
  now: number,
  deadline: number,
  first: UtcWindow[],
  second?: UtcWindow[],
  excludedDates: Set<string> = new Set(),
  quoteExpiresAt?: string,
): number | undefined {
  const expiryBound = quoteExpiresAt ? timestamp(quoteExpiresAt, 'quote expiresAt') - 1 : deadline;
  const end = Math.min(deadline, expiryBound, now + MAX_SEARCH_DAYS * 24 * 60 * MINUTE_MS);
  const firstCandidate =
    isInAnyWindow(now, first, excludedDates) && (!second || isInAnyWindow(now, second, excludedDates))
      ? now
      : Math.ceil(now / MINUTE_MS) * MINUTE_MS;
  for (let candidate = firstCandidate; candidate <= end; candidate += MINUTE_MS) {
    if (isInAnyWindow(candidate, first, excludedDates) && (!second || isInAnyWindow(candidate, second, excludedDates)))
      return candidate;
  }
  return undefined;
}

function isInAnyWindow(at: number, windows: UtcWindow[], excludedDates: Set<string>): boolean {
  return windows.some((window) => isInWindow(at, window, excludedDates));
}

function isInWindow(at: number, window: UtcWindow, excludedDates: Set<string>): boolean {
  const date = new Date(at);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const start = parseClock(window.start, false);
  const end = parseClock(window.end, true);
  let anchorDate = date;
  let inside: boolean;
  if (start < end) inside = minute >= start && minute < end;
  else {
    inside = minute >= start || minute < end;
    if (minute < end) anchorDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1));
  }
  if (!inside) return false;
  const currentDate = date.toISOString().slice(0, 10);
  const anchorIso = anchorDate.toISOString().slice(0, 10);
  if (excludedDates.has(currentDate) || excludedDates.has(anchorIso)) return false;
  if (window.weekdays && !window.weekdays.includes(anchorDate.getUTCDay())) return false;
  return true;
}

function validatePolicy(policy: OffpeakPolicy): void {
  if (policy.userWindows !== undefined) validateWindows(policy.userWindows, 'userWindows');
  validateDates(policy.excludedUtcDates ?? [], 'excludedUtcDates');
  if (policy.target) {
    if (!policy.target.provider.trim() || !policy.target.model.trim())
      throw new Error('target provider and model are required');
  }
  const schedule = policy.pricingSchedule;
  if (schedule) {
    if (!schedule.provider.trim() || !schedule.model.trim()) throw new Error('pricing provider and model are required');
    const url = new URL(schedule.sourceUrl);
    if (url.protocol !== 'https:') throw new Error('pricing sourceUrl must use HTTPS');
    const observedAt = timestamp(schedule.observedAt, 'pricing observedAt');
    const expiresAt = timestamp(schedule.expiresAt, 'pricing expiresAt');
    if (expiresAt <= observedAt) throw new Error('pricing expiresAt must follow observedAt');
    if (
      schedule.discountPercent !== undefined &&
      (!Number.isFinite(schedule.discountPercent) || schedule.discountPercent < 0 || schedule.discountPercent > 100)
    ) {
      throw new Error('discountPercent must be between 0 and 100');
    }
    validateWindows(schedule.windows, 'pricingSchedule.windows');
    validateDates(schedule.excludedUtcDates ?? [], 'pricingSchedule.excludedUtcDates');
  }
}

function validateWindows(windows: UtcWindow[], label: string): void {
  if (!windows.length) throw new Error(`${label} must contain at least one window`);
  if (windows.length > MAX_WINDOWS_PER_LIST)
    throw new Error(`${label} cannot contain more than ${MAX_WINDOWS_PER_LIST} windows`);
  for (const window of windows) {
    const start = parseClock(window.start, false);
    const end = parseClock(window.end, true);
    if (start === end) throw new Error(`${label} window start and end must differ`);
    if (
      window.weekdays &&
      (!window.weekdays.length || window.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
    ) {
      throw new Error(`${label} weekdays must be values 0-6`);
    }
  }
}

function validateDates(dates: string[], label: string): void {
  if (dates.length > MAX_EXCLUDED_DATES)
    throw new Error(`${label} cannot contain more than ${MAX_EXCLUDED_DATES} dates`);
  for (const value of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
      throw new Error(`${label} entries must be valid UTC YYYY-MM-DD dates`);
    }
  }
}

function quoteFreshAt(schedule: PricingSchedule, at: number): boolean {
  const observedAt = timestamp(schedule.observedAt, 'pricing observedAt');
  const expiresAt = timestamp(schedule.expiresAt, 'pricing expiresAt');
  return observedAt <= at && at < expiresAt;
}

function parseClock(value: string, allow24: boolean): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid UTC clock: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour === 24 && minute === 0 && allow24) return 24 * 60;
  if (hour > 23 || minute > 59) throw new Error(`invalid UTC clock: ${value}`);
  return hour * 60 + minute;
}

function timestamp(value: Date | string | number, label: string): number {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : isUtcTimestamp(value)
          ? Date.parse(value)
          : NaN;
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime()))
    throw new Error(`${label} must be a valid RFC3339 UTC timestamp ending in Z`);
  if (typeof value === 'string' && new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error(`${label} must be a valid RFC3339 UTC timestamp ending in Z`);
  return time;
}

function isUtcTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
