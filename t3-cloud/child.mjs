import { childFrontdoor } from './child-frontdoor.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

export async function startChild(sourceEnv = process.env, { spawnProcess = spawn, checkVersion = spawnSync, root = '/work' } = {}) {
const envInput = sourceEnv;
const state = `${root}/.t3`; const codexHome = `${root}/.codex-empty`;
const binding = envInput.T3_CLOUD_BINDING_ID; const threadId = envInput.T3_CLOUD_THREAD_ID;
if (envInput.T3_CLOUD_ROLE !== 'child' || !/^[a-f0-9-]{36}$/.test(binding ?? '') ||
  !/^[a-zA-Z0-9_-]{1,128}$/.test(threadId ?? '') || !/^[a-f0-9]{64}$/.test(envInput.T3_CLOUD_EXEC_TOKEN_SHA256 ?? ''))
  throw Error('Invalid child allocation binding');
const url = new URL(envInput.T3_CLOUD_BRIDGE_URL);
if (url.protocol !== 'wss:' || !envInput.T3_CLOUD_BRIDGE_TOKEN) throw Error('Missing child capability');
for (const directory of [state, `${state}/userdata`, `${state}/home`, codexHome]) await mkdir(directory, { recursive: true, mode: 0o700 });
const stamp = JSON.stringify({ binding, threadId });
try { await writeFile(`${state}/briq-binding.json`, stamp, { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; if (await readFile(`${state}/briq-binding.json`, 'utf8') !== stamp) throw Error('Child volume belongs to another allocation'); }
const settings = { providerInstances: {
  codex: { driver: 'codex', enabled: true, config: { setupMode: 'existing', binaryPath: '/opt/t3-cloud/bin/codex-remote', homePath: codexHome, shadowHomePath: '', launchArgs: '' } },
  claudeAgent: { driver: 'claudeAgent', enabled: false },
} };
// A fresh private native state is intentional; provider settings cannot select a real app-server.
await writeFile(`${state}/userdata/settings.json`, JSON.stringify(settings), { mode: 0o600 });
// No cloud keys, vendor login homes, or inherited MCP configuration enter either child runtime.
const env = { HOME: `${state}/home`, CODEX_HOME: codexHome, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
  T3_CLOUD_ROLE: 'child', T3_CLOUD_THREAD_ID: threadId, T3_CLOUD_BINDING_ID: binding,
  T3_CLOUD_BRIDGE_URL: url.href, T3_CLOUD_BRIDGE_TOKEN: envInput.T3_CLOUD_BRIDGE_TOKEN };
const checked = checkVersion('codex', ['--version'], { env, encoding: 'utf8', timeout: 15000 });
if (checked.status !== 0 || checked.stdout.trim() !== 'codex-cli 0.166.0') throw Error('Codex 0.166.0 required');
const executorEnv = { HOME: env.HOME, CODEX_HOME: codexHome, PATH: env.PATH, LANG: env.LANG };
const frontdoor = childFrontdoor({ publicOrigin: envInput.T3_CLOUD_PUBLIC_ORIGIN, execTokenHash: envInput.T3_CLOUD_EXEC_TOKEN_SHA256 });
const children = [];
let shuttingDown = false;
function shutdown(code) { if (shuttingDown) return; shuttingDown = true; process.exitCode = code; void frontdoor.close(); for (const child of children) child.kill('SIGTERM'); }
for (const [command, args, environment] of [
  ['codex', ['exec-server', '--listen', 'ws://127.0.0.1:3774', '--ws-auth', 'capability-token', '--ws-token-sha256', envInput.T3_CLOUD_EXEC_TOKEN_SHA256], executorEnv],
  ['/opt/t3/t3', ['serve', '--host', '127.0.0.1', '--port', '3773', '--base-dir', state, '--no-browser', root], env],
]) {
  const child = spawnProcess(command, args, { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'ignore'] });
  children.push(child); child.once('error', () => shutdown(1)); child.once('exit', () => shutdown(shuttingDown ? process.exitCode ?? 0 : 1));
}
await new Promise((resolve, reject) => { frontdoor.server.once('error', reject); frontdoor.server.listen(8080, '0.0.0.0', resolve); }).catch(error => { shutdown(1); throw error; });
return { close: () => shutdown(0), children };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const runtime = await startChild();
  process.once('SIGTERM', runtime.close); process.once('SIGINT', runtime.close);
}
