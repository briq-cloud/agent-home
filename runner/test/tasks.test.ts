import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { TASK_STORE_LIMITS, TaskStore, type NewTask } from '../src/tasks/index.ts';

const run = promisify(execFile);
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-home-tasks-'));
  const path = join(directory, 'tasks.sqlite');
  const stores = new Set<TaskStore>();
  let now = 1000;
  const open = () => {
    const store = new TaskStore(path, { now: () => now });
    stores.add(store);
    return store;
  };
  const close = (store: TaskStore) => {
    store.close();
    stores.delete(store);
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open,
    close,
    setTime: (time: number) => {
      now = time;
    },
  };
}
function input(id: string, extra: Partial<NewTask> = {}): NewTask {
  return { id, projectId: 'project', promptRef: `prompts/${id}`, route: { mode: 'auto' }, ...extra };
}
const worker = { workerId: 'worker', leaseMs: 100 };

test('persists route, refs and settings through reopening, with WAL migration', (t) => {
  const f = fixture(t);
  let store = f.open();
  const task = store.createTask(
    input('task', {
      inputRefs: ['inputs/a'],
      route: { mode: 'explicit', agentId: 'codex', model: 'model' },
      maxAttempts: 3,
      maxCostMicros: 20,
      maxRuntimeMs: 500,
      deadline: 2000,
      notBefore: 1100,
    }),
  );
  f.close(store);
  store = f.open();
  assert.deepEqual(store.getTask('task'), task);
  const db = new DatabaseSync(f.path);
  assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 2);
  db.close();
  for (const suffix of ['', '-wal', '-shm']) assert.equal(statSync(f.path + suffix).mode & 0o777, 0o600);
  f.close(store);
  chmodSync(f.path, 0o644);
  store = f.open();
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test('validates DAGs atomically and success-gates dependencies', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTask(input('other', { projectId: 'elsewhere' }));
  for (const tasks of [
    [input('a', { dependencyIds: ['missing'] })],
    [input('a', { dependencyIds: ['other'] })],
    [input('a', { parentId: 'other' })],
    [input('a', { dependencyIds: ['a'] })],
    [input('a', { dependencyIds: ['b'] }), input('b', { dependencyIds: ['a'] })],
    [input('a', { parentId: 'b' }), input('b', { parentId: 'a' })],
    [input('a'), input('a')],
    [input('a', { dependencyIds: 'other' as unknown as string[] })],
    [input('a', { inputRefs: 'invalid' as unknown as string[] })],
  ]) {
    assert.throws(() => store.createTasks(tasks));
    assert.equal(store.getTask('a'), null);
  }
  store.createTasks([input('a', { dependencyIds: ['b'], parentId: 'b' }), input('b')]);
  const b = store.claimNext({ ...worker, projectId: 'project' })!;
  assert.equal(b.id, 'b');
  assert.equal(store.claimNext({ ...worker, projectId: 'project' }), null);
  assert.equal(store.complete('b', b.leaseToken)?.status, 'succeeded');
  assert.equal(store.claimNext({ ...worker, projectId: 'project' })?.id, 'a');
});

test('parent lineage does not implicitly gate children; project claims are isolated', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTask(input('parent'));
  store.createTask(input('child', { parentId: 'parent' }));
  store.createTask(input('other', { projectId: 'other-project' }));
  assert.equal(store.claimNext({ ...worker, projectId: 'other-project' })?.id, 'other');
  assert.equal(store.claimNext({ ...worker, projectId: 'project' })?.id, 'child');
  assert.equal(store.listTasks({ projectId: 'project', status: 'queued' }).length, 1);
});

test('enforces notBefore, deadline and exhausted budgets before claiming', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTask(input('delayed', { notBefore: 1200 }));
  store.createTask(input('expired', { deadline: 1000 }));
  store.createTask(input('no-cost-budget', { maxCostMicros: 0 }));
  store.createTask(input('no-time-budget', { maxRuntimeMs: 0 }));
  assert.equal(store.claimNext(worker), null);
  assert.equal(store.getTask('expired')?.failureReason, 'deadline_exceeded');
  assert.equal(store.getTask('no-cost-budget')?.failureReason, 'cost_budget_exceeded');
  assert.equal(store.getTask('no-time-budget')?.failureReason, 'runtime_budget_exceeded');
  f.setTime(1200);
  assert.equal(store.claimNext(worker)?.id, 'delayed');
});

