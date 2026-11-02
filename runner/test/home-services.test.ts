import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomeServices } from '../src/app/home-services.ts';

function fixture(url = 'https://coding.example.test') {
  const dir = mkdtempSync(join(tmpdir(), 'home-services-'));
  const binary = join(dir, 'fake-t3');
  writeFileSync(binary, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  const base = args[args.indexOf('--base-url') + 1];
  console.log(JSON.stringify({pairUrl:base+'/pair#token=one-use-test',expiresAt:new Date(Date.now()+300000).toISOString()}));
} else { setInterval(()=>{},1000); }
`, { mode: 0o700 });
  const service = new HomeServices({ env: { PATH: process.env.PATH, HOME: dir, RUNNER_T3_BINARY: binary,
    RUNNER_BRIQ_AGENT_BINARY: binary, ...(url ? { RUNNER_T3_PUBLIC_URL: url } : {}),
    RUNNER_TOKEN: 'never-child-ambient', ANTHROPIC_API_KEY: 'never-child-ambient' }, stateDir: dir, cwd: dir,
    token: 'private-runner-test', runnerPort: 8090 });
  return { dir, service, clean: async () => { await service.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('T3 starts once, seeds only isolated settings and issues short-lived pairing through native CLI', async () => {
  const f = fixture();
  try {
    await Promise.all([f.service.start(), f.service.start()]);
    assert.equal(f.service.status().t3.state, 'running');
    const settings = JSON.parse(readFileSync(join(f.dir, 't3/userdata/settings.json'), 'utf8'));
    assert.equal(settings.providerInstances.codex.enabled, false);
    assert.equal(settings.providerInstances.claudeAgent.enabled, false);
    assert.equal(settings.providerInstances.briqAgent.displayName, 'Briq Agent');
    assert.equal(settings.providerInstances.briqAgent.config.source, 'local');
    assert.equal(JSON.stringify(settings).includes('private-runner-test'), false);
    assert.equal(JSON.stringify(f.service.status()).includes('private-runner-test'), false);
    assert.equal(f.service.status().t3.optinOpenRouter, false);
    assert.equal(f.service.setOpenRouter(true).t3.optinOpenRouter, true);
    assert.throws(() => f.service.setOpenRouter('yes'), /boolean/);
    assert.equal(readFileSync(join(f.dir, 't3/bridge-token'), 'utf8'), 'private-runner-test');
    assert.equal((await f.service.pair()).url, 'https://coding.example.test/pair#token=one-use-test');
  } finally { await f.clean(); }
});

test('T3 preserves conflicting owner settings and refuses competing shared CLI ownership', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, 't3/userdata'), { recursive: true });
    const path = join(f.dir, 't3/userdata/settings.json');
    const original = JSON.stringify({ providerInstances: { codex: { enabled: true } } });
    writeFileSync(path, original);
    await assert.rejects(f.service.start(), /ownership/);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(f.service.status().t3.state, 'stopped');
  } finally { await f.clean(); }
});

test('T3 never invents a public origin or embeds runner credentials in a URL', async () => {
  const f = fixture('');
  try {
    await f.service.start();
    assert.equal(f.service.status().t3.publicUrl, null);
    await assert.rejects(f.service.pair(), /dedicated public origin/);
  } finally { await f.clean(); }
  for (const url of ['https://user:secret@example.test', 'https://example.test/t3', 'https://example.test/?token=x'])
    assert.throws(() => fixture(url), /dedicated HTTP origin/);
});
