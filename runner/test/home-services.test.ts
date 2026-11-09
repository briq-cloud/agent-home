import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomeServices } from '../src/app/home-services.ts';

test('native Briq status retains its configuration without forwarding unrelated credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-services-'));
  writeFileSync(join(dir, 'briq'), `#!${process.execPath}
const valid = process.argv.slice(2).join(' ') === 'whoami --json' &&
  process.env.BRIQ_CONFIG_DIR === process.env.HOME + '/config' &&
  process.env.BRIQ_API_URL === 'https://api.example.test' &&
  process.env.BRIQ_API_KEY === 'native-test-key' && !process.env.RUNNER_TOKEN && !process.env.ANTHROPIC_API_KEY;
console.log(JSON.stringify({loggedIn: valid}));
`, { mode: 0o700 });
  const service = new HomeServices({ env: { PATH: dir, HOME: dir, BRIQ_CONFIG_DIR: join(dir, 'config'),
    BRIQ_API_URL: 'https://api.example.test', BRIQ_API_KEY: 'native-test-key',
    RUNNER_TOKEN: 'private-runner-test', ANTHROPIC_API_KEY: 'unrelated-test-key', RUNNER_DSH: '1' } });
  try {
    assert.deepEqual(await service.briqStatus(), { authenticated: true, login: { state: 'idle' } });
    const status = service.status();
    assert.equal(status.dsh.enabled, true);
    assert.deepEqual(Object.keys(status).sort(), ['briq', 'dsh']);
    assert.equal(JSON.stringify(status).includes('test-key'), false);
  } finally { await service.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('missing native Briq CLI reports unknown authentication', async () => {
  const service = new HomeServices({ env: { PATH: '/nonexistent' } });
  try {
    assert.deepEqual(await service.briqStatus(), { authenticated: null, login: { state: 'idle' } });
    assert.equal(service.status().dsh.enabled, false);
  } finally { await service.stop(); }
});
