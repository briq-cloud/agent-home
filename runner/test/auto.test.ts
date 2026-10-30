import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoConn } from '../src/acp/auto.ts';
import type { AutoOptions } from '../src/acp/auto.ts';
import type { Rpc } from '../src/acp/agent.ts';
import type { Peer } from '../src/acp/hub.ts';
import type { EngineSubmission, PendingPermission } from '../src/orchestration/engine.ts';
import { TaskStore } from '../src/tasks/index.ts';
import type { Task } from '../src/tasks/index.ts';
import { ContextStore } from '../src/context/store.ts';

async function fixture(t: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), 'auto-acp-'));
  const tasks = new TaskStore(':memory:'),
    context = new ContextStore();
  const submissions: EngineSubmission[] = [],
    cancelled: string[] = [],
    detached: Peer[] = [];
  const listeners = new Map<string, Set<(rpc: Rpc) => void>>();
  const waiting = new Map<string, ((task: Task) => void)[]>();
  let pending: PendingPermission[] = [];
  const answers: unknown[] = [],
    loads: { cli: string; params: unknown }[] = [];
  let rejectLoad = false,
    replayAskRejected = false;
  const emit = (id: string, rpc: Rpc) => {
    for (const cb of listeners.get(id) ?? []) cb(rpc);
  };
  const settle = (task: Task) => {
    emit(task.id, { jsonrpc: '2.0', method: '_runner/task', params: task });
    for (const resolve of waiting.get(task.id) ?? []) resolve(task);
    waiting.delete(task.id);
  };
  const engine: AutoOptions['engine'] = {
    submit(input) {
      submissions.push(input);
      const ref = context.putArtifact({ project: input.projectId, content: input.prompt });
      return tasks.createTask({ id: input.id, projectId: input.projectId, promptRef: ref.id, route: input.route });
    },
    subscribe(id, cb) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    },
    wait(id) {
      const task = tasks.getTask(id)!;
      if (!['queued', 'running'].includes(task.status)) return Promise.resolve(task);
      return new Promise((resolve) => {
        const waits = waiting.get(id) ?? [];
        waits.push(resolve);
        waiting.set(id, waits);
      });
    },
    cancel(id) {
      cancelled.push(id);
      const task = tasks.cancel(id);
      if (task) settle(task);
      return task;
    },
    pendingPermissions(projectId, taskId) {
      return pending.filter((p) => p.projectId === projectId && (!taskId || p.taskId === taskId));
    },
    answerPermission(projectId, taskId, requestId, optionId) {
      const found = pending.find((p) => p.projectId === projectId && p.taskId === taskId && p.requestId === requestId);
      if (!found || optionId !== 'allow-once') return false;
      answers.push({ projectId, taskId, requestId, optionId });
      pending = pending.filter((p) => p !== found);
      return true;
    },
  };
  const hub: AutoOptions['hub'] = {
    async loadSession(cli, params, peer) {
      loads.push({ cli, params });
      peer.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'real-backend',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'historical answer' },
          },
        },
      });
      await peer.ask('session/request_permission', { sessionId: 'real-backend' }).catch(() => {
        replayAskRejected = true;
      });
      if (rejectLoad) throw new Error('replay failed');
      return {};
    },
    detach(peer) {
      detached.push(peer);
    },
  };
  const options: AutoOptions = { stateDir, tasks, context, engine, hub, defaultProject: 'home' };
  const connections: ReturnType<typeof connect>[] = [];
  const open = () => {
    const c = connect(new AutoConn(options));
    connections.push(c);
    return c;
  };
  t.after(async () => {
    for (const c of connections) await c.close();
    tasks.close();
    context.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const start = (id: string, project = 'home') => {
    const task = tasks.claimNext({ workerId: 'mock', taskId: id, leaseMs: 60000 })!;
    const ref = context.putArtifact({
      project,
      content: JSON.stringify({
        cli: 'claude',
        id: 'real-backend',
        cwd: '/registered/project',
        route: { cli: 'claude', model: 'actual-model', source: 'subscription' },
      }),
    });
    return tasks.heartbeat(task.id, task.leaseToken, 60000, { sessionRef: ref.id })!;
  };
  const finish = (id: string) => {
    let task = tasks.getTask(id)!;
    if (task.status === 'queued') task = start(id, task.projectId);
    const ref = context.putArtifact({
      project: task.projectId,
      content: JSON.stringify({ text: 'answer', stopReason: 'end_turn' }),
    });
    const done = tasks.complete(id, task.leaseToken, { outputRef: ref.id })!;
    settle(done);
    return done;
  };
  return {
    stateDir,
    tasks,
    context,
    options,
    open,
    submissions,
    cancelled,
    detached,
    answers,
    loads,
    emit,
    start,
    finish,
    listeners: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    replayAskRejected: () => replayAskRejected,
    rejectLoad: () => {
      rejectLoad = true;
    },
    permission(id: string) {
      const p: PendingPermission = {
        projectId: tasks.getTask(id)!.projectId,
        taskId: id,
        requestId: 'engine-permission',
        method: 'session/request_permission',
        params: {
          sessionId: 'real-backend',
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
        },
        createdAt: Date.now(),
      };
      pending.push(p);
      emit(id, { jsonrpc: '2.0', id: p.requestId, method: p.method, params: p.params });
      return p;
    },
  };
}
function connect(connection: AutoConn) {
  let controller: ReadableStreamDefaultController<unknown>;
  const messages: Rpc[] = [];
  let next = 1,
    closed = false;
  const watchers = new Set<() => void>();
  const readable = new ReadableStream<unknown>({
    start(c) {
      controller = c;
    },
  });
  const writable = new WritableStream<unknown>({
    write(value) {
      messages.push(value as Rpc);
      for (const watcher of watchers) watcher();
    },
  });
  const run = connection.run({ readable, writable });
  const wait = (predicate: (rpc: Rpc) => boolean): Promise<Rpc> => {
    const seen = messages.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const check = () => {
        const item = messages.find(predicate);
        if (item) {
          clearTimeout(timer);
          watchers.delete(check);
          resolve(item);
        }
      };
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(Error('mock stream response timeout'));
      }, 1000);
      watchers.add(check);
      check();
    });
  };
  return {
    messages,
    wait,
    send(value: Rpc) {
      controller!.enqueue(value);
    },
    request(method: string, params: unknown = {}) {
      const id = next++;
      controller!.enqueue({ jsonrpc: '2.0', id, method, params });
      return wait((rpc) => rpc.id === id);
    },
    async close() {
      if (!closed) {
        closed = true;
        controller!.close();
        await run;
      }
    },
  };
}
function result(rpc: Rpc): Record<string, any> {
  assert.equal(rpc.error, undefined);
  return rpc.result as Record<string, any>;
}
async function session(c: ReturnType<typeof connect>, meta?: unknown): Promise<string> {
  return result(
    await c.request('session/new', { cwd: '/untrusted/client/path', mcpServers: [], _meta: { agentHome: meta } }),
  ).sessionId as string;
}
const prompt = (id: string, text = 'Implement this') => ({ sessionId: id, prompt: [{ type: 'text', text }] });

