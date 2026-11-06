import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllocationStore, ThreadAllocator, digest } from './allocations.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 't3-bridge-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AllocationStore(directory); await store.initialize();
  const binding = { ownerId: 'owner', threadId: 'thread', allocationId: 'allocation', projectId: 'project',
    briqId: 'root', rootStackId: 'root-stack', stack: 'workspace', environmentId: 'child-env', execEnvironmentId: 'child-exec',
    t3Url: 'https://child.example', providerInstanceId: 'codex', state: 'ready', edgeTokenHash: digest('e'.repeat(32)) };
  await store.save(binding);
  const calls = [], sessions = new Map(); let uncertain = false, badScopes = false, revokeUncertain = false, cleanupUnavailable = false;
  const cloud = {
    issueBridgeSession: async (current, subject, validate) => {
      await validate(); calls.push('issue');
      assert.equal((await store.load('thread')).bridgeSession.state, 'issuing');
      const issued = { sessionId: '12345678-1234-4234-8234-123456789abc', token: 'unit-only-private-bearer', subject, method: 'bearer-access-token',
        scopes: badScopes ? ['orchestration:read', 'terminal:operate'] : ['orchestration:read', 'orchestration:operate'],
        expiresAt: new Date(Date.now() + 86400000).toISOString() };
      sessions.set(issued.sessionId, issued);
      if (uncertain) throw Error('ACK lost');
      return issued;
    },
    listBridgeSessions: async (_, validate) => { await validate(); calls.push('list'); if (cleanupUnavailable) throw Error('Sleeping child cannot run cleanup'); return [...sessions.values()]; },
    revokeBridgeSession: async (_, id, validate) => { await validate(); calls.push('revoke'); sessions.delete(id); if (revokeUncertain) throw Error('ACK lost'); },
    stop: async () => { calls.push('stop'); }, stopped: async () => true,
  };
  const make = activeStore => new ThreadAllocator({ store: activeStore, cloud, image: `example/image@sha256:${'a'.repeat(64)}`,
    bridgeUrl: 'wss://central.example/_cloud/bridge', edgeCredential: 'e'.repeat(32), registerEnvironment: async () => {},
    closeBridge: async () => { calls.push('close'); assert.equal((await activeStore.load('thread')).bridgeSession.token, undefined); } });
  return { store, directory, binding, calls, sessions, make, allocator: make(store), failIssue: () => { uncertain = true; },
    badScopes: () => { badScopes = true; }, failRevoke: () => { revokeUncertain = true; }, sleeping: () => { cleanupUnavailable = true; } };
}
const link = allocator => allocator.bridgeSession('owner', 'thread', 'allocation', 'generation-one');

test('native session persists privately and reconnect reuses it without another issue', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([link(f.allocator), link(f.allocator)]);
  assert.equal(first.token, second.token); assert.deepEqual(f.calls, ['issue']);
  const restarted = f.make(new AllocationStore(f.directory));
  assert.deepEqual(await link(restarted), first); assert.deepEqual(f.calls, ['issue']);
  assert.deepEqual(await f.store.listOperations('thread'), []);
  for (const args of [['other', 'thread', 'allocation', 'generation-one'], ['owner', 'thread', 'other', 'generation-one'],
    ['owner', 'thread', 'allocation', 'generation-two']]) await assert.rejects(restarted.bridgeSession(...args));
  assert.deepEqual(f.calls, ['issue']);
});

test('lost issue result never reissues or reconciles an empty list without terminal evidence', async t => {
  const f = await fixture(t); f.failIssue();
  await assert.rejects(link(f.allocator), /reconciliation/);
  const pending = (await f.store.load('thread')).bridgeSession; assert.equal(pending.state, 'unknown'); assert.equal(pending.token, undefined);
  const restarted = f.make(new AllocationStore(f.directory));
  await assert.rejects(link(restarted), /reconciliation/); assert.deepEqual(f.calls, ['issue']);
  await assert.rejects(restarted.reconcileBridgeSession('owner', 'thread', 'allocation', 'generation-one'), /terminal reconciliation/);
  assert.deepEqual(f.calls, ['issue']);
  f.sessions.clear();
  await assert.rejects(restarted.reconcileBridgeSession('owner', 'thread', 'allocation', 'generation-one'), /terminal reconciliation/);
  assert.deepEqual(f.calls, ['issue']);
});

