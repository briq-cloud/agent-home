import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ContextStore } from '../src/context/store.ts';
import { TaskStore } from '../src/tasks/index.ts';
import type { Task } from '../src/tasks/index.ts';
import { Delegation } from '../src/orchestration/delegation.ts';
import type { Engine, EngineSubmission } from '../src/orchestration/engine.ts';

function fixture(t: TestContext, options: { memoryEnabled?: boolean; enabled?: boolean } = {}) {
  const tasks = new TaskStore(':memory:'),
    context = new ContextStore();
  t.after(() => {
    tasks.close();
    context.close();
  });
  const submissions: EngineSubmission[] = [],
    cancellations: string[] = [],
    waited: string[] = [];
  let inWait = 0,
    maxWaits = 0;
  const promptRef = (project: string) =>
    context.putArtifact({
      project,
      content: JSON.stringify({
        version: 1,
        submission: { allowPaidApi: false, maxEstimatedUsd: 0.25, decisionBudgetUsd: 0.01 },
      }),
    }).id;
  const engine = {
    submit(input: EngineSubmission) {
      submissions.push(input);
      return tasks.createTask({
        projectId: input.projectId,
        promptRef: promptRef(input.projectId),
        parentId: input.parentId,
        dependencyIds: input.dependencyIds,
        route: input.route,
        maxRuntimeMs: input.maxRuntimeMs,
        deadline: input.deadline,
      });
    },
    async wait(id: string, input: { parentTaskId?: string } = {}) {
      // Mirrors the Engine's single yielded-child invariant. Promise.all would
      // reject on its second child while the first is still using the write slot.
      assert.equal(inWait, 0, 'coordinator must not concurrently wait on distinct children');
      assert.equal(tasks.getTask(id)?.parentId, input.parentTaskId);
      inWait++;
      maxWaits = Math.max(maxWaits, inWait);
      waited.push(id);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return tasks.getTask(id)!;
      } finally {
        inWait--;
      }
    },
    cancel(id: string) {
      cancellations.push(id);
      return tasks.cancel(id);
    },
  };
  const delegation = new Delegation({
    tasks,
    context,
    engine: () => engine as unknown as Engine,
    enabled: options.enabled ?? true,
    memoryEnabled: options.memoryEnabled,
    url: () => 'http://127.0.0.1:8090',
  });
  const create = (projectId = 'home', parentId?: string) =>
    tasks.createTask({ projectId, parentId, promptRef: promptRef(projectId), route: { mode: 'auto' }, maxAttempts: 2 });
  const claim = (task: Task, workerId = 'worker') => tasks.claimNext({ taskId: task.id, workerId, leaseMs: 60_000 })!;
  const capability = (task: Task): string => {
    const server = delegation.server(task)!;
    const env = server.env as { name: string; value: string }[];
    const token = env.find((item) => item.name === 'AGENT_HOME_TASK_CAP')?.value;
    assert.equal(typeof token, 'string');
    return token!;
  };
  return {
    tasks,
    context,
    delegation,
    submissions,
    cancellations,
    waited,
    create,
    claim,
    capability,
    maxWaits: () => maxWaits,
  };
}

test('attempt capability cannot revive after fail, retry and a new claim fence', async (t) => {
  const h = fixture(t),
    first = h.claim(h.create(), 'worker-one'),
    cap = h.capability(first);
  assert.equal(((await h.delegation.call(cap, 'status', {})) as Task).leaseToken, first.leaseToken);
  h.tasks.fail(first.id, first.leaseToken);
  assert.ok(h.tasks.retryTask(first.id));
  const second = h.claim(h.tasks.getTask(first.id)!, 'worker-two');
  assert.ok(second.leaseToken > first.leaseToken);
  await assert.rejects(h.delegation.call(cap, 'status', {}), /capability expired/);
  // A revoked/orphaned transport cannot cancel the replacement attempt either.
  h.delegation.disconnect(cap);
  assert.equal(h.cancellations.length, 0);
  const fresh = h.capability(second);
  assert.equal(((await h.delegation.call(fresh, 'status', {})) as Task).workerId, 'worker-two');
});

test('capability confines status, result, send and dependency references to its team and project', async (t) => {
  const h = fixture(t),
    root = h.claim(h.create()),
    cap = h.capability(root);
  const child = h.create('home', root.id),
    otherRoot = h.create('home'),
    foreign = h.create('foreign');
  assert.equal(((await h.delegation.call(cap, 'status', { taskId: child.id })) as Task).id, child.id);
  for (const outsider of [otherRoot, foreign]) {
    await assert.rejects(h.delegation.call(cap, 'status', { taskId: outsider.id }), /outside delegation scope/);
    await assert.rejects(h.delegation.call(cap, 'result', { taskId: outsider.id }), /outside delegation scope/);
    await assert.rejects(
      h.delegation.call(cap, 'send', { taskId: outsider.id, text: 'steer' }),
      /outside delegation scope/,
    );
    await assert.rejects(
      h.delegation.call(cap, 'spawn', { prompt: 'child', dependencyIds: [outsider.id] }),
      /outside delegation scope/,
    );
  }
  assert.equal(h.submissions.length, 0);
});