test('new and reloaded sessions expose persisted billing consent to clients', async (t) => {
  const h = await fixture(t);
  for (const allowPaidApi of [false, true]) {
    const first = h.open();
    const created = result(await first.request('session/new', { _meta: { agentHome: { allowPaidApi } } }));
    assert.equal(created._meta.agentHome.allowPaidApi, allowPaidApi);
    await first.close();
    const loaded = result(await h.open().request('session/load', { sessionId: created.sessionId }));
    assert.equal(loaded._meta.agentHome.allowPaidApi, allowPaidApi);
    assert.equal(h.submissions.length, 0);
  }
});

test('Auto initialize/new are text-only and defer execution; private state ignores client cwd', async (t) => {
  const h = await fixture(t),
    c = h.open();
  const init = result(await c.request('initialize'));
  assert.equal(init.agentInfo.name, 'agent-home-auto');
  assert.equal(init.agentCapabilities.loadSession, true);
  assert.equal(init.agentCapabilities.promptCapabilities.image, false);
  const id = await session(c, {
    projectId: 'repo',
    allowPaidApi: true,
    maxEstimatedUsd: 0.25,
    decisionBudgetUsd: 0.01,
    context: { revision: 'abc', paths: ['src/a.ts'], memoryQuery: 'project facts' },
  });
  assert.equal(h.submissions.length, 0);
  const path = join(h.stateDir, 'auto', `${id}.json`),
    persisted = await readFile(path, 'utf8');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok(!persisted.includes('untrusted/client/path'));
  const taskReply = c.request('session/prompt', prompt(id));
  await c.wait((m) => m.method === '_runner/task');
  const input = h.submissions[0]!;
  assert.equal(input.projectId, 'repo');
  assert.equal(input.route.mode, 'auto');
  assert.equal(input.session, undefined);
  assert.equal(input.allowPaidApi, true);
  assert.equal(input.maxEstimatedUsd, 0.25);
  assert.equal(input.context?.revision, 'abc');
  h.finish(input.id!);
  assert.equal(result(await taskReply).stopReason, 'end_turn');
});
test('live chunks and permission requests remap virtual IDs and answers reach the engine', async (t) => {
  const h = await fixture(t),
    c = h.open(),
    id = await session(c);
  const reply = c.request('session/prompt', prompt(id));
  await c.wait((m) => m.method === '_runner/task');
  const task = h.submissions[0]!;
  h.start(task.id!);
  h.emit(task.id!, {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'real-backend',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' } },
    },
  });
  const update = await c.wait((m) => m.method === 'session/update');
  assert.equal(update.params.sessionId, id);
  h.permission(task.id!);
  const ask = await c.wait((m) => m.method === 'session/request_permission');
  assert.equal(ask.params.sessionId, id);
  assert.notEqual(ask.id, 'engine-permission');
  c.send({ jsonrpc: '2.0', id: ask.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.answers, [
    { projectId: 'home', taskId: task.id, requestId: 'engine-permission', optionId: 'allow-once' },
  ]);
  h.finish(task.id!);
  assert.equal(result(await reply).stopReason, 'end_turn');
});
test('disconnect preserves execution; reconnect replays history/pending permissions and pins the next turn', async (t) => {
  const h = await fixture(t),
    first = h.open(),
    id = await session(first);
  void first.request('session/prompt', prompt(id)).catch(() => {});
  await first.wait((m) => m.method === '_runner/task');
  const taskId = h.submissions[0]!.id!;
  h.start(taskId);
  h.permission(taskId);
  await first.close();
  assert.equal(h.cancelled.length, 0);
  assert.equal(h.listeners(), 0);
  const c = h.open();
  result(await c.request('session/load', { sessionId: id, cwd: '/escape', mcpServers: [] }));
  assert.equal(h.loads[0]?.cli, 'claude');
  assert.equal((h.loads[0]?.params as any).cwd, '/registered/project');
  assert.ok(h.replayAskRejected());
  assert.equal(h.detached.length, 1);
  const replay = await c.wait((m) => m.method === 'session/update');
  assert.equal(replay.params.sessionId, id);
  const permission = await c.wait((m) => m.method === 'session/request_permission');
  c.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.answers.length, 1);
  h.finish(taskId);
  await new Promise((resolve) => setImmediate(resolve));
  const next = c.request('session/prompt', prompt(id, 'Continue'));
  await c.wait((m) => m.method === '_runner/task' && m.params.id !== taskId);
  const input = h.submissions[1]!;
  assert.deepEqual(input.session, { cli: 'claude', id: 'real-backend', cwd: '/registered/project' });
  assert.equal(input.route.agentId, 'claude');
  assert.equal(input.route.model, 'actual-model');
  h.finish(input.id!);
  assert.equal(result(await next).stopReason, 'end_turn');
});
test('simultaneous prompt attempts from different clients admit one durable task', async (t) => {
  const h = await fixture(t),
    a = h.open(),
    b = h.open(),
    id = await session(a);
  const first = a.request('session/prompt', prompt(id));
  const second = b.request('session/prompt', prompt(id));
  assert.equal((await second).error?.code, -32000);
  assert.equal(h.submissions.length, 1);
  h.finish(h.submissions[0]!.id!);
  result(await first);
});
test('unsupported content/methods, invalid sessions and malformed opt-ins fail before submit', async (t) => {
  const h = await fixture(t),
    c = h.open(),
    id = await session(c);
  assert.equal(
    (
      await c.request('session/prompt', {
        sessionId: id,
        prompt: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
      })
    ).error?.code,
    -32602,
  );
  assert.equal((await c.request('session/set_model', { sessionId: id, modelId: 'invented' })).error?.code, -32601);
  assert.equal((await c.request('session/load', { sessionId: '../../escape' })).error?.code, -32602);
  assert.equal((await c.request('session/new', { _meta: { agentHome: { allowPaidApi: 'yes' } } })).error?.code, -32602);
  assert.equal(h.submissions.length, 0);
});
test('explicit session/cancel cancels the task, and failed task responses expose no artifact body', async (t) => {
  const h = await fixture(t),
    c = h.open(),
    id = await session(c);
  const reply = c.request('session/prompt', prompt(id));
  await c.wait((m) => m.method === '_runner/task');
  result(await c.request('session/cancel', { sessionId: id }));
  assert.equal(h.cancelled.length, 1);
  assert.equal(result(await reply).stopReason, 'cancelled');
});
test('Hub replay always detaches its temporary peer when load fails', async (t) => {
  const h = await fixture(t),
    c = h.open(),
    id = await session(c);
  const reply = c.request('session/prompt', prompt(id));
  await c.wait((m) => m.method === '_runner/task');
  h.finish(h.submissions[0]!.id!);
  result(await reply);
  h.rejectLoad();
  assert.equal((await c.request('session/load', { sessionId: id })).error?.code, -32603);
  assert.equal(h.detached.length, 1);
});
test('persisted sessions cannot read a task checkpoint from another project', async (t) => {
  const h = await fixture(t),
    c = h.open(),
    id = await session(c);
  const foreign = h.tasks.createTask({ projectId: 'foreign', promptRef: 'opaque', route: { mode: 'auto' } });
  const path = join(h.stateDir, 'auto', `${id}.json`),
    saved = JSON.parse(await readFile(path, 'utf8'));
  saved.lastTaskId = foreign.id;
  await writeFile(path, JSON.stringify(saved));
  assert.equal((await c.request('session/load', { sessionId: id })).error?.code, -32001);
  assert.equal(h.loads.length, 0);
});

