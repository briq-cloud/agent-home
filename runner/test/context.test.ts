import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ContextStore, runMemoryAcceptanceBenchmark } from '../src/context/store.ts';

test('content-addressed artifacts are bounded, stable, and project-scoped', () => {
  const store = new ContextStore({ maxSourceBytes: 100 });
  try {
    const first = store.putArtifact({ project: 'a', content: 'task prompt', mediaType: 'text/plain' });
    const second = store.putArtifact({ project: 'a', content: 'task prompt', mediaType: 'text/plain' });
    assert.equal(first.id, second.id);
    assert.equal(store.readArtifact({ project: 'a', id: first.id })?.content.toString(), 'task prompt');
    assert.equal(store.readArtifact({ project: 'b', id: first.id }), undefined);
    assert.throws(() => store.readArtifact({ project: 'a', id: first.id, maxBytes: 2 }), /read limit/);
    assert.throws(() => store.putArtifact({ project: 'a', content: 'x'.repeat(101) }), /byte limit/);
    assert.equal(first.hash.length, 64);
  } finally {
    store.close();
  }
});

test('source cache is explicitly populated, content-addressed, bounded, and rejects stale revisions', () => {
  const store = new ContextStore({ maxSourceBytes: 20 });
  try {
    store.setProjectRevision('repo', 'abc');
    const ref = store.putSource({ project: 'repo', revision: 'abc', path: 'src/a.ts', content: 'const answer = 42;' });
    assert.equal(ref.hash.length, 64);
    assert.equal(
      store.getSource({ project: 'repo', revision: 'abc', path: 'src/a.ts' })?.content,
      'const answer = 42;',
    );
    assert.equal(store.searchSources({ project: 'repo', revision: 'abc', query: 'answer' }).length, 1);
    assert.equal(store.searchSources({ project: 'repo', revision: 'abc', query: 'not present' }).length, 0);
    assert.throws(
      () => store.putSource({ project: 'repo', revision: 'abc', path: 'large', content: 'x'.repeat(21) }),
      /byte limit/,
    );
    store.setProjectRevision('repo', 'def');
    assert.throws(() => store.getSource({ project: 'repo', revision: 'abc', path: 'src/a.ts' }), /stale/);
    assert.throws(
      () => store.putSource({ project: 'repo', revision: 'abc', path: 'src/a.ts', content: 'stale' }),
      /stale/,
    );
  } finally {
    store.close();
  }
});

test('source reads verify cached content against its content hash', () => {
  const store = new ContextStore();
  try {
    store.setProjectRevision('repo', 'r1');
    const ref = store.putSource({ project: 'repo', revision: 'r1', path: 'source.md', content: 'original' });
    store.db.prepare('UPDATE source_blobs SET content=? WHERE hash=?').run('tampered', ref.hash);
    assert.throws(() => store.getSource({ project: 'repo', revision: 'r1', path: 'source.md' }), /integrity/);
    assert.throws(() => store.searchSources({ project: 'repo', revision: 'r1', query: 'tampered' }), /integrity/);
  } finally {
    store.close();
  }
});

test('same-revision source replacement makes memory provenance stale', () => {
  const store = new ContextStore();
  try {
    store.setProjectRevision('repo', 'r1');
    const oldSource = store.putSource({ project: 'repo', revision: 'r1', path: 'facts.md', content: 'Uses npm.' });
    store.putMemory({ project: 'repo', key: 'package-manager', text: 'Uses npm.', source: oldSource });
    store.putSource({ project: 'repo', revision: 'r1', path: 'facts.md', content: 'Correction: uses pnpm.' });
    const memory = store.searchMemories({ project: 'repo', query: 'npm' })[0];
    assert.equal(memory?.sourceCurrent, false);
  } finally {
    store.close();
  }
});

