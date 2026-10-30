import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type ContextStoreOptions = {
  dbPath?: string;
  maxSourceBytes?: number;
  maxMemoryBytes?: number;
  maxRecallBytes?: number;
  maxResults?: number;
  now?: () => number;
};

export type SourceRef = { path: string; hash: string; revision: string };
export type SourceRecord = SourceRef & { project: string; bytes: number; tokenEstimate: number; content: string };
export type MemoryRecord = {
  project: string;
  key: string;
  text: string;
  version: number;
  createdAt: number;
  expiresAt: number | null;
  source: SourceRef;
  bytes: number;
  tokenEstimate: number;
  sourceReferenceVerified: true;
  sourceCurrent: boolean;
  trust: 'untrusted';
};
export type FreshMemoryInventory = { revision: string; total: number; truncated: boolean; records: MemoryRecord[] };
export type ArtifactRef = {
  project: string;
  id: string;
  hash: string;
  bytes: number;
  tokenEstimate: number;
  mediaType: string;
};

/** A narrow backend contract. Implementations must preserve project isolation and source provenance. */
export interface MemoryBackend {
  putMemory(input: { project: string; key: string; text: string; source: SourceRef; expiresAt?: number }): MemoryRecord;
  searchMemories(input: { project: string; query: string; limit?: number }): MemoryRecord[];
  deleteMemory(input: { project: string; key: string }): boolean;
}

export class ContextStore implements MemoryBackend {
  readonly db: DatabaseSync;
  readonly maxSourceBytes: number;
  readonly maxMemoryBytes: number;
  readonly maxRecallBytes: number;
  readonly maxResults: number;
  now: () => number;

