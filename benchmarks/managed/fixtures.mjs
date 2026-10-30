import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// New fixture split. Reference implementations and acceptance never get copied
// into the source workspace. Same-UID processes are not a security sandbox.
export const managedFixtures = [
  {
    id: "invoice-rollup",
    version: 2,
    prompt:
      "Repair this invoice package to satisfy docs/contract.md and docs/policy.md. Fix exact decimal parsing in src/money.mjs and independent deduplication/refund behavior in src/rollup.mjs. Preserve the public exports and create a brief CHANGELOG.md describing the fixes. Implement changes rather than only describing them.",
    files: {
      "docs/contract.md": `# Invoice contract (version 2)
Public exports: parseCents(value), rollup(rows = []). No dependencies.

parseCents accepts only strings matching ^[+-]?[0-9]+(?:\\.[0-9]{1,2})?$.
An optional plus or minus sign is allowed; leading zeros are allowed. An integer
part is required. A decimal point requires one or two following digits. Reject
all whitespace (including trailing newlines), exponent syntax, empty strings,
non-strings, NaN/Infinity text, omitted integer parts (.50), trailing points (1.),
and more than two fractional digits. No rounding. Return exact integer cents.
The result must be in [-9007199254740991, 9007199254740991], inclusive; amounts
outside that range throw TypeError, as do all other invalid values. Zero is
normalized to positive 0, including -0 and -0.00. Examples: +12.3 -> 1230,
001.02 -> 102, 90071992547409.91 -> 9007199254740991.

rollup accepts an array of rows {id, kind, amount}. IDs are strings or numbers;
kind is exactly 'sale' or 'refund'; amount uses the parseCents grammar above.
Return {count,totalCents}: count retained distinct IDs, add sale cents, subtract
refund cents (so a refund of a negative amount adds its magnitude). Equality of
IDs follows Map/Set equality: number 1 differs from string '1'. The first row
for each ID wins, including a first refund. Skip duplicate rows before reading
or validating their kind/amount; invalid duplicate contents are ignored.
A retained invalid kind or amount throws TypeError. Empty or omitted rows return
{count:0,totalCents:0}. Inputs have valid row objects/IDs and safe-integer running
totals; behavior outside those input conditions is not part of this exercise.
`,
      "docs/policy.md":
        "# Accounting policy\nInvoice amounts use exact cents; rounding is forbidden. Refunds negate the parsed signed amount, including a negative input. Duplicate invoice IDs retain the first occurrence, including a first refund; later duplicates are ignored before validation.\n",
      "src/money.mjs": "export function parseCents(value){return Math.round(Number(value)*100);}\n",
      "src/rollup.mjs":
        "import {parseCents} from './money.mjs';\nexport function rollup(rows=[]){let totalCents=0;for(const row of rows)totalCents+=parseCents(row.amount);return {count:rows.length,totalCents};}\n",
      "src/index.mjs":
        "export {parseCents} from './money.mjs';export {rollup} from './rollup.mjs';\n",
      "README.md":
        "# Invoice package\nPublic entry point: src/index.mjs. No dependencies. Source behavior is specified in docs/contract.md.\n",
    },
    refs: ["docs/contract.md", "src/money.mjs", "src/rollup.mjs"],
    memory: {
      query: "Invoice",
      text: "Invoice policy: exact cents, no rounding; refunds negate the amount and duplicate IDs retain the first occurrence.",
      source: "docs/policy.md",
    },
    childFile: "src/money.mjs",
    reference: {
      "src/money.mjs":
        "export function parseCents(v){if(typeof v!=='string'||v.trim()!==v||! /^[+-]?\\d+(?:\\.\\d{1,2})?$/.test(v))throw new TypeError('amount');const neg=v[0]==='-';const [a,b='']=v.replace(/^[+-]/,'').split('.');const n=BigInt(a)*100n+BigInt(b.padEnd(2,'0'));if(n>9007199254740991n)throw new TypeError('amount');return n===0n?0:Number(neg?-n:n);}\n",
      "src/rollup.mjs":
        "import {parseCents} from './money.mjs';export function rollup(rows=[]){const seen=new Set();let count=0,totalCents=0;for(const row of rows){if(seen.has(row.id))continue;seen.add(row.id);if(!['sale','refund'].includes(row.kind))throw new TypeError('kind');count++;totalCents+=(row.kind==='refund'?-1:1)*parseCents(row.amount);}return {count,totalCents};}\n",
    },
    check: async (root, seed) => {
      const { parseCents, rollup } = await load(root, "src/index.mjs");
      for (const [value, cents] of [
        ["0", 0],
        ["0.01", 1],
        ["-12.3", -1230],
        ["9.99", 999],
        ["+12.3", 1230],
        ["001.02", 102],
        ["-0", 0],
        ["-0.00", 0],
        ["90071992547409.91", Number.MAX_SAFE_INTEGER],
        ["-90071992547409.91", -Number.MAX_SAFE_INTEGER],
        [`${seed}.07`, seed * 100 + 7],
      ])
        assert.equal(parseCents(value), cents);
      for (const value of [
        null,
        1.2,
        "",
        " 1",
        "1 ",
        "1\n",
        "1e2",
        "0.001",
        "1.999",
        "NaN",
        "Infinity",
        ".50",
        "1.",
        "+",
        "--1",
        "90071992547409.92",
        "-90071992547409.92",
      ])
        assert.throws(() => parseCents(value), TypeError);
      assert.deepEqual(rollup([]), { count: 0, totalCents: 0 });
      assert.deepEqual(rollup(), { count: 0, totalCents: 0 });
      assert.deepEqual(
        rollup([
          { id: "a", kind: "refund", amount: "1.25" },
          { id: "a", kind: "sale", amount: "99" },
          { id: "b", kind: "sale", amount: "2.50" },
        ]),
        { count: 2, totalCents: 125 },
      );
      assert.throws(() => rollup([{ id: "x", kind: "other", amount: "1" }]), TypeError);
      assert.throws(() => rollup([{ id: "x", kind: "sale", amount: "1.999" }]), TypeError);
      assert.deepEqual(
        rollup([
          { id: 1, kind: "sale", amount: "+1.00" },
          { id: 1, kind: "invalid", amount: "bad" },
          { id: "1", kind: "refund", amount: "-2" },
        ]),
        { count: 2, totalCents: 300 },
      );
      for (let i = 1; i <= 6; i++)
        assert.deepEqual(
          rollup([
            { id: i, kind: "sale", amount: `${seed + i}.01` },
            { id: i, kind: "sale", amount: "999" },
          ]),
          { count: 1, totalCents: (seed + i) * 100 + 1 },
        );
    },
  },
  {
    id: "coalesced-requests",
    version: 2,
    prompt:
      "Repair the request helpers according to docs/contract.md and docs/policy.md. Fix pending-only coalescing in src/coalesce.mjs and independent retry boundaries/error identity in src/attempt.mjs. Preserve public exports and create a brief CHANGELOG.md describing fixes. Implement changes rather than only describing them.",
    files: {
      "docs/contract.md": `# Request contract (version 2)
Public exports: coalesce(loader), attempt(fn, maxAttempts = 3). No dependencies.

coalesce(loader) returns get(key). Keys use Map equality. Concurrent calls for
the same key share exactly one Promise and one loader(key) invocation. Different
keys remain independent and receive their own key as the loader argument. Entries
exist only while pending: both fulfillment and rejection evict, so a call after
awaiting settlement starts a new request. Never persist settled values or errors.
Synchronous loader throws become rejected Promises rather than throws from get;
both synchronous and asynchronous rejection preserve the original error object.
The loader may run immediately or in a microtask; it must have started after one
microtask turn. get always returns a Promise, even when the loader returns a value.

attempt(fn, maxAttempts = 3) returns a Promise. maxAttempts must be a positive
integer number (no string coercion, fractions, NaN or Infinity). Invalid bounds
reject with RangeError before calling fn. The bound counts total fn calls,
including the initial call. Await each call before retrying, return its first
successful value and make no later calls. Synchronous throws and asynchronous
rejections both count as failures. If every allowed call fails, reject with the
exact last thrown/rejected object, preserving its identity. No delay is required.
`,
      "docs/policy.md":
        "# Request policy\nRequest coalescing is pending-only, never a persistent value cache. Failed work must be evicted. Retry bounds include the initial call; error objects retain identity.\n",
      "src/coalesce.mjs":
        "export function coalesce(loader){const cache=new Map();return key=>{if(!cache.has(key))cache.set(key,Promise.resolve(loader(key)));return cache.get(key);};}\n",
      "src/attempt.mjs":
        "export async function attempt(fn,maxAttempts=3){for(let i=0;i<=maxAttempts;i++){try{return await fn();}catch(e){if(i===maxAttempts)throw new Error(e.message);}}}\n",
      "src/index.mjs":
        "export {coalesce} from './coalesce.mjs';export {attempt} from './attempt.mjs';\n",
      "README.md":
        "# Request helpers\nPublic entry: src/index.mjs. No dependencies. See docs/contract.md.\n",
    },
    refs: ["docs/contract.md", "src/coalesce.mjs", "src/attempt.mjs"],
    memory: {
      query: "Request",
      text: "Request policy: coalescing entries exist only while pending and evict on rejection; retry bounds include the initial call and preserve the last error object.",
      source: "docs/policy.md",
    },
    childFile: "src/coalesce.mjs",
    reference: {
      "src/coalesce.mjs":
        "export function coalesce(loader){const pending=new Map();return key=>{if(pending.has(key))return pending.get(key);const p=Promise.resolve().then(()=>loader(key));pending.set(key,p);const clear=()=>{if(pending.get(key)===p)pending.delete(key);};p.then(clear,clear);return p;};}\n",
      "src/attempt.mjs":
        "export async function attempt(fn,maxAttempts=3){if(!Number.isInteger(maxAttempts)||maxAttempts<1)throw new RangeError('maxAttempts');for(let i=0;i<maxAttempts;i++){try{return await fn();}catch(e){if(i===maxAttempts-1)throw e;}}}\n",
    },
    check: async (root, seed) => {
      const { coalesce, attempt } = await load(root, "src/index.mjs");
      let resolve,
        calls = 0;
      const get = coalesce(() => {
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      });
      const a = get("same"),
        b = get("same");
      assert.equal(a, b);
      await Promise.resolve();
      assert.equal(calls, 1);
      resolve(seed);
      assert.equal(await a, seed);
      await Promise.resolve();
      const c = get("same");
      assert.notEqual(c, a);
      await Promise.resolve();
      assert.equal(calls, 2);
      resolve(seed + 1);
      await c;
      let rejected = 0;
      const error = new Error("original");
      const bad = coalesce(() => {
        rejected++;
        throw error;
      });
      await assert.rejects(bad("x"), (e) => e === error);
      await assert.rejects(bad("x"), (e) => e === error);
      assert.equal(rejected, 2);
      const asyncError = new Error("async-original");
      let asyncCalls = 0;
      const asyncBad = coalesce(async () => {
        asyncCalls++;
        throw asyncError;
      });
      await assert.rejects(asyncBad("x"), (e) => e === asyncError);
      await assert.rejects(asyncBad("x"), (e) => e === asyncError);
      assert.equal(asyncCalls, 2);
      const resolvers = new Map();
      let distinctCalls = 0;
      const distinct = coalesce((key) => {
        distinctCalls++;
        return new Promise((resolve) => resolvers.set(key, resolve));
      });
      const left = distinct("left"),
        right = distinct("right");
      await Promise.resolve();
      assert.equal(distinctCalls, 2);
      assert.notEqual(left, right);
      resolvers.get("left")(seed);
      resolvers.get("right")(seed + 1);
      assert.deepEqual(await Promise.all([left, right]), [seed, seed + 1]);
      for (const n of [1, 2, 4]) {
        let count = 0;
        await assert.rejects(
          attempt(() => {
            count++;
            throw error;
          }, n),
          (e) => e === error,
        );
        assert.equal(count, n);
      }
      for (const n of [0, -1, 1.5, "2", NaN, Infinity]) {
        let count = 0;
        await assert.rejects(
          attempt(() => {
            count++;
          }, n),
          RangeError,
        );
        assert.equal(count, 0);
      }
      assert.equal(await attempt(() => seed, 2), seed);
      let defaultCalls = 0;
      await assert.rejects(
        attempt(async () => {
          defaultCalls++;
          throw error;
        }),
        (e) => e === error,
      );
      assert.equal(defaultCalls, 3);
      let successCalls = 0;
      assert.equal(
        await attempt(async () => {
          if (++successCalls === 1) throw error;
          return seed;
        }, 4),
        seed,
      );
      assert.equal(successCalls, 2);
      const lastError = new Error("last");
      let distinctErrors = 0;
      await assert.rejects(
        attempt(() => {
          throw ++distinctErrors === 1 ? error : lastError;
        }, 2),
        (e) => e === lastError,
      );
    },
  },
];
const load = (root, file) => import(pathToFileURL(join(root, file)).href + "?" + randomUUID());
export async function prepareManaged(root, fixture) {
  for (const [file, content] of Object.entries(fixture.files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
}
export function fixtureHash(fixture) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: fixture.id,
        version: fixture.version,
        prompt: fixture.prompt,
        files: fixture.files,
        refs: fixture.refs,
        memory: fixture.memory,
      }),
    )
    .digest("hex");
}
export async function gradeManaged(root, id, seed = 17) {
  const fixture = managedFixtures.find((task) => task.id === id);
  if (!fixture || !Number.isSafeInteger(seed) || seed < 1 || seed > 1000)
    throw Error("invalid managed fixture");
  try {
    await fixture.check(root, seed);
    return { pass: true, reason: "deterministic-contract-checks" };
  } catch {
    return { pass: false, reason: "deterministic-contract-failed" };
  }
}

export const factorialArms = Array.from({ length: 16 }, (_, bits) => {
  const flags = {
    auto: !!(bits & 1),
    context: !!(bits & 2),
    memory: !!(bits & 4),
    delegation: !!(bits & 8),
  };
  const active = Object.keys(flags).filter((key) => flags[key]);
  return {
    id: !bits
      ? "baseline"
      : bits === 15
        ? "all-enabled"
        : active.length === 1
          ? `${active[0]}-only`
          : active.join("-"),
    ...flags,
  };
});
export const discoveryArms = [
  "baseline",
  "auto-only",
  "context-only",
  "memory-only",
  "delegation-only",
];