test('read-only load observes a future task started by another connection', async (t) => {
  const h = await fixture(t),
    writer = h.open(),
    observer = h.open(),
    id = await session(writer);
  result(await observer.request('session/load', { sessionId: id }));
  assert.equal(h.submissions.length, 0);
  const reply = writer.request('session/prompt', prompt(id));
  await writer.wait((m) => m.method === '_runner/task');
  const taskId = h.submissions[0]!.id!;
  h.emit(taskId, {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'real-backend',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'observed later task' },
      },
    },
  });
  assert.equal((await observer.wait((m) => m.method === 'session/update')).params.sessionId, id);
  h.finish(taskId);
  result(await reply);
  const terminal = await observer.wait((m) => m.method === '_runner/task' && m.params.status === 'succeeded');
  assert.equal(terminal.params.sessionId, id);
});

test('invalid permission option never grants permission and the engine stays authoritative', async (t) => {
  const h = await fixture(t),
    c = h.open(),
    id = await session(c);
  const reply = c.request('session/prompt', prompt(id));
  await c.wait((m) => m.method === '_runner/task');
  const taskId = h.submissions[0]!.id!;
  h.permission(taskId);
  const ask = await c.wait((m) => m.method === 'session/request_permission');
  c.send({ jsonrpc: '2.0', id: ask.id, result: { outcome: { outcome: 'selected', optionId: 'invented' } } });
  await c.wait((m) => m.method === '_runner/permission_rejected');
  assert.equal(h.answers.length, 0);
  assert.equal(h.options.engine.pendingPermissions('home', taskId).length, 1);
  h.finish(taskId);
  result(await reply);
});

