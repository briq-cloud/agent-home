import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const load = (dir, file) => import(pathToFileURL(join(dir, file)).href + "?" + randomUUID());
const tick = () => new Promise(setImmediate);
const gate = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

const configReference = {
  "src/parse.mjs": `export function integer(value, name, min, max) {
  const n=typeof value==='number'?value:Number(value);
  if((typeof value==='string'&&value.trim()==='') || value===null || typeof value==='object' || typeof value==='boolean' || !Number.isInteger(n)) throw new TypeError(name);
  if(n<min || n>max) throw new RangeError(name);
  return n;
}\n`,
  "src/env.mjs": `export function readEnv(env={}) {
 const out={};
 if(env.APP_TIMEOUT_MS!==undefined)out.timeoutMs=env.APP_TIMEOUT_MS;
 if(env.APP_RETRIES!==undefined)out.retries=env.APP_RETRIES;
 return out;
}\n`,
  "src/flags.mjs": `export function parseArgs(args=[]) {
 const out={};
 for(const arg of args){const i=arg.indexOf('=');if(i<0)throw new TypeError('flag');const k=arg.slice(0,i),v=arg.slice(i+1);
 if(k==='--timeout-ms')out.timeoutMs=v;else if(k==='--timeout')out.timeout=v;else if(k==='--retries')out.retries=v;else throw new TypeError('flag');}
 return out;
}\n`,
  "src/config.mjs": `import {integer} from './parse.mjs';
import {readEnv} from './env.mjs';
import {parseArgs} from './flags.mjs';
export function loadConfig({file={},env={},args=[]}={}) {
 const flags=parseArgs(args), vars=readEnv(env);
 const pick=(o,newKey,oldKey)=>o[newKey]!==undefined?o[newKey]:o[oldKey];
 const select=(...values)=>values.find(v=>v!==undefined);
 const timeout=select(pick(flags,'timeoutMs','timeout'),vars.timeoutMs,pick(file,'timeoutMs','timeout'),1000);
 const retries=select(flags.retries,vars.retries,file.retries,2);
 return {timeoutMs:integer(timeout,'timeoutMs',0,60000),retries:integer(retries,'retries',0,5)};
}\n`,
  "src/client.mjs": `import {loadConfig} from './config.mjs';
export function createClient(input={}){const c=loadConfig(input);return {requestOptions(){return {timeout:c.timeoutMs,maxAttempts:c.retries+1};}};}
`,
};
const queueReference = {
  "src/queue.mjs": `import {abortError} from './errors.mjs';
export function createQueue({concurrency=2}={}) {
 if(!Number.isInteger(concurrency)||concurrency<1)throw new RangeError('concurrency');
 let active=0,closed=false;const pending=[],idle=[];
 const notify=()=>{if(!active&&!pending.length)for(const r of idle.splice(0))r();};
 const pump=()=>{while(active<concurrency&&pending.length){const j=pending.shift();if(j.signal?.aborted){j.reject(abortError());j.cleanup();continue;}
 active++;j.started=true;
 Promise.resolve().then(()=>j.fn(j.signal)).then(j.resolve,j.reject).finally(()=>{active--;j.cleanup();pump();notify();});}notify();};
 return {
 enqueue(fn,{signal}={}){if(closed)return Promise.reject(new Error('closed'));if(signal?.aborted)return Promise.reject(abortError());
 return new Promise((resolve,reject)=>{const j={fn,signal,resolve,reject,started:false,cleanup:()=>signal?.removeEventListener('abort',abort)};
 const abort=()=>{reject(abortError());if(!j.started){const i=pending.indexOf(j);if(i>=0)pending.splice(i,1);j.cleanup();notify();}};
 signal?.addEventListener('abort',abort,{once:true});pending.push(j);pump();});},
 onIdle(){return !active&&!pending.length?Promise.resolve():new Promise(r=>idle.push(r));},
 close(){closed=true;return this.onIdle();}
 };
}\n`,
};
const cacheReference = {
  "src/cache.mjs": `export function createCache({ttlMs=100,now=Date.now}={}) {
 const tenants=new Map();
 const bucket=t=>{if(!tenants.has(t))tenants.set(t,new Map());return tenants.get(t);};
 return {
 get(tenant,key,loader){const b=bucket(tenant),old=b.get(key);if(old?.pending)return old.pending;if(old&&old.expires>now())return Promise.resolve(old.value);
 const state={};b.set(key,state);const promise=Promise.resolve().then(loader).then(value=>{if(b.get(key)===state){if(ttlMs>0){state.value=value;state.expires=now()+ttlMs;delete state.pending;}else b.delete(key);}return value;},error=>{if(b.get(key)===state)b.delete(key);throw error;});state.pending=promise;return promise;},
 invalidate(tenant,key){tenants.get(tenant)?.delete(key);},
 clearTenant(tenant){const b=tenants.get(tenant);if(b)b.clear();}
 };
}\n`,
};

