import { randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { briqMcpEndpoint, briqMcpCapability, installBriqSkill } from './briq-native.mjs';

export const LEGACY_CODEX_CONFIG = 'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n[features]\nmulti_agent = false\n';
const PREFIX = '# t3-cloud managed Codex config v1\n' + LEGACY_CODEX_CONFIG +
  '\n[shell_environment_policy]\nignore_default_excludes = false\n[shell_environment_policy.filters]\nBRIQ_MCP_TOKEN = "exclude"\n';
const ENVIRONMENTS = 'default = "none"\ninclude_local = false\n';
function config(endpoint) {
  return PREFIX + (endpoint ? `\n[mcp_servers.briq]\nurl = ${JSON.stringify(endpoint)}\nbearer_token_env_var = "BRIQ_MCP_TOKEN"\n` : '');
}
function knownConfig(content) {
  if (content === LEGACY_CODEX_CONFIG || content === config()) return true;
  const match = content.match(/\nurl = ("[^\n]*")\n/);
  try {
    const endpoint = briqMcpEndpoint({ BRIQ_MCP_URL: JSON.parse(match?.[1]) });
    return content === config(endpoint);
  } catch { return false; }
}
async function existingFile(file) {
  try {
    if (!(await lstat(file)).isFile()) throw Error('Managed Codex configuration changed');
    return await readFile(file, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
}
async function replace(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

// Caller holds central.lock throughout configuration and the native process lifetime.
// Only the exact legacy baseline and this version's exact generated configs migrate.
export async function prepareExecutingCodex({ home, capability = {}, endpoint }) {
  const grant = briqMcpCapability(capability);
  const url = briqMcpEndpoint({ BRIQ_MCP_URL: endpoint });
  const desired = config(grant.BRIQ_MCP_TOKEN ? url : undefined);
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (!(await lstat(home)).isDirectory()) throw Error('Managed Codex configuration changed');
  const file = join(home, 'config.toml');
  const environments = join(home, 'environments.toml');
  const [current, currentEnvironments] = await Promise.all([existingFile(file), existingFile(environments)]);
  if ((current !== undefined && !knownConfig(current)) || (currentEnvironments !== undefined && currentEnvironments !== ENVIRONMENTS))
    throw Error('Managed Codex configuration changed');
  installBriqSkill(join(home, '.agents/skills'), { managed: true });
  if (current !== desired) await replace(file, desired);
  if (currentEnvironments === undefined) await replace(environments, ENVIRONMENTS);
  return { env: grant, status: grant.BRIQ_MCP_TOKEN ? 'configured-unverified' : 'unconfigured' };
}