test('valid ACP permission cancellation conservatively stops the durable task', async (t) => {
  const h = await fixture(t),
    c = h.open(),
    id = await session(c);
  const reply = c.request('session/prompt', prompt(id));
  await c.wait((m) => m.method === '_runner/task');
  const taskId = h.submissions[0]!.id!;
  h.permission(taskId);
  const ask = await c.wait((m) => m.method === 'session/request_permission');
  c.send({ jsonrpc: '2.0', id: ask.id, result: { outcome: { outcome: 'cancelled' } } });
  assert.equal(result(await reply).stopReason, 'cancelled');
  assert.deepEqual(h.cancelled, [taskId]);
  assert.equal(h.answers.length, 0);
});

test('explicit CLI and mode selection share Engine and persist across reconnect and later prompts', async (t) => {
  const h = await fixture(t),
    first = h.open();
  const id = await session(first, { cli: 'claude', modeId: 'plan' });
  assert.equal(h.submissions.length, 0, 'explicit session creation still defers CLI execution');
  const saved = JSON.parse(await readFile(join(h.stateDir, 'auto', `${id}.json`), 'utf8'));
  assert.equal(saved.requestedCli, 'claude');
  assert.equal(saved.modeId, 'plan');
  const response = first.request('session/prompt', prompt(id));
  await first.wait((m) => m.method === '_runner/task');
  assert.deepEqual(h.submissions[0]!.route, { mode: 'explicit', agentId: 'claude' });
  assert.equal(h.submissions[0]!.modeId, 'plan');
  h.finish(h.submissions[0]!.id!);
  result(await response);
  await first.close();
  const reconnect = h.open();
  result(await reconnect.request('session/load', { sessionId: id }));
  const continued = reconnect.request('session/prompt', {
    ...prompt(id, 'Continue'),
    _meta: { agentHome: { cli: 'codex', modeId: 'bypass' } },
  });
  await reconnect.wait((m) => m.method === '_runner/task' && m.params.id !== h.submissions[0]!.id);
  const second = h.submissions[1]!;
  assert.deepEqual(second.route, { mode: 'explicit', agentId: 'claude', model: 'actual-model' });
  assert.deepEqual(second.session, { cli: 'claude', id: 'real-backend', cwd: '/registered/project' });
  assert.equal(second.modeId, 'plan', 'later route/mode overrides must not change a persisted session');
  h.finish(second.id!);
  result(await continued);
});