test('scope expansion, expiry, changed root and user-stopped binding deny link without reissue', async t => {
  const f = await fixture(t); f.badScopes(); await assert.rejects(link(f.allocator), /reconciliation/);
  assert.equal((await f.store.load('thread')).bridgeSession.token, undefined);
  f.sessions.set('unrelated', { sessionId: 'unrelated', subject: 'other-user' });
  await f.allocator.reconcileBridgeSession('owner', 'thread', 'allocation', 'generation-one');
  assert.equal(f.sessions.has('12345678-1234-4234-8234-123456789abc'), false); assert.equal(f.sessions.has('unrelated'), true);
  const valid = await fixture(t); await link(valid.allocator);
  let binding = await valid.store.load('thread'); binding.bridgeSession.expiresAt = '2000-01-01'; await valid.store.save(binding);
  await assert.rejects(link(valid.allocator), /reconciliation/);
  binding = await valid.store.load('thread'); binding.environmentId = 'foreign'; await valid.store.save(binding);
  await assert.rejects(link(valid.allocator), /generation/);
  binding = await valid.store.load('thread'); binding.state = 'revoked'; await valid.store.save(binding);
  await assert.rejects(link(valid.allocator), /unavailable/);
  assert.deepEqual(valid.calls, ['issue']);
});

test('allocation revocation deletes bearer and closes bridge before native revoke and root stop', async t => {
  const f = await fixture(t); await link(f.allocator); await f.allocator.revoke('owner', 'thread');
  assert.deepEqual(f.calls, ['issue', 'close', 'list', 'revoke', 'list', 'stop']);
  const binding = await f.store.load('thread'); assert.equal(binding.state, 'revoked');
  assert.equal(binding.bridgeSession.state, 'revoked'); assert.equal(binding.bridgeSession.token, undefined);
  assert.deepEqual(await f.allocator.revocationIssues(), []);
});

test('ambiguous native revoke stays closed and reconciles by list without replaying revoke', async t => {
  const f = await fixture(t); await link(f.allocator); f.failRevoke();
  await assert.rejects(f.allocator.reconcileBridgeSession('owner', 'thread', 'allocation', 'generation-one'), /reconciliation/);
  assert.equal((await f.store.load('thread')).bridgeSession.state, 'revoke_unknown');
  await assert.rejects(link(f.allocator));
  await f.allocator.reconcileBridgeSession('owner', 'thread', 'allocation', 'generation-one');
  assert.equal(f.calls.filter(value => value === 'revoke').length, 1);
  assert.equal((await f.store.load('thread')).bridgeSession.state, 'revoked');
});

test('unavailable native cleanup does not prevent revocation and root stop', async t => {
  const f = await fixture(t); await link(f.allocator); f.sleeping();
  await assert.rejects(f.allocator.revoke('owner', 'thread'), /cleanup requires reconciliation/);
  assert.deepEqual(f.calls, ['issue', 'close', 'list', 'stop']);
  const binding = await f.store.load('thread'); assert.equal(binding.state, 'revoked');
  assert.equal(binding.rootStop.state, 'completed'); assert.equal(binding.bridgeSession.token, undefined);
  assert.equal(binding.bridgeSession.state, 'revoke_unknown');
  assert.deepEqual(await f.allocator.revocationIssues(), [{ threadId: 'thread', allocationId: 'allocation', state: 'reconciliation-required' }]);
});

test('managed allocation reentry keeps one native thread binding without consuming pairing credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 't3-managed-allocate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AllocationStore(directory); await store.initialize();
  const calls = [];
  const cloud = { create: async binding => { calls.push(['create', binding.threadId]); return { id: 'root', stackId: 'stack' }; },
    endpoints: async () => ({ t3Url: 'https://child.example', execUrl: 'wss://child.example/_cloud/exec' }),
    descriptor: async () => ({ environmentId: 'environment' }), pair: async () => { calls.push(['pair']); throw Error('Managed allocation must not pair'); } };
  const allocator = new ThreadAllocator({ store, cloud, image: `example/image@sha256:${'a'.repeat(64)}`,
    bridgeUrl: 'wss://central.example/_cloud/bridge', edgeCredential: 'e'.repeat(32),
    registerEnvironment: async () => {}, admittedProviders: ['codex', 'claudeAgent'] });
  const nativeThread = `thread:project:${'project%3A'.repeat(60)}:one`;
  const mode = { ownerGeneration: 'generation' };
  const [first, repeat] = await Promise.all([allocator.allocate('owner', nativeThread, 'codex', mode), allocator.allocate('owner', nativeThread, 'codex', mode)]);
  assert.deepEqual(first, repeat); assert.equal(first.threadId, nativeThread); assert.equal('connection' in first, false);
  assert.deepEqual(calls, [['create', nativeThread]]);
  await assert.rejects(allocator.allocate('owner', nativeThread, 'claudeAgent', mode), /provider mismatch/);
  await assert.rejects(allocator.allocate('owner', nativeThread, undefined), /mode mismatch/);
  await assert.rejects(allocator.allocate('owner', nativeThread, 'codex', { ownerGeneration: 'other' }), /mode mismatch/);
  assert.equal(calls.length, 1);
});

