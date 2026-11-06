import { providerInstanceId, isThreadIdentifier } from './allocations.mjs';
import { bridgeOptions } from './edge-auth.mjs';
import { childFrontdoor } from './child-frontdoor.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

export async function startChild(sourceEnv = process.env, { spawnProcess = spawn, checkVersion = spawnSync, root = '/work', listen = { port: 8080, host: '0.0.0.0' } } = {}) {
const envInput = sourceEnv;
const state = `${root}/.t3`; const codexHome = `${root}/.codex-empty`;
const sourceOnly = envInput.T3_CLOUD_PURPOSE === 'project-source';
const binding = envInput.T3_CLOUD_BINDING_ID; const threadId = envInput.T3_CLOUD_THREAD_ID;
if (envInput.T3_CLOUD_ROLE !== 'child' || !/^[a-f0-9-]{36}$/.test(binding ?? '') ||
  (sourceOnly ? threadId !== undefined || envInput.T3_CLOUD_PROVIDER_INSTANCE_ID !== undefined || envInput.T3_CLOUD_EXEC_TOKEN_SHA256 !== undefined : !isThreadIdentifier(threadId) || !/^[a-f0-9]{64}$/.test(envInput.T3_CLOUD_EXEC_TOKEN_SHA256 ?? '')))
  throw Error('Invalid child allocation binding');
const provider = sourceOnly ? null : providerInstanceId(envInput.T3_CLOUD_PROVIDER_INSTANCE_ID);
const url = sourceOnly ? undefined : bridgeOptions(envInput).url;
const project = envInput.T3_CLOUD_SOURCE_ID ? { sourceId: envInput.T3_CLOUD_SOURCE_ID, sourceDigest: envInput.T3_CLOUD_SOURCE_DIGEST, projectId: envInput.T3_CLOUD_PROJECT_ID, workspaceRoot: envInput.T3_CLOUD_PROJECT_ROOT, ownerGeneration: envInput.T3_CLOUD_OWNER_GENERATION, ...(sourceOnly ? {} : { launchDigest: envInput.T3_CLOUD_LAUNCH_DIGEST }) } : undefined;
if (sourceOnly && !project || project && (!/^[a-zA-Z0-9_-]{16,128}$/.test(project.sourceId) || !/^[a-f0-9]{64}$/.test(project.sourceDigest ?? '') || !/^[a-zA-Z0-9_-]{1,128}$/.test(project.projectId ?? '') || project.workspaceRoot !== `/work/projects/${project.sourceId}` || !/^[a-zA-Z0-9_-]{1,128}$/.test(project.ownerGeneration ?? '') || !sourceOnly && !/^[a-f0-9]{64}$/.test(project.launchDigest ?? ''))) throw Error('Invalid child project binding');
for (const directory of [state, `${state}/userdata`, `${state}/home`, codexHome]) await mkdir(directory, { recursive: true, mode: 0o700 });
const stamp = JSON.stringify({ binding, ...(sourceOnly ? { purpose: 'project-source' } : { threadId, providerInstanceId: provider }), ...(project ? { project } : {}) });
try { await writeFile(`${state}/briq-binding.json`, stamp, { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; const prior = JSON.parse(await readFile(`${state}/briq-binding.json`, 'utf8')); if (prior.binding !== binding || prior.threadId !== threadId || (sourceOnly ? prior.purpose !== 'project-source' : providerInstanceId(prior.providerInstanceId) !== provider) || JSON.stringify(prior.project) !== JSON.stringify(project)) throw Error('Child volume belongs to another allocation'); }
const settings = { providerInstances: {
  codex: { driver: 'codex', enabled: provider === 'codex', config: { setupMode: 'existing', binaryPath: '/opt/t3-cloud/bin/codex-remote', homePath: codexHome, shadowHomePath: '', launchArgs: '' } },
  claudeAgent: { driver: 'claudeAgent', enabled: provider === 'claudeAgent' },
} };
// A fresh private native state is intentional; provider settings cannot select a real app-server.
await writeFile(`${state}/userdata/settings.json`, JSON.stringify(settings), { mode: 0o600 });
// No cloud keys, vendor login homes, or inherited MCP configuration enter either child runtime.
const env = { HOME: `${state}/home`, CODEX_HOME: codexHome, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
  T3_CLOUD_ROLE: 'child', T3_CLOUD_PROVIDER_INSTANCE_ID: provider, T3_CLOUD_THREAD_ID: threadId, T3_CLOUD_BINDING_ID: binding,
  ...(sourceOnly ? { T3_CLOUD_PURPOSE: 'project-source' } : { T3_CLOUD_BRIDGE_URL: url, T3_CLOUD_BRIDGE_TOKEN: envInput.T3_CLOUD_BRIDGE_TOKEN, T3_CLOUD_EDGE_TOKEN: envInput.T3_CLOUD_EDGE_TOKEN }),
  ...(project ? { T3_CLOUD_SOURCE_ID: project.sourceId, T3_CLOUD_SOURCE_DIGEST: project.sourceDigest, T3_CLOUD_PROJECT_ID: project.projectId, T3_CLOUD_PROJECT_ROOT: project.workspaceRoot, T3_CLOUD_OWNER_GENERATION: project.ownerGeneration, ...(sourceOnly ? {} : { T3_CLOUD_LAUNCH_DIGEST: project.launchDigest }) } : {}),
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'https', GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'http.followRedirects', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'submodule.recurse', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '' };
if (sourceOnly) { delete env.T3_CLOUD_PROVIDER_INSTANCE_ID; delete env.T3_CLOUD_THREAD_ID; }
const checked = sourceOnly ? { status: 0, stdout: 'codex-cli 0.166.0' } : checkVersion('codex', ['--version'], { env: { HOME: env.HOME, CODEX_HOME: codexHome, PATH: env.PATH, LANG: env.LANG }, encoding: 'utf8', timeout: 15000 });
if (checked.status !== 0 || checked.stdout.trim() !== 'codex-cli 0.166.0') throw Error('Codex 0.166.0 required');
const executorEnv = { HOME: env.HOME, CODEX_HOME: codexHome, PATH: env.PATH, LANG: env.LANG };
const frontdoor = childFrontdoor({ publicOrigin: envInput.T3_CLOUD_PUBLIC_ORIGIN, execTokenHash: sourceOnly ? undefined : envInput.T3_CLOUD_EXEC_TOKEN_SHA256 });
const children = [];
let shuttingDown = false;
function shutdown(code) { if (shuttingDown) return; shuttingDown = true; process.exitCode = code; void frontdoor.close(); for (const child of children) child.kill('SIGTERM'); }
for (const [command, args, environment] of [
  ... (sourceOnly ? [] : [['codex', ['exec-server', '--listen', 'ws://127.0.0.1:3774', '--ws-auth', 'capability-token', '--ws-token-sha256', envInput.T3_CLOUD_EXEC_TOKEN_SHA256], executorEnv]]),
  ['/opt/t3/t3', ['serve', '--host', '127.0.0.1', '--port', '3773', '--base-dir', state, '--no-browser', root], env],
]) {
  const child = spawnProcess(command, args, { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'ignore'] });
  children.push(child); child.once('error', () => shutdown(1)); child.once('exit', () => shutdown(shuttingDown ? process.exitCode ?? 0 : 1));
}
await new Promise((resolve, reject) => { frontdoor.server.once('error', reject); frontdoor.server.listen(listen, resolve); }).catch(error => { shutdown(1); throw error; });
if (shuttingDown) { await frontdoor.close(); throw Error('Child runtime exited during startup'); }
return { close: () => shutdown(0), children };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const runtime = await startChild();
  process.once('SIGTERM', runtime.close); process.once('SIGINT', runtime.close);
}
