import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node';
import { Agent } from '../src/acp/agent.ts';
import {
  CopilotAccountObserver,
  createCopilotReadOnlyTransport,
  type CopilotAccountOptions,
  type CopilotTransportOptions,
} from '../src/auth/copilot.ts';

function fake(t: TestContext, response: unknown, extra: Partial<CopilotAccountOptions> = {}) {
  const calls: string[] = [];
  let opened = 0,
    closed = 0;
  const observer = new CopilotAccountObserver({
    ...extra,
    createTransport: (options) => {
      opened++;
      return {
        request: async (method) => {
          calls.push(method);
          if (method === 'connect') return { ok: true, protocolVersion: 3 };
          if (typeof response === 'function') return response(method, options);
          return response;
        },
        close: async () => {
          closed++;
        },
      };
    },
  });
  t.after(() => observer.close());
  return { observer, calls, opened: () => opened, closed: () => closed };
}
async function until(check: () => unknown): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Mock Copilot check timed out');
    await sleep(5);
  }
}
function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'copilot-account-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('official auth boolean is authoritative and non-secret fields are not returned', async (t) => {
  for (const signedIn of [true, false]) {
    const h = fake(t, {
      isAuthenticated: signedIn,
      login: 'someone',
      token: 'private-test-token',
      statusMessage: 'private-vendor-output',
    });
    const result = await h.observer.check();
    assert.equal(result.signedIn, signedIn);
    assert.equal(result.source, 'sdk');
    assert.deepEqual(h.calls, ['connect', 'auth.getStatus']);
    assert.equal(h.closed(), 1);
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.ok(!JSON.stringify(result).includes('someone'));
  }
});

test('missing or malformed auth and auth errors are unknown, never inferred from quota or error text', async (t) => {
  for (const response of [null, [], {}, { isAuthenticated: 'true' }, { quotaSnapshots: {} }, { authenticated: true }]) {
    const h = fake(t, response);
    const result = await h.observer.check();
    assert.equal(result.signedIn, null);
    assert.equal(result.reason, 'invalid-response');
  }
  const unavailable = fake(t, () => {
    throw new Error('not authenticated private-output');
  });
  assert.equal((await unavailable.observer.check()).reason, 'unavailable');
  const unsupported = fake(t, () => {
    throw new ResponseError(ErrorCodes.MethodNotFound, 'private-output');
  });
  assert.equal((await unsupported.observer.check()).reason, 'unsupported');
});

test('cache and singleflight coalesce observations and return defensive snapshots', async (t) => {
  let now = 1000;
  const h = fake(t, { isAuthenticated: true }, { now: () => now, cacheMs: 100 });
  const snapshots = await Promise.all(Array.from({ length: 20 }, () => h.observer.check()));
  assert.equal(h.opened(), 1);
  assert.equal(h.closed(), 1);
  snapshots[0]!.signedIn = false;
  assert.equal((await h.observer.check()).signedIn, true);
  now += 101;
  await h.observer.check();
  assert.equal(h.opened(), 2);
  await h.observer.invalidate();
  await h.observer.check();
  assert.equal(h.opened(), 3);
});

test('active native work/sign-in is gated without spawning; valid cached observations need no new process', async (t) => {
  let allowed = false,
    now = 1000;
  const h = fake(t, { isAuthenticated: false }, { canCheck: () => allowed, now: () => now, cacheMs: 100 });
  assert.equal((await h.observer.check()).reason, 'busy');
  assert.equal(h.opened(), 0);
  allowed = true;
  assert.equal((await h.observer.check()).signedIn, false);
  allowed = false;
  assert.equal((await h.observer.check()).signedIn, false);
  assert.equal(h.opened(), 1);
  now += 101;
  assert.equal((await h.observer.check()).reason, 'busy');
  assert.equal(h.opened(), 1);
});