test('two stores share leases, fence stale writes, and only opt-in tasks restart automatically', (t) => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  a.createTask(input('task', { maxAttempts: 2, retryOnLeaseExpiry: true }));
  const first = a.claimNext(worker)!;
  assert.equal(b.claimNext({ ...worker, workerId: 'second' }), null);
  f.setTime(1050);
  assert.equal(a.heartbeat(first.id, first.leaseToken, 200)?.leaseExpiresAt, 1250);
  assert.equal(a.heartbeat(first.id, first.leaseToken, 10)?.leaseExpiresAt, 1250);
  f.setTime(1250);
  assert.equal(a.complete(first.id, first.leaseToken), null);
  const second = b.claimNext({ ...worker, workerId: 'second' })!;
  assert.equal(second.leaseToken, first.leaseToken + 1);
  assert.equal(second.attempts, 2);
  assert.equal(second.runtimeMs, 250);
  assert.equal(a.heartbeat(first.id, first.leaseToken, 100), null);
  assert.equal(a.complete(first.id, first.leaseToken), null);
  assert.equal(a.fail(first.id, first.leaseToken, { retryAt: 1300 }), null);
  assert.equal(b.complete(second.id, second.leaseToken, { outputRef: 'outputs/result' })?.status, 'succeeded');
});

test('restart recovery fails unknown external effects and explicit retry remains bounded', (t) => {
  const f = fixture(t);
  let store = f.open();
  store.createTask(input('task', { maxAttempts: 2 }));
  const first = store.claimNext(worker)!;
  f.close(store);
  f.setTime(5000);
  store = f.open();
  store.recover();
  assert.equal(store.getTask('task')?.status, 'failed');
  assert.equal(store.getTask('task')?.runtimeMs, 100); // downtime is not charged as runtime
  assert.equal(store.claimNext(worker), null);
  assert.equal(store.retryTask('task')?.status, 'queued');
  const second = store.claimNext(worker)!;
  assert.equal(second.attempts, 2);
  assert.equal(store.complete('task', first.leaseToken), null);
  f.setTime(5100);
  store.recover();
  assert.equal(store.getTask('task')?.status, 'failed');
  assert.equal(store.retryTask('task'), null);
});

test('failure retries require explicit retryAt and cannot exceed attempts', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTask(input('task', { maxAttempts: 3 }));
  let task = store.claimNext(worker)!;
  assert.equal(store.fail(task.id, task.leaseToken, { errorRef: 'errors/one' })?.status, 'failed');
  assert.equal(store.claimNext(worker), null);
  store.retryTask(task.id, 1100);
  assert.equal(store.claimNext(worker), null);
  f.setTime(1100);
  task = store.claimNext(worker)!;
  assert.equal(store.fail(task.id, task.leaseToken, { retryAt: 1200 })?.status, 'queued');
  assert.equal(store.claimNext(worker), null);
  f.setTime(1200);
  task = store.claimNext(worker)!;
  assert.equal(store.fail(task.id, task.leaseToken, { retryAt: 1200 })?.status, 'failed');
  assert.equal(store.retryTask(task.id), null);
});

test('cancels running work, fences its executor and blocks failed prerequisite chains', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTasks([input('a'), input('b', { dependencyIds: ['a'] }), input('c', { dependencyIds: ['b'] })]);
  const task = store.claimNext(worker)!;
  assert.equal(task.id, 'a');
  assert.equal(store.cancel('a')?.status, 'cancelled');
  assert.equal(store.complete('a', task.leaseToken), null);
  assert.equal(store.heartbeat('a', task.leaseToken, 100), null);
  assert.equal(store.getTask('b')?.status, 'blocked');
  assert.equal(store.getTask('c')?.status, 'blocked');
  assert.equal(store.claimNext(worker), null);
  assert.equal(store.cancel('missing'), null);
});

test('observed cumulative costs are idempotent while unreported attempts remain unknown', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTask(input('task', { maxAttempts: 2, maxCostMicros: 20 }));
  let task = store.claimNext(worker)!;
  assert.equal(task.costMicros, null);
  assert.equal(task.knownCostMicros, 0);
  assert.equal(store.heartbeat('task', task.leaseToken, 100, { costMicros: 10 })?.costMicros, 10);
  assert.equal(store.heartbeat('task', task.leaseToken, 100, { costMicros: 10 })?.costMicros, 10);
  assert.throws(() => store.heartbeat('task', task.leaseToken, 100, { costMicros: 9 }), /decrease/);
  store.fail('task', task.leaseToken, { retryAt: 1000 });
  task = store.claimNext(worker)!;
  assert.equal(task.costMicros, null);
  assert.equal(store.complete('task', task.leaseToken, { costMicros: 5 })?.costMicros, 15);
  store.createTask(input('unknown', { maxAttempts: 2 }));
  task = store.claimNext(worker)!;
  store.fail(task.id, task.leaseToken, { retryAt: 1000 });
  task = store.claimNext(worker)!;
  const result = store.complete(task.id, task.leaseToken, { costMicros: 8 })!;
  assert.equal(result.costMicros, null);
  assert.equal(result.knownCostMicros, 8);
});