export const mediumTasks = [
  {
    id: "config-precedence",
    suite: "medium",
    prompt:
      "Complete the configuration migration described in README.md. Fix precedence, parsing/validation, legacy alias behavior, and client integration across the source modules. Keep the documented exports and return types. Run the visible tests and add regression coverage. Edit the project files.",
    files: {
      "README.md": `# Configuration migration\nPublic APIs: loadConfig({file,env,args}), parseArgs(args), readEnv(env), createClient(input).\nPrecedence per field: flags > environment > file > defaults. timeoutMs beats legacy timeout within the SAME source. A flag legacy alias still beats a newer file option. Undefined means absent; zero is valid. Defaults: timeoutMs=1000, retries=2.\nEnvironment: APP_TIMEOUT_MS and APP_RETRIES. CLI: --timeout-ms=N, --timeout=N, --retries=N; unknown or malformed flags throw TypeError. The parser accepts string values from env/flags and numeric file values.\nResolved fields must be integers: timeoutMs 0..60000 and retries 0..5. Empty strings, booleans and nonnumeric values throw TypeError. Out-of-range integers throw RangeError. Validate selected values after precedence; overridden values need not validate. Do not mutate inputs.\ncreateClient(input).requestOptions() must return {timeout: resolved timeoutMs, maxAttempts: retries+1}.\nRun: node --test test/*.test.mjs\n`,
      ...configReference,
      "src/config.mjs": `import {readEnv} from './env.mjs';import {parseArgs} from './flags.mjs';
export function loadConfig({file={},env={},args=[]}={}) {
 const c={timeoutMs:1000,retries:2,...parseArgs(args),...readEnv(env),...file};
 return {timeoutMs:Number(c.timeoutMs||c.timeout||1000),retries:Number(c.retries||2)};
}\n`,
      "src/parse.mjs": `export const integer=(value)=>parseInt(value,10);\n`,
      "src/client.mjs": `import {loadConfig} from './config.mjs';
export function createClient(input={}){const c=loadConfig(input);return {requestOptions(){return {timeout:c.timeout,maxAttempts:c.retries};}};}\n`,
      "src/index.mjs": `export {loadConfig} from './config.mjs';export {readEnv} from './env.mjs';export {parseArgs} from './flags.mjs';export {createClient} from './client.mjs';\n`,
      "docs/legacy.md":
        "Archived v1: timeout was expressed in seconds. This document is obsolete.\n",
      "test/smoke.test.mjs": `import{test}from'node:test';import assert from'node:assert/strict';import{loadConfig}from'../src/index.mjs';test('defaults',()=>assert.deepEqual(loadConfig(),{timeoutMs:1000,retries:2}));\n`,
    },
    refs: [
      "README.md",
      "src/config.mjs",
      "src/parse.mjs",
      "src/env.mjs",
      "src/flags.mjs",
      "src/client.mjs",
    ],
    mockFiles: configReference,
    async check(dir) {
      const { loadConfig, parseArgs, readEnv, createClient } = await load(dir, "src/index.mjs");
      assert.deepEqual(loadConfig(), { timeoutMs: 1000, retries: 2 });
      for (const [input, want] of [
        [{ file: { timeout: 400, retries: 4 } }, { timeoutMs: 400, retries: 4 }],
        [{ file: { timeout: 400, timeoutMs: 0, retries: 0 } }, { timeoutMs: 0, retries: 0 }],
        [
          { file: { timeoutMs: 200, retries: 3 }, env: { APP_TIMEOUT_MS: "0", APP_RETRIES: "0" } },
          { timeoutMs: 0, retries: 0 },
        ],
        [
          {
            file: { timeoutMs: 200 },
            env: { APP_TIMEOUT_MS: "300" },
            args: ["--timeout=40", "--retries=5"],
          },
          { timeoutMs: 40, retries: 5 },
        ],
        [{ args: ["--timeout=40", "--timeout-ms=0", "--retries=0"] }, { timeoutMs: 0, retries: 0 }],
        [
          { file: { timeoutMs: "invalid" }, args: ["--timeout-ms=25"] },
          { timeoutMs: 25, retries: 2 },
        ],
      ])
        assert.deepEqual(loadConfig(input), want, "configuration precedence");
      for (const value of ["", true, "1x", "1.2", {}, []])
        assert.throws(
          () => loadConfig({ file: { timeoutMs: value } }),
          TypeError,
          "invalid number",
        );
      for (const value of [-1, 60001])
        assert.throws(() => loadConfig({ file: { timeoutMs: value } }), RangeError);
      for (const value of [-1, 6])
        assert.throws(() => loadConfig({ file: { retries: value } }), RangeError);
      assert.throws(() => parseArgs(["--unknown=1"]), TypeError);
      assert.throws(() => parseArgs(["--timeout-ms"]), TypeError);
      assert.deepEqual(readEnv({ APP_TIMEOUT_MS: "0" }), { timeoutMs: "0" });
      const input = { file: { timeout: 20 }, env: { APP_RETRIES: "0" }, args: ["--timeout-ms=0"] };
      const before = JSON.stringify(input);
      createClient(input);
      assert.equal(JSON.stringify(input), before);
      assert.deepEqual(createClient(input).requestOptions(), { timeout: 0, maxAttempts: 1 });
    },
  },
  {
    id: "async-queue",
    suite: "medium",
    prompt:
      "Repair the asynchronous work queue to match README.md. Preserve the createQueue public API. Handle bounded concurrency, FIFO starts, task failures, queued and running cancellation, draining close, and onIdle. Add regression tests and run them. Edit the implementation files.",
    files: {
      "README.md": `# Async work queue\ncreateQueue({concurrency=2}) returns enqueue(fn,{signal}), onIdle(), close(). Concurrency must be a positive integer or construction throws RangeError.\nenqueue returns a promise for the result of fn(signal). Start tasks FIFO, at most concurrency active functions. Rejected jobs must release their slot and not poison other jobs.\nAn already-aborted or queued-aborted job rejects with error.name=AbortError and must never start. A running abort rejects its caller promptly and passes the signal to fn. Its concurrency slot stays occupied until fn actually settles. Remove abort listeners after cleanup.\nonIdle resolves only when there are no queued OR running jobs. close rejects future enqueues with an Error but drains all accepted jobs; its promise resolves on idle. No unhandled rejection should be generated internally.\nRun: node --test test/*.test.mjs\n`,
      "src/errors.mjs": `export function abortError(){const e=new Error('aborted');e.name='AbortError';return e;}\n`,
      "src/deferred.mjs": `export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}\n`,
      "src/queue.mjs": `import {abortError} from './errors.mjs';
export function createQueue({concurrency=2}={}){let closed=false;const jobs=[];return {
 enqueue(fn,{signal}={}){if(closed)return Promise.reject(Error('closed'));if(signal?.aborted)return Promise.reject(abortError());const p=Promise.resolve().then(()=>fn(signal));jobs.push(p);return p;},
 onIdle(){return Promise.all(jobs);},close(){closed=true;return this.onIdle();}
};}\n`,
      "src/index.mjs": `export {createQueue} from './queue.mjs';\n`,
      "examples/usage.mjs": `import {createQueue} from '../src/index.mjs';const q=createQueue({concurrency:2});console.log(await q.enqueue(async()=>42));await q.close();\n`,
      "docs/history.md":
        "Old prototype used Promise.all for an unbounded collection. The current queue contract is README.md.\n",
      "test/smoke.test.mjs": `import{test}from'node:test';import assert from'node:assert/strict';import{createQueue}from'../src/index.mjs';test('one task',async()=>{const q=createQueue();assert.equal(await q.enqueue(async()=>7),7);await q.close();});\n`,
    },
    refs: ["README.md", "src/queue.mjs", "src/errors.mjs", "src/deferred.mjs"],
    mockFiles: queueReference,
    async check(dir) {
      const { createQueue } = await load(dir, "src/index.mjs");
      for (const concurrency of [0, -1, 1.5])
        assert.throws(() => createQueue({ concurrency }), RangeError);
      const q = createQueue({ concurrency: 2 }),
        gates = [gate(), gate(), gate()],
        started = [];
      const jobs = gates.map((g, i) =>
        q.enqueue(async () => {
          started.push(i);
          return g.promise;
        }),
      );
      jobs.forEach((p) => p.catch(() => {}));
      await tick();
      assert.deepEqual(started, [0, 1], "concurrency bound");
      let idle = false;
      q.onIdle().then(() => (idle = true));
      await tick();
      assert.equal(idle, false);
      gates[0].resolve("a");
      assert.equal(await jobs[0], "a");
      await tick();
      assert.deepEqual(started, [0, 1, 2], "FIFO starts");
      gates[1].reject(Error("work"));
      gates[2].resolve("c");
      await Promise.allSettled(jobs);
      await q.onIdle();
      assert.equal(idle, true);
      const serial = createQueue({ concurrency: 1 }),
        running = gate(),
        c = new AbortController();
      const first = serial.enqueue(() => running.promise),
        second = serial.enqueue(
          () => {
            throw Error("aborted job started");
          },
          { signal: c.signal },
        );
      second.catch(() => {});
      c.abort();
      await assert.rejects(second, (e) => e.name === "AbortError");
      running.resolve(1);
      await first;
      await serial.onIdle();
      const active = createQueue({ concurrency: 1 }),
        work = gate(),
        controller = new AbortController();
      let sawSignal,
        afterStarted = false;
      const a = active.enqueue(
        (signal) => {
          sawSignal = signal;
          return work.promise;
        },
        { signal: controller.signal },
      );
      a.catch(() => {});
      await tick();
      controller.abort();
      await assert.rejects(a, (e) => e.name === "AbortError");
      const b = active.enqueue(() => {
        afterStarted = true;
        return 2;
      });
      await tick();
      assert.equal(sawSignal, controller.signal);
      assert.equal(afterStarted, false, "running cancel retains slot");
      work.resolve(1);
      assert.equal(await b, 2);
      await active.close();
      await assert.rejects(active.enqueue(() => 3));
      const drain = createQueue({ concurrency: 1 }),
        hold = gate();
      const x = drain.enqueue(() => hold.promise),
        y = drain.enqueue(() => 2);
      let closed = false;
      const closing = drain.close().then(() => (closed = true));
      await tick();
      assert.equal(closed, false);
      hold.resolve(1);
      assert.deepEqual(await Promise.all([x, y]), [1, 2]);
      await closing;
    },
  },
  {
    id: "tenant-cache",
    suite: "medium",
    prompt:
      "Fix the tenant cache and its catalog integration according to README.md. Implement collision-free isolation, exact TTL expiry, single-flight loads, rejection cleanup and safe invalidation while a load is running. Preserve the public APIs, add regression tests, and run them. Edit the project files.",
    files: {
      "README.md": `# Tenant cache\ncreateCache({ttlMs=100,now=Date.now}) returns get(tenant,key,loader), invalidate(tenant,key), clearTenant(tenant). get always returns a promise. Tenant/key strings may contain colons.\nConcurrent gets for the same tenant and key run loader once and share its result. Distinct keys/tenants do not share. Rejected loads are not cached and a later get retries.\nTTL begins on successful load completion, and expiry is exact: now() >= expires means expired. ttlMs=0 allows in-flight deduplication but no retained value.\nInvalidating a key or clearing a tenant during a load does not cancel existing callers: they still get that old result. The old result MUST NOT be cached, remove a newer pending load, or overwrite a newer result. clearTenant affects only that tenant.\ncreateCatalog(cache).getProduct(tenant,id,loader) delegates to cache.get, and invalidateProduct delegates to cache.invalidate.\nRun: node --test test/*.test.mjs\n`,
      "src/cache.mjs": `export function createCache({ttlMs=100,now=Date.now}={}){const values=new Map();return {
 async get(tenant,key,loader){const k=tenant+':'+key,hit=values.get(k);if(hit&&hit.expires>=now())return hit.value;const value=await loader();values.set(k,{value,expires:now()+ttlMs});return value;},
 invalidate(tenant,key){values.delete(tenant+':'+key);},clearTenant(tenant){for(const k of values.keys())if(k.startsWith(tenant+':'))values.delete(k);}
};}\n`,
      "src/catalog.mjs": `export function createCatalog(cache){return {getProduct:(tenant,id,loader)=>cache.get('default',id,loader),invalidateProduct:(tenant,id)=>cache.invalidate('default',id)};}\n`,
      "src/index.mjs": `export {createCache} from './cache.mjs';export {createCatalog} from './catalog.mjs';\n`,
      "docs/ttl.md":
        "The injected clock returns milliseconds and is shared with callers; no real timers are needed.\n",
      "examples/usage.mjs": `import {createCache,createCatalog} from '../src/index.mjs';const c=createCatalog(createCache());console.log(await c.getProduct('team-a','p1',async()=>({name:'sample'})));\n`,
      "test/smoke.test.mjs": `import{test}from'node:test';import assert from'node:assert/strict';import{createCache}from'../src/index.mjs';test('one value',async()=>{const c=createCache();assert.equal(await c.get('a','b',async()=>4),4);});\n`,
    },
    refs: ["README.md", "src/cache.mjs", "src/catalog.mjs", "docs/ttl.md"],
    mockFiles: {
      ...cacheReference,
      "src/catalog.mjs": `export function createCatalog(cache){return {getProduct:(tenant,id,loader)=>cache.get(tenant,id,loader),invalidateProduct:(tenant,id)=>cache.invalidate(tenant,id)};}\n`,
    },
    async check(dir) {
      const { createCache, createCatalog } = await load(dir, "src/index.mjs");
      let now = 0;
      const c = createCache({ ttlMs: 10, now: () => now });
      let loads = 0;
      const g = gate(),
        p = c.get("a", "x", () => {
          loads++;
          return g.promise;
        }),
        p2 = c.get("a", "x", () => {
          loads++;
          return 9;
        });
      await tick();
      assert.equal(loads, 1, "single-flight");
      g.resolve(3);
      assert.deepEqual(await Promise.all([p, p2]), [3, 3]);
      now = 9;
      assert.equal(await c.get("a", "x", () => 4), 3);
      now = 10;
      assert.equal(await c.get("a", "x", () => 4), 4, "expiry boundary");
      assert.equal(await c.get("a:b", "c", () => 11), 11);
      assert.equal(await c.get("a", "b:c", () => 12), 12, "tenant/key collision");
      c.clearTenant("a");
      assert.equal(await c.get("a:b", "c", () => 99), 11);
      const race = createCache(),
        old = gate(),
        fresh = gate();
      const before = race.get("t", "k", () => old.promise);
      await tick();
      race.invalidate("t", "k");
      const after = race.get("t", "k", () => fresh.promise);
      await tick();
      fresh.resolve(2);
      assert.equal(await after, 2);
      old.resolve(1);
      assert.equal(await before, 1);
      assert.equal(await race.get("t", "k", () => 3), 2, "stale load overwrote fresh result");
      const reject = createCache();
      await assert.rejects(reject.get("t", "k", () => Promise.reject(Error("no"))));
      assert.equal(await reject.get("t", "k", () => 7), 7);
      const clear = createCache(),
        pending = gate();
      const earlier = clear.get("t", "k", () => pending.promise);
      await tick();
      clear.clearTenant("t");
      pending.resolve(1);
      await earlier;
      assert.equal(await clear.get("t", "k", () => 2), 2, "clear during load");
      let clock = 0;
      const delayed = createCache({ ttlMs: 10, now: () => clock }),
        slow = gate();
      const loading = delayed.get("t", "k", () => slow.promise);
      await tick();
      clock = 100;
      slow.resolve(1);
      await loading;
      clock = 109;
      assert.equal(await delayed.get("t", "k", () => 2), 1, "TTL starts at completion");
      clock = 110;
      assert.equal(await delayed.get("t", "k", () => 2), 2);
      const swap = createCache(),
        left = gate(),
        right = gate();
      const lp = swap.get("t", "k", () => left.promise);
      await tick();
      swap.invalidate("t", "k");
      const rp = swap.get("t", "k", () => right.promise);
      await tick();
      left.resolve(1);
      await lp;
      let duplicate = false;
      const shared = swap.get("t", "k", () => {
        duplicate = true;
        return 3;
      });
      await tick();
      assert.equal(duplicate, false, "old completion removed new flight");
      right.resolve(2);
      assert.deepEqual(await Promise.all([rp, shared]), [2, 2]);
      const zero = createCache({ ttlMs: 0 });
      assert.equal(await zero.get("a", "k", () => 1), 1);
      assert.equal(await zero.get("a", "k", () => 2), 2);
      const catalog = createCatalog(createCache());
      assert.equal(await catalog.getProduct("a", "p", () => 1), 1);
      assert.equal(await catalog.getProduct("b", "p", () => 2), 2);
      catalog.invalidateProduct("a", "p");
      assert.equal(await catalog.getProduct("a", "p", () => 3), 3);
    },
  },
];