test('coordinator admits eight children and rejects the ninth without side effects', async (t) => {
  const h = fixture(t),
    root = h.claim(h.create()),
    cap = h.capability(root);
  for (let i = 0; i < 8; i++) {
    const child = (await h.delegation.call(cap, 'spawn', { prompt: `child ${i}` })) as Task;
    assert.equal(child.parentId, root.id);
    assert.equal(child.projectId, root.projectId);
  }
  await assert.rejects(h.delegation.call(cap, 'spawn', { prompt: 'ninth child' }), /child limit/);
  assert.equal(h.submissions.length, 8);
  assert.ok(h.submissions.every((input) => input.allowPaidApi === false && input.maxRuntimeMs! <= 300_000));
});

test('child capabilities cannot spawn grandchildren or yield to siblings', async (t) => {
  const h = fixture(t),
    root = h.claim(h.create());
  const child = h.claim(h.create('home', root.id)),
    cap = h.capability(child);
  await assert.rejects(h.delegation.call(cap, 'spawn', { prompt: 'grandchild' }), /nested delegation/);
  await assert.rejects(h.delegation.call(cap, 'wait', { taskIds: [child.id] }), /only coordinator/);
  assert.equal(h.submissions.length, 0);
});

test('multi-child wait is sequential and checks every child before yielding', async (t) => {
  const h = fixture(t),
    root = h.claim(h.create()),
    cap = h.capability(root);
  const a = h.create('home', root.id),
    b = h.create('home', root.id);
  const results = (await h.delegation.call(cap, 'wait', { taskIds: [a.id, b.id] })) as Task[];
  assert.deepEqual(h.waited, [a.id, b.id]);
  assert.equal(h.maxWaits(), 1);
  assert.deepEqual(
    results.map((task) => task.id),
    [a.id, b.id],
  );
  const outsider = h.create('home');
  await assert.rejects(h.delegation.call(cap, 'wait', { taskIds: [a.id, outsider.id] }), /outside delegation scope/);
  assert.deepEqual(h.waited, [a.id, b.id], 'invalid aggregate must not start a partial wait');
});

test('transport disconnect cancels the owning coordinator and invalidates its capability once', async (t) => {
  const h = fixture(t),
    root = h.claim(h.create()),
    cap = h.capability(root);
  h.delegation.disconnect(cap);
  assert.deepEqual(h.cancellations, [root.id]);
  assert.equal(h.tasks.getTask(root.id)?.status, 'cancelled');
  h.delegation.disconnect(cap);
  assert.deepEqual(h.cancellations, [root.id]);
  await assert.rejects(h.delegation.call(cap, 'status', {}), /capability expired/);
});

test('globally disabled memory cannot be recalled with an otherwise valid task capability', async (t) => {
  const h = fixture(t, { memoryEnabled: false }),
    root = h.claim(h.create()),
    cap = h.capability(root);
  await assert.rejects(h.delegation.call(cap, 'recall', { query: 'project architecture' }), /memory disabled/);
  assert.equal(((await h.delegation.call(cap, 'status', {})) as Task).id, root.id);
});

test('disabled delegation exposes no MCP server and arbitrary capabilities are rejected', async (t) => {
  const h = fixture(t, { enabled: false }),
    root = h.claim(h.create());
  assert.equal(h.delegation.server(root), undefined);
  await assert.rejects(h.delegation.call('not-a-capability', 'status', {}), /capability expired/);
});

test('agent lexical recall exposes only fresh current-project provenance and never stale or foreign facts', async (t) => {
  const h = fixture(t),
    root = h.claim(h.create()),
    cap = h.capability(root);
  for (const project of ['home', 'foreign']) h.context.setProjectRevision(project, 'r1');
  const current = h.context.putSource({
    project: 'home',
    revision: 'r1',
    path: 'current.md',
    content: 'Current Alpha policy',
  });
  h.context.putMemory({ project: 'home', key: 'current', text: 'Alpha current fact', source: current });
  const stale = h.context.putSource({ project: 'home', revision: 'r1', path: 'stale.md', content: 'Old Alpha policy' });
  h.context.putMemory({ project: 'home', key: 'stale', text: 'Alpha stale fact', source: stale });
  h.context.putSource({ project: 'home', revision: 'r1', path: 'stale.md', content: 'Corrected Alpha policy' });
  const foreign = h.context.putSource({
    project: 'foreign',
    revision: 'r1',
    path: 'facts.md',
    content: 'Foreign Alpha policy',
  });
  h.context.putMemory({ project: 'foreign', key: 'foreign', text: 'Alpha foreign fact', source: foreign });
  const recalled = (await h.delegation.call(cap, 'recall', { query: 'Alpha' })) as {
    trust: string;
    memories: Array<{ key: string; sourceCurrent: boolean }>;
  };
  assert.equal(recalled.trust, 'untrusted');
  assert.deepEqual(
    recalled.memories.map((memory) => memory.key),
    ['current'],
  );
  assert.ok(recalled.memories.every((memory) => memory.sourceCurrent));
  assert.equal(
    h.context.searchMemories({ project: 'home', query: 'Alpha' }).length,
    2,
    'administrative listing still retains stale provenance for inspection',
  );
});