test('budget/deadline overruns fail accepted attempts rather than record success', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTask(input('cost', { maxCostMicros: 10, maxAttempts: 3 }));
  let task = store.claimNext(worker)!;
  assert.equal(store.complete(task.id, task.leaseToken, { costMicros: 11 })?.failureReason, 'cost_budget_exceeded');
  assert.equal(store.retryTask(task.id), null);
  store.createTask(input('runtime', { maxRuntimeMs: 20, maxAttempts: 2 }));
  task = store.claimNext(worker)!;
  f.setTime(1021);
  assert.equal(store.heartbeat(task.id, task.leaseToken, 100)?.failureReason, 'runtime_budget_exceeded');
  store.createTask(input('deadline', { deadline: 1050 }));
  task = store.claimNext(worker)!;
  f.setTime(1050);
  assert.equal(store.complete(task.id, task.leaseToken)?.failureReason, 'deadline_exceeded');
});

test('lease recovery cannot immediately reclaim a task at its exact cost or runtime cap', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTask(input('cost', { maxCostMicros: 10, maxAttempts: 2, retryOnLeaseExpiry: true }));
  let task = store.claimNext(worker)!;
  store.heartbeat(task.id, task.leaseToken, 100, { costMicros: 10 });
  f.setTime(1100);
  assert.equal(store.claimNext(worker), null);
  assert.equal(store.getTask(task.id)?.failureReason, 'cost_budget_exceeded');
  store.createTask(input('runtime', { maxRuntimeMs: 100, maxAttempts: 2, retryOnLeaseExpiry: true }));
  task = store.claimNext(worker)!;
  f.setTime(1200);
  assert.equal(store.claimNext(worker), null);
  assert.equal(store.getTask(task.id)?.failureReason, 'runtime_budget_exceeded');
});

test('session and permission checkpoints survive reopening and are fenced', (t) => {
  const f = fixture(t);
  let store = f.open();
  store.createTask(input('task'));
  const task = store.claimNext(worker)!;
  store.heartbeat(task.id, task.leaseToken, 200, {
    sessionRef: 'sessions/session',
    permissionRef: 'permissions/pending',
  });
  f.close(store);
  store = f.open();
  assert.equal(store.getTask(task.id)?.sessionRef, 'sessions/session');
  assert.equal(store.getTask(task.id)?.permissionRef, 'permissions/pending');
  assert.equal(store.heartbeat(task.id, task.leaseToken, 200, { permissionRef: null })?.permissionRef, null);
  f.setTime(1200);
  store.recover();
  assert.equal(store.getTask(task.id)?.status, 'failed');
  assert.equal(store.heartbeat(task.id, task.leaseToken, 100, { sessionRef: 'stale' }), null);
  assert.equal(store.getTask(task.id)?.sessionRef, 'sessions/session');
});

test('durable messages deduplicate by scope and reject conflicting retries; ack is recipient-scoped and idempotent', (t) => {
  const f = fixture(t);
  let store = f.open();
  store.createTask(input('task'));
  store.createTask(input('other', { projectId: 'other' }));
  const message = {
    projectId: 'project',
    sender: 'user',
    recipient: 'agent',
    text: 'Continue',
    idempotencyKey: 'send-1',
  };
  const projectMessage = store.sendMessage(message);
  assert.deepEqual(store.sendMessage(message), projectMessage);
  assert.throws(() => store.sendMessage({ ...message, text: 'Changed' }), /different content/);
  assert.throws(() => store.sendMessage({ ...message, recipient: 'wrong' }), /different content/);
  assert.throws(() => store.sendMessage({ ...message, taskId: 'missing' }), /Unknown/);
  assert.throws(() => store.sendMessage({ ...message, taskId: 'other' }), /cross-project/);
  const taskMessage = store.sendMessage({ ...message, taskId: 'task' });
  const otherMessage = store.sendMessage({ ...message, projectId: 'other' });
  assert.notEqual(taskMessage.id, projectMessage.id);
  assert.notEqual(otherMessage.id, projectMessage.id);
  assert.equal(store.acknowledgeMessage(projectMessage.id, 'wrong'), null);
  f.setTime(1100);
  assert.equal(store.acknowledgeMessage(projectMessage.id, 'agent')?.acknowledgedAt, 1100);
  f.setTime(1200);
  assert.equal(store.acknowledgeMessage(projectMessage.id, 'agent')?.acknowledgedAt, 1100);
  f.close(store);
  store = f.open();
  assert.deepEqual(store.sendMessage({ ...message, taskId: 'task' }), taskMessage);
  assert.equal(store.listMessages({ projectId: 'project', unacknowledgedOnly: true }).length, 1);
  assert.equal(store.listMessages({ projectId: 'project', taskId: null }).length, 1);
  assert.equal(store.listMessages({ projectId: 'project', taskId: 'task', recipient: 'agent' }).length, 1);
  assert.equal(store.listMessages({ projectId: 'project', recipient: 'nobody' }).length, 0);
});