test('timeout aborts and closes a hanging request; invalidation cannot overlap the next native probe', async (t) => {
  let signal: AbortSignal | undefined;
  const hanging = fake(
    t,
    (_method: string, options: CopilotTransportOptions) => {
      signal = options.signal;
      return new Promise(() => {});
    },
    { timeoutMs: 25 },
  );
  const result = await hanging.observer.check();
  assert.equal(result.signedIn, null);
  assert.equal(result.reason, 'timeout');
  assert.equal(signal?.aborted, true);
  assert.equal(hanging.closed(), 1);
  let opened = 0,
    alive = 0,
    maxAlive = 0;
  const observer = new CopilotAccountObserver({
    createTransport: () => {
      opened++;
      alive++;
      maxAlive = Math.max(maxAlive, alive);
      return {
        request: async (method) =>
          method === 'connect'
            ? { protocolVersion: 3 }
            : opened === 1
              ? new Promise(() => {})
              : { isAuthenticated: true },
        close: async () => {
          await sleep(15);
          alive--;
        },
      };
    },
  });
  t.after(() => observer.close());
  const first = observer.check();
  await until(() => opened === 1);
  const invalidating = observer.invalidate();
  const next = observer.check();
  assert.equal((await first).reason, 'busy');
  await invalidating;
  assert.equal((await next).signedIn, true);
  assert.equal(maxAlive, 1);
  await observer.close();
  assert.equal((await observer.check()).reason, 'closed');
});

test('connect method-not-found alone permits the SDK legacy ping fallback; unsupported protocols stop before auth', async (t) => {
  for (const protocol of [undefined, 2, 4]) {
    const calls: string[] = [];
    const observer = new CopilotAccountObserver({
      createTransport: () => ({
        request: async (method) => {
          calls.push(method);
          return { protocolVersion: protocol, isAuthenticated: true };
        },
        close: async () => {},
      }),
    });
    t.after(() => observer.close());
    assert.equal((await observer.check()).reason, 'unsupported');
    assert.deepEqual(calls, ['connect']);
  }
  const calls: string[] = [];
  const legacy = new CopilotAccountObserver({
    createTransport: () => ({
      request: async (method) => {
        calls.push(method);
        if (method === 'connect') throw new ResponseError(ErrorCodes.MethodNotFound, 'no connect');
        return method === 'ping' ? { protocolVersion: 3 } : { isAuthenticated: false };
      },
      close: async () => {},
    }),
  });
  t.after(() => legacy.close());
  assert.equal((await legacy.check()).signedIn, false);
  assert.deepEqual(calls, ['connect', 'ping', 'auth.getStatus']);
});

