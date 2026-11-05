import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRelease } from './resolve-gh-release.mjs';
const digest = 'sha256:' + 'a'.repeat(64);
const metadata = { tag_name: 'v1.2.3', assets: [{ name: 'binary.tar.gz', digest }] };
const run = (value) => resolveRelease('vendor/tool', 'v', 'binary.tar.gz', {
  fetchRelease: async () => Response.json(value),
});
test('returns version and matching asset digest together', async () => {
  assert.equal(await run(metadata), `1.2.3\t${'a'.repeat(64)}`);
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