test('requested CLI and mode metadata must be nonempty strings', async (t) => {
  const h = await fixture(t),
    c = h.open();
  for (const selection of [{ cli: 1 }, { cli: '' }, { modeId: {} }, { modeId: 'bad\0mode' }]) {
    const response = await c.request('session/new', { _meta: { agentHome: selection } });
    assert.equal(response.error?.code, -32602);
  }
  assert.equal(h.submissions.length, 0);
});

test('acceptance metadata is validated, persisted and forwarded unchanged across reconnect and continuation', async (t) => {
  const h = await fixture(t),
    first = h.open();
  const requested = {
    commands: [{ argv: ['node', '--test'] }],
    artifacts: [{ path: 'result.txt', sha256: 'A'.repeat(64) }],
  };
  const normalized = {
    commands: [{ argv: ['node', '--test'], timeoutMs: 30_000 }],
    artifacts: [{ path: 'result.txt', sha256: 'a'.repeat(64) }],
  };
  const id = await session(first, { acceptance: requested });
  assert.equal(h.submissions.length, 0, 'session metadata never executes checks or starts a model');
  const saved = JSON.parse(await readFile(join(h.stateDir, 'auto', `${id}.json`), 'utf8'));
  assert.deepEqual(saved.acceptance, normalized);
  const response = first.request('session/prompt', prompt(id));
  await first.wait((rpc) => rpc.method === '_runner/task');
  assert.deepEqual(h.submissions[0]!.acceptance, normalized);
  h.finish(h.submissions[0]!.id!);
  result(await response);
  await first.close();
  const reconnect = h.open();
  result(await reconnect.request('session/load', { sessionId: id }));
  const continued = reconnect.request('session/prompt', {
    ...prompt(id, 'Continue'),
    _meta: { agentHome: { acceptance: { commands: [{ argv: ['unrequested-check'] }] } } },
  });
  await reconnect.wait((rpc) => rpc.method === '_runner/task' && rpc.params.id !== h.submissions[0]!.id);
  assert.deepEqual(h.submissions[1]!.acceptance, normalized, 'prompt metadata cannot replace persisted session checks');
  h.finish(h.submissions[1]!.id!);
  result(await continued);
});

test('malformed, oversized and unsafe acceptance metadata rejects before session execution', async (t) => {
  const h = await fixture(t),
    c = h.open();
  const invalidAcceptance: unknown[] = [
    null,
    'tests',
    { commands: 'node --test' },
    { commands: [{ argv: [] }] },
    { commands: Array.from({ length: 5 }, () => ({ argv: ['true'] })) },
    {
      commands: [
        { argv: ['true'], timeoutMs: 60_001 },
        { argv: ['true'], timeoutMs: 60_000 },
      ],
    },
    { artifacts: [{ path: '../escape' }] },
    { artifacts: [{ path: '.env' }] },
    { artifacts: [{ path: 'output.txt', sha256: 'invalid' }] },
  ];
  for (const input of invalidAcceptance) {
    const response = await c.request('session/new', { _meta: { agentHome: { acceptance: input } } });
    assert.equal(response.error?.code, -32602);
    assert.match(response.error!.message, /Invalid acceptance/);
  }
  assert.equal(h.submissions.length, 0);
  assert.equal(h.loads.length, 0);
});

test('persisted acceptance is revalidated before loading history or forwarding another prompt', async (t) => {
  const h = await fixture(t),
    c = h.open(),
    id = await session(c);
  const path = join(h.stateDir, 'auto', `${id}.json`);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.acceptance = { commands: [{ argv: ['true'], timeoutMs: 120_001 }] };
  await writeFile(path, JSON.stringify(saved));
  assert.equal((await c.request('session/load', { sessionId: id })).error?.code, -32602);
  assert.equal((await c.request('session/prompt', prompt(id))).error?.code, -32602);
  assert.equal(h.loads.length, 0);
  assert.equal(h.submissions.length, 0);
});