test('independent processes contend for each claim only once', async (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTasks(Array.from({ length: 18 }, (_, i) => input(`task-${String(i).padStart(2, '0')}`)));
  const source = `
    import { TaskStore } from ${JSON.stringify(new URL('../src/tasks/index.ts', import.meta.url).href)};
    const store = new TaskStore(process.argv[1]);
    const ids = [];
    let task;
    while ((task = store.claimNext({ workerId: process.argv[2], leaseMs: 60000 }))) ids.push(task.id);
    console.log(JSON.stringify(ids));
    store.close();
  `;
  // Real Date.now in processes: make task deadlines absent and leases long enough
  // that this test checks transaction contention rather than timeout recovery.
  const outputs = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      run(process.execPath, ['--input-type=module', '--eval', source, f.path, `process-${i}`]),
    ),
  );
  const claims = outputs.flatMap(({ stdout }) => JSON.parse(stdout) as string[]);
  assert.equal(claims.length, 18);
  assert.equal(new Set(claims).size, 18);
  assert.equal(store.listTasks({ status: 'running' }).length, 18);
});

test('committed claim survives abrupt process exit and cannot be silently rerun', async (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTask(input('task', { maxAttempts: 2 }));
  const source = `
    import { TaskStore } from ${JSON.stringify(new URL('../src/tasks/index.ts', import.meta.url).href)};
    const store = new TaskStore(process.argv[1], { now: () => 1000 });
    const task = store.claimNext({ workerId: 'crashed', leaseMs: 100 });
    console.log(task.leaseToken);
    process.exit(0);
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', source, f.path]);
  assert.equal(Number(stdout.trim()), 1);
  f.setTime(1100);
  store.recover();
  assert.equal(store.getTask('task')?.failureReason, 'lease_expired');
  assert.equal(store.claimNext(worker), null);
});

test('rejects unknown schema versions without modifying the database', (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.path);
  db.exec('PRAGMA user_version = 999');
  db.close();
  assert.throws(() => f.open(), /Unsupported task database schema 999/);
  const reopened = new DatabaseSync(f.path);
  assert.equal(reopened.prepare('PRAGMA user_version').get()!.user_version, 999);
  reopened.close();
});

test('bounds caller strings, batches, dependency lists and query pages', (t) => {
  const f = fixture(t);
  const store = f.open();
  assert.throws(() => store.createTask(input('x'.repeat(TASK_STORE_LIMITS.idCharacters + 1))));
  assert.throws(() =>
    store.createTask(input('task', { promptRef: 'x'.repeat(TASK_STORE_LIMITS.referenceCharacters + 1) })),
  );
  assert.throws(() =>
    store.createTasks(Array.from({ length: TASK_STORE_LIMITS.batch + 1 }, (_, i) => input(`task-${i}`))),
  );
  assert.throws(() =>
    store.createTask(input('task', { dependencyIds: Array.from({ length: 257 }, (_, i) => `missing-${i}`) })),
  );
  assert.throws(() => store.createTask(input('task', { inputRefs: Array.from({ length: 129 }, () => 'ref') })));
  store.createTasks(Array.from({ length: 100 }, (_, i) => input(`task-${String(i).padStart(3, '0')}`)));
  store.createTasks(Array.from({ length: 5 }, (_, i) => input(`task-${100 + i}`)));
  assert.equal(store.listTasks().length, 100);
  assert.equal(store.listTasks({ limit: 10, offset: 100 }).length, 5);
  assert.equal(store.listTasks({ limit: 1000 }).length, 105);
  for (const limit of [0, -1, 1001, Number.POSITIVE_INFINITY]) {
    assert.throws(() => store.listTasks({ limit }));
    assert.throws(() => store.listMessages({ projectId: 'project', limit }));
  }
  assert.throws(() =>
    store.sendMessage({
      projectId: 'project',
      sender: 'user',
      recipient: 'agent',
      text: 'x'.repeat(TASK_STORE_LIMITS.messageCharacters + 1),
      idempotencyKey: 'too-large',
    }),
  );
  for (let i = 0; i < 105; i++)
    store.sendMessage({
      projectId: 'project',
      sender: 'user',
      recipient: 'agent',
      text: 'text',
      idempotencyKey: `message-${i}`,
    });
  assert.equal(store.listMessages({ projectId: 'project' }).length, 100);
  assert.equal(store.listMessages({ projectId: 'project', limit: 10, offset: 100 }).length, 5);
});

test('memory database works without filesystem permission handling', () => {
  const store = new TaskStore(':memory:');
  try {
    assert.equal(store.createTask(input('task')).status, 'queued');
  } finally {
    store.close();
  }
});

test('claim selector supports engine admission while retaining dependency/project gates', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.createTasks([input('a'), input('b'), input('c', { dependencyIds: ['a'] })]);
  assert.equal(store.claimNext({ ...worker, taskId: 'c' }), null);
  assert.equal(store.claimNext({ ...worker, taskId: 'b', projectId: 'wrong-project' }), null);
  assert.equal(store.claimNext({ ...worker, taskId: 'b' })?.id, 'b');
  assert.equal(store.getTask('a')?.status, 'queued');
});

test('child counts are project scoped and do not depend on historical task list pages', (t) => {
  const f = fixture(t);
  const store = f.open();
  for (let batch = 0; batch < 11; batch++) {
    const values = Array.from({ length: 100 }, (_, index) => input(`historical-${batch}-${index}`, { deadline: 1000 }));
    store.createTasks(values);
  }
  store.createTask(input('parent'));
  store.createTask(input('child-one', { parentId: 'parent' }));
  store.createTask(input('child-two', { parentId: 'parent' }));
  store.cancel('child-two');
  assert.equal(store.countChildren('project', 'parent'), 2);
  assert.equal(store.countChildren('other-project', 'parent'), 0);
  assert.equal(store.countChildren('project', 'missing'), 0);
});

test('migrates v1 titles additively and compare-and-set backfill preserves execution facts across stores/restarts', (t) => {
  const f = fixture(t);
  let store = f.open();
  store.createTask(input('legacy'));
  const claimed = store.claimNext(worker)!;
  const before = store.getTask('legacy')!;
  f.close(store);
  const old = new DatabaseSync(f.path);
  old.exec('DROP INDEX tasks_untitled; ALTER TABLE tasks DROP COLUMN title; PRAGMA user_version = 1;');
  old.close();
  store = f.open();
  assert.deepEqual(store.getTask('legacy'), { ...before, title: null });
  const second = f.open();
  assert.equal(store.fillTaskTitle('other-project', 'legacy', 'Wrong scope'), false);
  assert.equal(store.fillTaskTitle('project', 'legacy', '  Restore\n account summary  '), true);
  assert.equal(second.fillTaskTitle('project', 'legacy', 'Racing replacement'), false);
  const after = second.getTask('legacy')!;
  assert.deepEqual(after, { ...before, title: 'Restore account summary' });
  assert.equal(after.leaseToken, claimed.leaseToken);
  f.close(store);
  f.close(second);
  store = f.open();
  assert.equal(store.getTask('legacy')!.title, 'Restore account summary');
  assert.deepEqual(store.untitledTasks(), []);
});

test('bounds normalized titles and indexed legacy batches without cross-project dependency links', (t) => {
  const f = fixture(t),
    store = f.open();
  assert.equal(store.createTask(input('named', { title: '  Title\twith\nspaces  ' })).title, 'Title with spaces');
  for (const title of ['', ' '.repeat(3), 'x'.repeat(161), '\0', '\u0001'])
    assert.throws(() => store.createTask(input('invalid', { title })));
  store.createTasks(Array.from({ length: 20 }, (_, i) => input(`legacy-${i}`)));
  assert.equal(store.untitledTasks().length, 10);
  assert.throws(() => store.untitledTasks(11));
  store.createTask(input('foreign', { projectId: 'foreign-project' }));
  const db = new DatabaseSync(f.path);
  db.prepare('INSERT INTO task_dependencies(task_id, dependency_id) VALUES (?,?)').run('named', 'foreign');
  db.close();
  assert.deepEqual(store.dependencyWait(store.getTask('named')!), { blocked: true, taskIds: [] });
  assert.equal(store.claimNext({ ...worker, taskId: 'named' }), null);
});
