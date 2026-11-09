import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveRelease } from './resolve-gh-release.mjs';
const digest = 'sha256:' + 'a'.repeat(64);
const metadata = { tag_name: 'v1.2.3', assets: [{ name: 'binary.tar.gz', digest }] };
const run = (value) => resolveRelease('vendor/tool', 'v', 'binary.tar.gz', {
  fetchRelease: async () => Response.json(value),
});
test('returns version and matching asset digest together', async () => {
  assert.equal(await run(metadata), `1.2.3\t${'a'.repeat(64)}`);
});
test('resolves an exact release tag and rejects mismatched returned versions', async () => {
  let url;
  const lookup = (value) => resolveRelease('openai/codex', 'rust-v', 'binary.tar.gz', {
    version: '0.166.0',
    fetchRelease: async (input) => { url = input; return Response.json(value); },
  });
  assert.equal(await lookup({ ...metadata, tag_name: 'rust-v0.166.0' }), `0.166.0\t${'a'.repeat(64)}`);
  assert.equal(url, 'https://api.github.com/repos/openai/codex/releases/tags/rust-v0.166.0');
  await assert.rejects(lookup({ ...metadata, tag_name: 'rust-v0.167.0' }), /does not match/);
});
test('rejects malformed exact versions before requesting metadata', async () => {
  await assert.rejects(resolveRelease('openai/codex', 'rust-v', 'binary.tar.gz', {
    version: '', fetchRelease: async () => { throw new Error('must not fetch'); },
  }), /Invalid requested release version/);
});
test('local and workflow builds retain the packaged Codex compatibility pin', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  const dockerPin = dockerfile.match(/^ARG CODEX_VERSION=(.+)$/m)?.[1];
  const workflowPin = workflow.match(/^  CODEX_VERSION: (.+)$/m)?.[1];
  assert.equal(dockerPin, '0.166.0');
  assert.equal(workflowPin, dockerPin);
  assert.ok(!dockerfile.includes('repos/openai/codex/releases/latest'));
  assert.ok(!workflow.includes('t3-cloud/t3-source/source.json'));
  assert.ok(workflow.includes('codex-package-x86_64-unknown-linux-musl.tar.gz "$codex_version"'));
});
test('rejects missing, duplicate, malformed or unrelated asset metadata', async () => {
  for (const value of [null, {}, { ...metadata, tag_name: 'latest' },
    { ...metadata, assets: [] }, { ...metadata, assets: [...metadata.assets, ...metadata.assets] },
    { ...metadata, assets: [{ name: 'other', digest }] },
    { ...metadata, assets: [{ name: 'binary.tar.gz', digest: null }] }])
    await assert.rejects(run(value));
});
test('retries only transient metadata responses with a fixed three-attempt bound', async () => {
  let count = 0;
  const lookup = (status) => resolveRelease('vendor/tool', 'v', 'binary.tar.gz', {
    fetchRelease: async () => { count++; return new Response('', { status }); },
  });
  await assert.rejects(lookup(504), /HTTP 504/);
  assert.equal(count, 3);
  count = 0;
  await assert.rejects(lookup(404), /HTTP 404/);
  assert.equal(count, 1);
});
test('accepts recovery from a transient metadata failure', async () => {
  let count = 0;
  assert.equal(await resolveRelease('vendor/tool', 'v', 'binary.tar.gz', {
    fetchRelease: async () => ++count === 1 ? new Response('', { status: 504 }) : Response.json(metadata),
  }), `1.2.3\t${'a'.repeat(64)}`);
  assert.equal(count, 2);
});