function nativeFixture(t: TestContext, mode: 'normal' | 'hang' | 'overflow' = 'normal') {
  const root = directory(t),
    file = join(root, 'fake-copilot.mjs'),
    log = join(root, 'requests.jsonl');
  const rpcModule = pathToFileURL(join(import.meta.dirname, '../node_modules/vscode-jsonrpc/lib/node/main.js')).href;
  writeFileSync(
    file,
    `
    import {createMessageConnection} from ${JSON.stringify(rpcModule)};
    import {appendFileSync} from 'node:fs';
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),pid:process.pid})+'\\n');
    console.error('private-stderr-must-not-escape');
    const c=createMessageConnection(process.stdin,process.stdout);
    c.onRequest((method,params)=>{
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({method,params})+'\\n');
      if(method==='connect')return {ok:true,protocolVersion:3};
      if(method==='auth.getStatus'){
        ${mode === 'hang' ? 'return new Promise(()=>{});' : mode === 'overflow' ? "process.stdout.write('x'.repeat(300000));return new Promise(()=>{});" : "return {isAuthenticated:false,token:'private-token',statusMessage:'private-message'};"}
      }
      throw Error('unexpected method');
    });c.listen();
  `,
  );
  return {
    root,
    log,
    command: [process.execPath, file],
    records: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}

test('native SDK transport uses the existing CLI flags and only framed handshake/auth requests', async (t) => {
  const h = nativeFixture(t);
  const observer = new CopilotAccountObserver({ command: h.command, cwd: h.root });
  t.after(() => observer.close());
  const result = await observer.check();
  assert.equal(result.signedIn, false);
  const records = h.records();
  assert.deepEqual(records[0].args, ['--headless', '--no-auto-update', '--stdio']);
  assert.deepEqual(records.slice(1), [
    { method: 'connect', params: {} },
    { method: 'auth.getStatus', params: {} },
  ]);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.throws(() => process.kill(records[0].pid, 0), /ESRCH/);
});

test('native transport timeout/oversized output is bounded and kills only its observer process', async (t) => {
  for (const mode of ['hang', 'overflow'] as const) {
    const h = nativeFixture(t, mode),
      observer = new CopilotAccountObserver({ command: h.command, timeoutMs: 300 });
    t.after(() => observer.close());
    const result = await observer.check();
    assert.equal(result.signedIn, null);
    assert.equal(result.reason, mode === 'hang' ? 'timeout' : 'invalid-response');
    assert.throws(() => process.kill(h.records()[0].pid, 0), /ESRCH/);
  }
});

test('runtime method allowlist refuses session and credential requests before writing them', async (t) => {
  const h = nativeFixture(t),
    controller = new AbortController();
  const transport = createCopilotReadOnlyTransport({ command: h.command, signal: controller.signal });
  t.after(() => transport.close());
  await transport.request('connect', {});
  await assert.rejects(transport.request('session.create' as 'connect', {}), /unsupported/);
  await assert.rejects(transport.request('account.getCurrentAuth' as 'connect', {}), /unsupported/);
  await transport.close();
  assert.deepEqual(
    h
      .records()
      .slice(1)
      .map((value) => value.method),
    ['connect'],
  );
});

test('native-start lifecycle joins an observer before spawn, releases on initialize failure and cancels pending shutdown starts', async (t) => {
  const root = directory(t);
  let nativeStarting = 0,
    probeOpen = false,
    agent: Agent | undefined;
  const observer = new CopilotAccountObserver({
    canCheck: () => !nativeStarting && !agent?.running,
    createTransport: () => {
      probeOpen = true;
      return {
        request: async (method) => (method === 'connect' ? { protocolVersion: 3 } : new Promise(() => {})),
        close: async () => {
          await sleep(15);
          probeOpen = false;
        },
      };
    },
  });
  t.after(() => observer.close());
  agent = new Agent(
    { name: 'copilot', acp: [process.execPath, join(import.meta.dirname, 'mock-agent.ts')] },
    {},
    root,
    {
      notification() {},
      request: async () => ({}),
      exited() {},
      beforeStart: async () => {
        nativeStarting++;
        await observer.invalidate();
        assert.equal(probeOpen, false);
        return () => {
          nativeStarting--;
        };
      },
    },
  );
  t.after(() => agent!.stopAndWait());
  const checking = observer.check();
  await until(() => probeOpen);
  await agent.ensure();
  assert.equal((await checking).reason, 'busy');
  assert.equal(nativeStarting, 0);
  assert.equal((await observer.check()).reason, 'busy');
  await agent.stopAndWait();
  let releases = 0;
  const failed = new Agent(
    {
      name: 'failed',
      acp: [
        process.execPath,
        '-e',
        `process.stdin.on('data',b=>{const m=JSON.parse(b.toString());console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'fake initialization failure'}}))})`,
      ],
    },
    {},
    root,
    {
      notification() {},
      request: async () => ({}),
      exited() {},
      beforeStart: async () => () => {
        releases++;
      },
    },
  );
  t.after(() => failed.stopAndWait());
  await assert.rejects(failed.ensure());
  assert.equal(releases, 1);
  await failed.stopAndWait();
  let unlock!: (release: () => void) => void;
  const stopped = new Agent({ name: 'stopped', acp: ['/never-start-this'] }, {}, root, {
    notification() {},
    request: async () => ({}),
    exited() {},
    beforeStart: () =>
      new Promise((resolve) => {
        unlock = resolve;
      }),
  });
  const starting = stopped.ensure();
  await stopped.stopAndWait();
  unlock(() => {
    releases++;
  });
  await assert.rejects(starting, /interrupted/);
  assert.equal(stopped.running, false);
  assert.equal(releases, 2);
});