test('database migration is versioned and file-backed state survives reopen with revision invalidation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-home-context-db-'));
  const dbPath = join(base, 'context.sqlite');
  try {
    const store = new ContextStore({ dbPath });
    assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    store.setProjectRevision('project', 'r1');
    const source = store.putSource({
      project: 'project',
      revision: 'r1',
      path: 'facts.md',
      content: 'The project uses pnpm.',
    });
    store.putMemory({ project: 'project', key: 'package-manager', text: 'The project uses pnpm.', source });
    const artifact = store.putArtifact({ project: 'project', content: 'task result' });
    store.close();
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);

    const reopened = new ContextStore({ dbPath });
    try {
      assert.equal(reopened.currentRevision('project'), 'r1');
      assert.equal(reopened.searchMemories({ project: 'project', query: 'pnpm' })[0]?.text, 'The project uses pnpm.');
      assert.equal(reopened.readArtifact({ project: 'project', id: artifact.id })?.content.toString(), 'task result');
      reopened.setProjectRevision('project', 'r2');
      assert.throws(() => reopened.getSource({ project: 'project', revision: 'r1', path: 'facts.md' }), /stale/);
      assert.equal(reopened.searchMemories({ project: 'project', query: 'pnpm' })[0]?.sourceCurrent, false);
    } finally {
      reopened.close();
    }

    const newer = new DatabaseSync(dbPath);
    newer.exec('PRAGMA user_version = 2');
    newer.close();
    assert.throws(() => new ContextStore({ dbPath }), /newer than supported/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('source file reads reject traversal and symlinks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-home-context-'));
  const root = join(base, 'repo');
  const outside = join(base, 'outside.txt');
  await mkdir(root);
  await writeFile(join(root, 'safe.txt'), 'selected source');
  await writeFile(outside, 'outside secret');
  await symlink(outside, join(root, 'linked.txt'));
  const store = new ContextStore();
  try {
    store.setProjectRevision('repo', 'r1');
    const ref = await store.readSourceFile({ project: 'repo', revision: 'r1', root, path: 'safe.txt' });
    assert.equal(store.getSource({ project: 'repo', revision: 'r1', path: 'safe.txt' })?.hash, ref.hash);
    await assert.rejects(
      store.readSourceFile({ project: 'repo', revision: 'r1', root, path: '../outside.txt' }),
      /normalized relative/,
    );
    await assert.rejects(
      store.readSourceFile({ project: 'repo', revision: 'r1', root, path: 'linked.txt' }),
      /symlink/,
    );
  } finally {
    store.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('source ingestion rejects known credential paths before touching files but permits ordinary .config sources', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-home-context-creds-'));
  const root = join(base, 'repo');
  await mkdir(join(root, '.config'), { recursive: true });
  await writeFile(join(root, '.config', 'source.ts'), 'export const config = true;');
  const store = new ContextStore();
  try {
    store.setProjectRevision('repo', 'r1');
    await assert.rejects(
      store.readSourceFile({
        project: 'repo',
        revision: 'r1',
        root: join(base, 'missing-root'),
        path: '.aws/credentials',
      }),
      /credential-bearing/,
    );
    await assert.rejects(
      store.readSourceFile({ project: 'repo', revision: 'r1', root, path: '.claude/.credentials.json' }),
      /credential-bearing/,
    );
    await assert.rejects(
      store.readSourceFile({ project: 'repo', revision: 'r1', root, path: '.env.local' }),
      /credential-bearing/,
    );
    assert.throws(
      () => store.putSource({ project: 'repo', revision: 'r1', path: '.codex/auth.json', content: 'do not store' }),
      /credential-bearing/,
    );
    assert.equal(store.getSource({ project: 'repo', revision: 'r1', path: '.aws/credentials' }), undefined);
    const ordinary = await store.readSourceFile({ project: 'repo', revision: 'r1', root, path: '.config/source.ts' });
    assert.equal(store.getSource({ project: 'repo', revision: 'r1', path: '.config/source.ts' })?.hash, ordinary.hash);
  } finally {
    store.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('memory requires verified artifact provenance and enforces scope, expiry, and credential guard', () => {
  let clock = 1000;
  const store = new ContextStore({ now: () => clock });
  try {
    store.setProjectRevision('one', 'r1');
    store.setProjectRevision('two', 'r1');
    const source = store.putSource({
      project: 'one',
      revision: 'r1',
      path: 'notes.md',
      content: 'Prefers concise answers.',
    });
    assert.throws(
      () => store.putMemory({ project: 'one', key: 'pref', text: 'Be concise.', source: { ...source, hash: 'bad' } }),
      /provenance/,
    );
    assert.throws(() => store.putMemory({ project: 'two', key: 'pref', text: 'Be concise.', source }), /provenance/);
    assert.throws(
      () => store.putMemory({ project: 'one', key: 'secret', text: 'Bearer token-secret', source }),
      /credential/,
    );
    store.putMemory({ project: 'one', key: 'temporary', text: 'temporary note', source, expiresAt: 1500 });
    assert.equal(store.searchMemories({ project: 'one', query: 'temporary' }).length, 1);
    assert.equal(store.searchMemories({ project: 'two', query: 'temporary' }).length, 0);
    clock = 1500;
    assert.equal(store.searchMemories({ project: 'one', query: 'temporary' }).length, 0);
  } finally {
    store.close();
  }
});

test('same-key correction replaces the old fact, increments version, and deletion forgets it', () => {
  const store = new ContextStore();
  try {
    store.setProjectRevision('p', 'r1');
    const source1 = store.putSource({ project: 'p', revision: 'r1', path: 'prefs.md', content: 'Use npm.' });
    const v1 = store.putMemory({ project: 'p', key: 'package-manager', text: 'Use npm.', source: source1 });
    const source2 = store.putSource({
      project: 'p',
      revision: 'r1',
      path: 'prefs.md',
      content: 'Correction: use pnpm.',
    });
    const v2 = store.putMemory({ project: 'p', key: 'package-manager', text: 'Use pnpm.', source: source2 });
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.equal(store.searchMemories({ project: 'p', query: 'pnpm' })[0]?.source.hash, source2.hash);
    assert.equal(store.searchMemories({ project: 'p', query: 'npm' }).length, 0);
    assert.equal(store.deleteMemory({ project: 'p', key: 'package-manager' }), true);
    assert.equal(store.deleteMemory({ project: 'p', key: 'package-manager' }), false);
    assert.equal(store.searchMemories({ project: 'p', query: 'pnpm' }).length, 0);
  } finally {
    store.close();
  }
});

test('memory results are bounded and expose source reference provenance', () => {
  const store = new ContextStore({ maxResults: 2, maxRecallBytes: 32 });
  try {
    store.setProjectRevision('p', 'r1');
    for (const name of ['first', 'second', 'third']) {
      const source = store.putSource({
        project: 'p',
        revision: 'r1',
        path: `${name}.md`,
        content: `${name} sharedneedle`,
      });
      store.putMemory({ project: 'p', key: name, text: `${name} sharedneedle`, source });
    }
    const rows = store.searchMemories({ project: 'p', query: 'sharedneedle', limit: 99 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sourceReferenceVerified, true);
    assert.equal(rows[0]?.trust, 'untrusted');
    assert.equal(rows[0]?.sourceCurrent, true);
    assert.equal(rows[0]?.source.hash.length, 64);
    assert.ok(rows[0]?.source.path.endsWith('.md'));
    assert.ok(rows.reduce((total, row) => total + row.bytes, 0) <= 32);
    store.setProjectRevision('p', 'r2');
    const staleProvenance = store.searchMemories({ project: 'p', query: 'sharedneedle', limit: 1 })[0];
    assert.equal(staleProvenance?.sourceCurrent, false);
  } finally {
    store.close();
  }
});

test('seven-case deterministic memory acceptance benchmark passes without a model', async () => {
  const results = await runMemoryAcceptanceBenchmark();
  assert.equal(results.length, 7);
  assert.deepEqual(
    results.filter((result) => !result.passed),
    [],
  );
});