async function sourceFixture(t) {
  const { canonicalJson, projectSource } = await import('./allocations.mjs');
  const directory = await mkdtemp(join(tmpdir(), 't3-project-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AllocationStore(directory); await store.initialize();
  const source = { version: 1, sourceId: 'source-one-1234567890', hostProjectId: 'project-one', logicalRoot: '/projects/source-one-1234567890', clone: { remoteUrl: 'https://github.com/up-lab/example.git', protocol: 'https' } };
  source.sourceDigest = digest(canonicalJson(source)); projectSource(source);
  const calls = [], sessions = new Map(); let failCreate = false, failIssue = false;
  const cloud = {
    create: async binding => { calls.push('create'); assert.equal((await store.loadSource(source.sourceId)).state, 'creating'); if (failCreate) throw Error('unknown'); return { id: 'root', stackId: 'stack' }; },
    find: async () => { calls.push('find'); return null; },
    endpoints: async () => ({ t3Url: 'https://child.example' }), descriptor: async () => ({ environmentId: 'environment' }),
    issueBridgeSession: async (binding, subject, validate, options) => {
      await validate(); calls.push(options.preparation ? 'prepare' : 'acp');
      assert.equal((await store.loadSource(source.sourceId)).preparationSession.state, 'issuing');
      const session = { sessionId: '12345678-1234-4234-8234-123456789abc', token: 'private-test-only', subject, method: 'bearer-access-token',
        scopes: ['orchestration:read', 'orchestration:operate', 'source-control:write'], expiresAt: new Date(Date.now() + 240000).toISOString() };
      sessions.set(session.sessionId, session); if (failIssue) throw Error('ACK lost'); return session;
    },
    listBridgeSessions: async (_, validate) => { await validate(); return [...sessions.values()]; },
    revokeBridgeSession: async (_, id, validate) => { await validate(); sessions.delete(id); },
    stop: async () => { calls.push('stop'); }, stopped: async () => true,
  };
  const allocator = new ThreadAllocator({ store, cloud, image: `example/image@sha256:${'a'.repeat(64)}`, bridgeUrl: 'wss://central.example/_cloud/bridge',
    edgeCredential: 'e'.repeat(32), registerEnvironment: async () => { throw Error('Source must never register model environment'); }, closeBridge: async () => {} });
  return { source, store, allocator, calls, sessions, failCreate: () => { failCreate = true; }, failIssue: () => { failIssue = true; } };
}

test('project-source namespace has no thread/provider/executor and never registers model broker', async t => {
  const f = await sourceFixture(t);
  const [a,b] = await Promise.all([f.allocator.allocateSource('owner', f.source, 'generation'), f.allocator.allocateSource('owner', f.source, 'generation')]);
  assert.deepEqual(a,b); assert.deepEqual(f.calls, ['create']);
  const binding = await f.store.loadSource(f.source.sourceId);
  for (const key of ['threadId','providerInstanceId','execToken','execEnvironmentId','nativeThreadId','bridgeToken']) assert.equal(binding[key], undefined);
  assert.deepEqual(await f.store.list(), []); assert.equal((await f.store.listSources()).length, 1);
  await assert.rejects(f.allocator.bridgeSession('owner', f.source.sourceId, a.allocationId, 'generation'));
  await assert.rejects(f.allocator.allocateSource('other', f.source, 'generation'), /mismatch/);
  await assert.rejects(f.allocator.allocateSource('owner', f.source, 'different'), /mismatch/);
});

test('source create and preparation unknown outcomes do not replay', async t => {
  const f = await sourceFixture(t); f.failCreate();
  await assert.rejects(f.allocator.allocateSource('owner', f.source, 'generation'), /unknown/);
  await assert.rejects(f.allocator.allocateSource('owner', f.source, 'generation'), /no create replay/);
  assert.deepEqual(f.calls, ['create','find']);
  const g = await sourceFixture(t); const allocated = await g.allocator.allocateSource('owner', g.source, 'generation'); g.failIssue();
  const issue = () => g.allocator.bridgeSession('owner', g.source.sourceId, allocated.allocationId, 'generation', 'project-source');
  await assert.rejects(issue(), /reconciliation/); await assert.rejects(issue(), /reconciliation/);
  assert.deepEqual(g.calls, ['create','prepare']);
  await assert.rejects(g.allocator.reconcileBridgeSession('owner', g.source.sourceId, allocated.allocationId, 'generation', 'project-source'), /terminal reconciliation/);
});

test('preparation session reuses exact identity, revokes and permits a new short lived capability only after confirmed revocation', async t => {
  const f = await sourceFixture(t), a = await f.allocator.allocateSource('owner', f.source, 'generation');
  const issue = () => f.allocator.bridgeSession('owner', f.source.sourceId, a.allocationId, 'generation', 'project-source');
  assert.deepEqual(await issue(), await issue()); assert.deepEqual(f.calls, ['create','prepare']);
  await f.allocator.reconcileBridgeSession('owner', f.source.sourceId, a.allocationId, 'generation', 'project-source');
  assert.equal(f.sessions.size, 0); await issue(); assert.deepEqual(f.calls, ['create','prepare','prepare']);
  await f.allocator.revokeSource('owner', f.source.sourceId, a.allocationId, 'generation');
  assert.equal(f.calls.at(-1), 'stop'); await assert.rejects(issue());
});

test('source URL/digest validation rejects credential, transport, normalization and identity changes before create', async t => {
  const f = await sourceFixture(t), { canonicalJson } = await import('./allocations.mjs');
  for (const remoteUrl of ['https://user@github.com/a/b', 'https://github.com/a/b?token=x', 'https://github.com:443/a/b', 'http://github.com/a/b', 'https://evil.example/a/b', 'https://github.com/a/../b', 'https://github.com/a/b#secret']) {
    const changed = structuredClone(f.source); changed.clone.remoteUrl = remoteUrl;
    const { sourceDigest, ...identity } = changed; changed.sourceDigest = digest(canonicalJson(identity));
    await assert.rejects(f.allocator.allocateSource('owner', changed, 'generation'));
  }
  await assert.rejects(f.allocator.allocateSource('owner', {...f.source, sourceDigest: 'a'.repeat(64)}, 'generation'));
  assert.deepEqual(f.calls, []);
});

test('thread project source and exact strategy bytes are immutable before create/reuse', async t => {
  const f = await sourceFixture(t);
  const { canonicalJson } = await import('./allocations.mjs');
  const thread = 'literal:phone:thread';
  const first = { projectSource: f.source, workspaceStrategy: { type: 'worktree', baseRef: 'origin/main', startFromOrigin: false } };
  const binding = { version: 1, purpose: 'thread', ownerId: 'owner', threadId: thread, providerInstanceId: 'codex', managedBridge: { ownerGeneration: 'generation' },
    ...first, workspaceRoot: '/work/projects/source-one-1234567890', allocationId: 'allocation', projectId: 'native-project', edgeTokenHash: digest('e'.repeat(32)), state: 'ready' };
  await f.store.save(binding);
  for (const workspaceStrategy of [{ type: 'worktree', baseRef: 'origin/main' }, { type: 'worktree', baseRef: 'origin/main', startFromOrigin: true }, { type: 'root', branch: 'other' }])
    await assert.rejects(f.allocator.allocate('owner', thread, 'codex', { ownerGeneration: 'generation' }, { ...first, workspaceStrategy }), /project mismatch/);
  await assert.rejects(f.allocator.allocate('owner', thread, 'codex', { ownerGeneration: 'generation' }), /project mismatch/);
  assert.equal(canonicalJson((await f.store.load(thread)).workspaceStrategy), canonicalJson(first.workspaceStrategy)); assert.deepEqual(f.calls, []);
});