  constructor(options: ContextStoreOptions = {}) {
    const dbPath = options.dbPath ?? ':memory:';
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      try {
        chmodSync(dbPath, 0o600);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.maxSourceBytes = options.maxSourceBytes ?? 256_000;
    this.maxMemoryBytes = options.maxMemoryBytes ?? 4_096;
    this.maxRecallBytes = options.maxRecallBytes ?? 32_768;
    this.maxResults = options.maxResults ?? 12;
    this.now = options.now ?? Date.now;
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const schemaVersionRow = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (schemaVersionRow.user_version > 1) {
      this.db.close();
      throw new Error(`context database schema ${schemaVersionRow.user_version} is newer than supported schema 1`);
    }
    this.db.exec('PRAGMA journal_mode = WAL;');
    if (schemaVersionRow.user_version < 1) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project TEXT PRIMARY KEY,
        revision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_blobs (
        hash TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        project TEXT NOT NULL,
        hash TEXT NOT NULL,
        content BLOB NOT NULL,
        bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        PRIMARY KEY(project, hash)
      );
      CREATE TABLE IF NOT EXISTS sources (
        project TEXT NOT NULL,
        revision TEXT NOT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL REFERENCES source_blobs(hash),
        PRIMARY KEY(project, revision, path)
      );
      CREATE INDEX IF NOT EXISTS sources_scope ON sources(project, revision);
      CREATE TABLE IF NOT EXISTS memories (
        project TEXT NOT NULL,
        key TEXT NOT NULL,
        text TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY(project, key)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(project UNINDEXED, key UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
    `);
        this.db.exec('PRAGMA user_version = 1; COMMIT;');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* Preserve the migration error. */
        }
        this.db.close();
        throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  setProjectRevision(project: string, revision: string): void {
    required(project, 'project');
    required(revision, 'revision');
    this.db
      .prepare(
        `INSERT INTO projects(project,revision) VALUES (?,?) ON CONFLICT(project) DO UPDATE SET revision=excluded.revision`,
      )
      .run(project, revision);
  }

  currentRevision(project: string): string | undefined {
    const row = this.db.prepare('SELECT revision FROM projects WHERE project=?').get(project) as
      | { revision: string }
      | undefined;
    return row?.revision;
  }

  /** Store opaque task input/output bytes by project-scoped content hash. */
  putArtifact(input: { project: string; content: string | Uint8Array; mediaType?: string }): ArtifactRef {
    required(input.project, 'project');
    const data = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content);
    const maxBytes = this.maxSourceBytes;
    if (data.byteLength > maxBytes) throw new RangeError(`artifact exceeds ${maxBytes} byte limit`);
    const hash = createHash('sha256').update(data).digest('hex');
    const mediaType =
      input.mediaType ?? (typeof input.content === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    this.db
      .prepare('INSERT OR IGNORE INTO artifacts(project,hash,content,bytes,media_type) VALUES (?,?,?,?,?)')
      .run(input.project, hash, new Uint8Array(data), data.byteLength, mediaType);
    return {
      project: input.project,
      id: hash,
      hash,
      bytes: data.byteLength,
      tokenEstimate: estimateTokens(data.byteLength),
      mediaType,
    };
  }

  readArtifact(input: { project: string; id: string; maxBytes?: number }):
    | (ArtifactRef & { content: Buffer })
    | undefined {
    const row = this.db
      .prepare('SELECT hash,content,bytes,media_type FROM artifacts WHERE project=? AND hash=?')
      .get(input.project, input.id) as
      | { hash: string; content: Uint8Array; bytes: number; media_type: string }
      | undefined;
    if (!row) return undefined;
    const cap = Math.min(this.maxSourceBytes, input.maxBytes ?? this.maxSourceBytes);
    if (row.bytes > cap) throw new RangeError(`artifact exceeds read limit ${cap} bytes`);
    const content = Buffer.from(row.content);
    if (sha256(content) !== row.hash) throw new Error('artifact content hash mismatch');
    return {
      project: input.project,
      id: row.hash,
      hash: row.hash,
      bytes: row.bytes,
      tokenEstimate: estimateTokens(row.bytes),
      mediaType: row.media_type,
      content,
    };
  }

  putSource(input: { project: string; revision: string; path: string; content: string }): SourceRef & {
    project: string;
    bytes: number;
    tokenEstimate: number;
  } {
    required(input.project, 'project');
    required(input.revision, 'revision');
    safeRelativePath(input.path);
    this.assertCurrent(input.project, input.revision);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > this.maxSourceBytes) throw new RangeError(`source exceeds ${this.maxSourceBytes} byte limit`);
    const hash = sha256(input.content);
    const tx = this.db;
    try {
      tx.exec('BEGIN IMMEDIATE');
      tx.prepare('INSERT OR IGNORE INTO source_blobs(hash,content,bytes) VALUES (?,?,?)').run(
        hash,
        input.content,
        bytes,
      );
      tx.prepare(`INSERT INTO sources(project,revision,path,hash) VALUES (?,?,?,?)
        ON CONFLICT(project,revision,path) DO UPDATE SET hash=excluded.hash`).run(
        input.project,
        input.revision,
        input.path,
        hash,
      );
      tx.exec('COMMIT');
    } catch (error) {
      try {
        tx.exec('ROLLBACK');
      } catch {
        /* Preserve the operation error. */
      }
      throw error;
    } finally {
      /* The shared connection stays open. */
    }
    return {
      project: input.project,
      revision: input.revision,
      path: input.path,
      hash,
      bytes,
      tokenEstimate: estimateTokens(bytes),
    };
  }

  /**
   * Read one explicitly selected file under root. Path traversal and observed symlink components are rejected.
   * Rechecking realpath and device/inode closes ordinary races, but Node cannot make component traversal openat-style;
   * this is defense in depth, not an OS sandbox against a hostile process concurrently replacing parent directories.
   */
  async readSourceFile(input: { project: string; revision: string; root: string; path: string }): Promise<
    SourceRef & { bytes: number; tokenEstimate: number }
  > {
    safeRelativePath(input.path);
    this.assertCurrent(input.project, input.revision);
    const root = await realpath(input.root);
    const candidate = resolve(root, input.path);
    if (!isWithin(root, candidate)) throw new Error('source path escapes root');
    const canonical = await realpath(candidate);
    if (canonical !== candidate) throw new Error('symlinked source paths are not allowed');
    const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const [canonicalAfter, pathInfo, info] = await Promise.all([
        realpath(candidate),
        lstat(candidate),
        handle.stat(),
      ]);
      if (
        canonicalAfter !== candidate ||
        pathInfo.isSymbolicLink() ||
        pathInfo.dev !== info.dev ||
        pathInfo.ino !== info.ino
      ) {
        throw new Error('source path changed during read');
      }
      if (!info.isFile()) throw new Error('source must be a regular file');
      if (info.size > this.maxSourceBytes) throw new RangeError(`source exceeds ${this.maxSourceBytes} byte limit`);
      const content = await handle.readFile({ encoding: 'utf8' });
      if (Buffer.byteLength(content, 'utf8') > this.maxSourceBytes)
        throw new RangeError(`source exceeds ${this.maxSourceBytes} byte limit`);
      return this.putSource({ project: input.project, revision: input.revision, path: input.path, content });
    } finally {
      await handle.close();
    }
  }

  getSource(input: { project: string; revision: string; path: string }): SourceRecord | undefined {
    this.assertCurrent(input.project, input.revision);
    const row = this.db
      .prepare(`SELECT s.path,s.revision,s.hash,b.content,b.bytes FROM sources s JOIN source_blobs b USING(hash)
      WHERE s.project=? AND s.revision=? AND s.path=?`)
      .get(input.project, input.revision, input.path) as
      | { path: string; revision: string; hash: string; content: string; bytes: number }
      | undefined;
    if (!row) return undefined;
    assertSourceIntegrity(row);
    return {
      project: input.project,
      path: row.path,
      revision: row.revision,
      hash: row.hash,
      content: row.content,
      bytes: row.bytes,
      tokenEstimate: estimateTokens(row.bytes),
    };
  }

  /** Exact lexical search; no embedding or inferred/semantic retrieval is performed. */
  searchSources(input: { project: string; revision: string; query: string; limit?: number }): SourceRecord[] {
    this.assertCurrent(input.project, input.revision);
    const terms = words(input.query);
    if (!terms.length) return [];
    const limit = boundedLimit(input.limit, this.maxResults);
    const rows = this.db
      .prepare(`SELECT s.path,s.revision,s.hash,b.content,b.bytes FROM sources s JOIN source_blobs b USING(hash)
      WHERE s.project=? AND s.revision=? ORDER BY s.path`)
      .all(input.project, input.revision) as Array<{
      path: string;
      revision: string;
      hash: string;
      content: string;
      bytes: number;
    }>;
    const selected: SourceRecord[] = [];
    let usedBytes = 0;
    for (const row of rows) {
      if (!terms.some((term) => row.content.toLocaleLowerCase().includes(term)) || selected.length >= limit) continue;
      assertSourceIntegrity(row);
      if (usedBytes + row.bytes > this.maxRecallBytes) continue;
      selected.push({
        project: input.project,
        path: row.path,
        revision: row.revision,
        hash: row.hash,
        content: row.content,
        bytes: row.bytes,
        tokenEstimate: estimateTokens(row.bytes),
      });
      usedBytes += row.bytes;
    }
    return selected;
  }

  /** Explicit caller-authorized factual write. Same project/key replaces prior fact and increments version. */
  putMemory(input: {
    project: string;
    key: string;
    text: string;
    source: SourceRef;
    expiresAt?: number;
  }): MemoryRecord {
    required(input.project, 'project');
    required(input.key, 'key');
    this.assertCurrent(input.project, input.source.revision);
    if (containsCredential(input.text)) throw new Error('memory appears to contain a credential; refusing to store it');
    const bytes = Buffer.byteLength(input.text, 'utf8');
    if (!input.text.trim()) throw new Error('memory text is required');
    if (bytes > this.maxMemoryBytes) throw new RangeError(`memory exceeds ${this.maxMemoryBytes} byte limit`);
    const source = this.db
      .prepare(`SELECT 1 AS ok FROM sources WHERE project=? AND revision=? AND path=? AND hash=?`)
      .get(input.project, input.source.revision, input.source.path, input.source.hash);
    if (!source) throw new Error('memory source provenance does not match a stored source artifact');
    if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= this.now()))
      throw new Error('expiresAt must be a future timestamp');
    const previous = this.db
      .prepare('SELECT version FROM memories WHERE project=? AND key=?')
      .get(input.project, input.key) as { version: number } | undefined;
    const version = (previous?.version ?? 0) + 1;
    const createdAt = this.now();
    const tx = this.db;
    try {
      tx.exec('BEGIN IMMEDIATE');
      tx.prepare('DELETE FROM memories_fts WHERE project=? AND key=?').run(input.project, input.key);
      tx.prepare(`INSERT INTO memories(project,key,text,version,created_at,expires_at,source_path,source_hash,source_revision,bytes)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project,key) DO UPDATE SET text=excluded.text,version=excluded.version,
        created_at=excluded.created_at,expires_at=excluded.expires_at,source_path=excluded.source_path,source_hash=excluded.source_hash,
        source_revision=excluded.source_revision,bytes=excluded.bytes`).run(
        input.project,
        input.key,
        input.text,
        version,
        createdAt,
        input.expiresAt ?? null,
        input.source.path,
        input.source.hash,
        input.source.revision,
        bytes,
      );
      tx.prepare('INSERT INTO memories_fts(project,key,text) VALUES (?,?,?)').run(input.project, input.key, input.text);
      tx.exec('COMMIT');
    } catch (error) {
      try {
        tx.exec('ROLLBACK');
      } catch {
        /* Preserve the operation error. */
      }
      throw error;
    } finally {
      /* The shared connection stays open. */
    }
    return {
      project: input.project,
      key: input.key,
      text: input.text,
      version,
      createdAt,
      expiresAt: input.expiresAt ?? null,
      source: input.source,
      bytes,
      tokenEstimate: estimateTokens(bytes),
      sourceReferenceVerified: true,
      sourceCurrent: true,
      trust: 'untrusted',
    };
  }

  searchMemories(input: { project: string; query: string; limit?: number }): MemoryRecord[] {
    return this.searchMemoryRows(input, false);
  }

  /**
   * Return only memories whose source still matches this project's current cached snapshot.
   * `searchMemories` remains available for inspection, including stale provenance records.
   */
  searchPromptMemories(input: { project: string; query: string; limit?: number }): MemoryRecord[] {
    return this.searchMemoryRows(input, true);
  }

  /** Fresh source-verified inventory for bounded semantic candidate search; lexical query is intentionally not applied. */
  freshMemoryInventory(input: { project: string; revision: string; limit?: number; maxRecordBytes?: number }): FreshMemoryInventory {
    this.assertCurrent(input.project, input.revision);
    const limit = Math.max(1, Math.min(64, Math.floor(input.limit ?? 64)));
    const maxRecordBytes = Math.max(1, Math.min(16_384, Math.floor(input.maxRecordBytes ?? 4_096)));
    const countRow = this.db.prepare(`SELECT COUNT(*) AS total FROM memories m JOIN projects p ON p.project=m.project
      JOIN sources s ON s.project=m.project AND s.revision=m.source_revision AND s.path=m.source_path AND s.hash=m.source_hash
      WHERE m.project=? AND p.revision=? AND m.source_revision=? AND (m.expires_at IS NULL OR m.expires_at>?)`)
      .get(input.project,input.revision,input.revision,this.now()) as {total:number};
    const rows = this.db.prepare(`SELECT m.project,m.key,m.text,m.version,m.created_at,m.expires_at,m.source_path,m.source_hash,m.source_revision,m.bytes
      FROM memories m JOIN projects p ON p.project=m.project
      JOIN sources s ON s.project=m.project AND s.revision=m.source_revision AND s.path=m.source_path AND s.hash=m.source_hash
      WHERE m.project=? AND p.revision=? AND m.source_revision=? AND m.bytes<=? AND (m.expires_at IS NULL OR m.expires_at>?)
      ORDER BY m.created_at DESC,m.key LIMIT 65`).all(input.project,input.revision,input.revision,maxRecordBytes,this.now()) as Array<{
      project:string; key:string; text:string; version:number; created_at:number; expires_at:number|null;
      source_path:string; source_hash:string; source_revision:string; bytes:number;
    }>;
    const total = countRow.total;
    const records = rows.slice(0,limit).map(row => ({
      project:row.project,key:row.key,text:row.text,version:row.version,createdAt:row.created_at,expiresAt:row.expires_at,
      source:{path:row.source_path,hash:row.source_hash,revision:row.source_revision},bytes:row.bytes,
      tokenEstimate:estimateTokens(row.bytes),sourceReferenceVerified:true as const,sourceCurrent:true,trust:'untrusted' as const,
    }));
    return { revision:input.revision,total,truncated:total>records.length,records };
  }

  private searchMemoryRows(input: { project: string; query: string; limit?: number }, currentOnly: boolean): MemoryRecord[] {
    const terms = words(input.query);
    if (!terms.length) return [];
    const limit = boundedLimit(input.limit, this.maxResults);
    const match = terms.map(escapeFts).join(' AND ');
    const rows = this.db
      .prepare(`SELECT m.project,m.key,m.text,m.version,m.created_at,m.expires_at,m.source_path,m.source_hash,m.source_revision,m.bytes,
        CASE WHEN p.revision=m.source_revision AND EXISTS (
          SELECT 1 FROM sources s WHERE s.project=m.project AND s.revision=m.source_revision AND s.path=m.source_path AND s.hash=m.source_hash
        ) THEN 1 ELSE 0 END AS source_current
      FROM memories_fts f JOIN memories m ON m.project=f.project AND m.key=f.key
      LEFT JOIN projects p ON p.project=m.project
      WHERE memories_fts MATCH ? AND m.project=? AND (m.expires_at IS NULL OR m.expires_at>?)
        AND (?=0 OR (p.revision=m.source_revision AND EXISTS (
          SELECT 1 FROM sources s WHERE s.project=m.project AND s.revision=m.source_revision AND s.path=m.source_path AND s.hash=m.source_hash
        )))
      ORDER BY bm25(memories_fts),m.created_at DESC LIMIT ?`)
      .all(match, input.project, this.now(), currentOnly ? 1 : 0, limit) as Array<{
      project: string;
      key: string;
      text: string;
      version: number;
      created_at: number;
      expires_at: number | null;
      source_path: string;
      source_hash: string;
      source_revision: string;
      bytes: number;
      source_current: number;
    }>;
    const selected: MemoryRecord[] = [];
    let usedBytes = 0;
    for (const row of rows) {
      if (selected.length >= limit || usedBytes + row.bytes > this.maxRecallBytes) continue;
      selected.push({
        project: row.project,
        key: row.key,
        text: row.text,
        version: row.version,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        source: { path: row.source_path, hash: row.source_hash, revision: row.source_revision },
        bytes: row.bytes,
        tokenEstimate: estimateTokens(row.bytes),
        sourceReferenceVerified: true,
        sourceCurrent: row.source_current === 1,
        trust: 'untrusted',
      });
      usedBytes += row.bytes;
    }
    return selected;
  }

  deleteMemory(input: { project: string; key: string }): boolean {
    const tx = this.db;
    try {
      tx.exec('BEGIN IMMEDIATE');
      tx.prepare('DELETE FROM memories_fts WHERE project=? AND key=?').run(input.project, input.key);
      const result = tx.prepare('DELETE FROM memories WHERE project=? AND key=?').run(input.project, input.key);
      tx.exec('COMMIT');
      return Number(result.changes) > 0;
    } catch (error) {
      try {
        tx.exec('ROLLBACK');
      } catch {
        /* Preserve the operation error. */
      }
      throw error;
    } finally {
      /* The shared connection stays open. */
    }
  }

  private assertCurrent(project: string, revision: string): void {
    const current = this.currentRevision(project);
    if (current === undefined) throw new Error(`project revision is not initialized: ${project}`);
    if (current !== revision) throw new Error(`stale project revision: expected ${current}, got ${revision}`);
  }
}

/** Implementable against ContextStore for deterministic, no-model acceptance checks. */
export async function runMemoryAcceptanceBenchmark(): Promise<
  Array<{ name: string; passed: boolean; detail: string }>
> {
  const store = new ContextStore({ maxSourceBytes: 16_384, maxMemoryBytes: 512, now: () => 10_000 });
  const results: Array<{ name: string; passed: boolean; detail: string }> = [];
  const check = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      results.push({ name, passed: true, detail: 'pass' });
    } catch (error) {
      results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  try {
    store.setProjectRevision('project-a', 'r1');
    const ref = store.putSource({
      project: 'project-a',
      revision: 'r1',
      path: 'notes.md',
      content: 'Use pnpm. Preference: concise diffs.',
    });
    await check('explicit preference survives a fresh lookup', () => {
      store.putMemory({
        project: 'project-a',
        key: 'workflow',
        text: 'Use pnpm and prefer concise diffs.',
        source: ref,
      });
      if (store.searchMemories({ project: 'project-a', query: 'pnpm concise' }).length !== 1)
        throw new Error('preference was not retrievable');
    });
    await check('correction replaces prior value; deletion forgets it', () => {
      const corrected = store.putSource({
        project: 'project-a',
        revision: 'r1',
        path: 'notes.md',
        content: 'Use npm. Preference: concise diffs.',
      });
      const updated = store.putMemory({
        project: 'project-a',
        key: 'workflow',
        text: 'Use npm and prefer concise diffs.',
        source: corrected,
      });
      if (
        updated.version !== 2 ||
        store.searchMemories({ project: 'project-a', query: 'npm concise' })[0]?.text !== updated.text
      )
        throw new Error('correction failed');
      store.deleteMemory({ project: 'project-a', key: 'workflow' });
      if (store.searchMemories({ project: 'project-a', query: 'npm concise' }).length) throw new Error('delete failed');
    });
    await check('bounded exact retrieval returns provenance', () => {
      const doc = store.putSource({
        project: 'project-a',
        revision: 'r1',
        path: 'facts.md',
        content: 'Alpha fact. Beta fact.',
      });
      store.putMemory({ project: 'project-a', key: 'alpha', text: 'Alpha fact', source: doc });
      const found = store.searchMemories({ project: 'project-a', query: 'alpha', limit: 1 });
      if (found.length !== 1 || found[0]?.source.hash !== doc.hash)
        throw new Error('missing bounded result provenance');
    });
    await check('project scope prevents cross-project recall', () => {
      store.setProjectRevision('project-b', 'b1');
      const doc = store.putSource({
        project: 'project-b',
        revision: 'b1',
        path: 'facts.md',
        content: 'ProjectBOnly fact.',
      });
      store.putMemory({ project: 'project-b', key: 'project-b-only', text: 'ProjectBOnly fact', source: doc });
      if (store.searchMemories({ project: 'project-a', query: 'ProjectBOnly' }).length)
        throw new Error('cross-project result');
    });
    await check('expiry and credential-like poisoning are rejected', () => {
      const doc = store.putSource({ project: 'project-a', revision: 'r1', path: 'expiry.md', content: 'temporary' });
      store.putMemory({
        project: 'project-a',
        key: 'temporary',
        text: 'Temporary memory',
        source: doc,
        expiresAt: 10_001,
      });
      if (store.searchMemories({ project: 'project-a', query: 'temporary' }).length !== 1)
        throw new Error('not yet valid');
      store.now = () => 10_002;
      if (store.searchMemories({ project: 'project-a', query: 'temporary' }).length)
        throw new Error('expired result returned');
      let rejected = false;
      try {
        store.putMemory({ project: 'project-a', key: 'secret', text: 'token=sk-abcdefghijklmnop', source: doc });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error('credential-like content accepted');
    });
    await check('stale revisions cannot serve cached source', () => {
      store.setProjectRevision('project-a', 'r2');
      let rejected = false;
      try {
        store.getSource({ project: 'project-a', revision: 'r1', path: 'facts.md' });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error('stale source returned');
    });
    await check('source and memory byte bounds reject overflow', () => {
      const tiny = new ContextStore({ maxSourceBytes: 2, maxMemoryBytes: 2 });
      try {
        tiny.setProjectRevision('p', 'r');
        let sourceRejected = false;
        try {
          tiny.putSource({ project: 'p', revision: 'r', path: 'x', content: 'too long' });
        } catch {
          sourceRejected = true;
        }
        if (!sourceRejected) throw new Error('oversize source accepted');
        const source = tiny.putSource({ project: 'p', revision: 'r', path: 'x', content: 'ok' });
        let memoryRejected = false;
        try {
          tiny.putMemory({ project: 'p', key: 'x', text: 'too long', source });
        } catch {
          memoryRejected = true;
        }
        if (!memoryRejected) throw new Error('oversize memory accepted');
      } finally {
        tiny.close();
      }
    });
    return results;
  } finally {
    store.close();
  }
}

function safeRelativePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('path must be a normalized relative path');
  const parts = path.toLocaleLowerCase().split('/');
  const blockedDirectories = new Set(['.logins', '.runner', '.ssh', '.aws']);
  const blockedFiles = new Set([
    'auth.json',
    'credentials.json',
    '.credentials.json',
    'keys.json',
    '.runner-token',
    'application_default_credentials.json',
    'access_tokens.db',
    'credentials.db',
    'id_rsa',
    'id_ed25519',
    'id_ecdsa',
    'id_dsa',
    '.claude.json',
    'claude.json',
  ]);
  const filename = parts.at(-1)!;
  if (
    parts.slice(0, -1).some((part) => blockedDirectories.has(part)) ||
    blockedFiles.has(filename) ||
    filename === '.env' ||
    (filename.startsWith('.env.') && filename !== '.env.example')
  ) {
    throw new Error('credential-bearing source paths are not allowed');
  }
}
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
function required(value: string, label: string): void {
  if (!value?.trim()) throw new Error(`${label} is required`);
}
function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function assertSourceIntegrity(row: { hash: string; content: string; bytes: number }): void {
  if (sha256(row.content) !== row.hash || Buffer.byteLength(row.content, 'utf8') !== row.bytes)
    throw new Error('source artifact integrity check failed');
}
function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}
function boundedLimit(input: number | undefined, max: number): number {
  return Math.max(1, Math.min(max, Number.isInteger(input) ? input! : max));
}
function words(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}
function escapeFts(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function containsCredential(value: string): boolean {
  return /(?:\bBearer\s+\S+|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{12,})/i.test(
    value,
  );
}
