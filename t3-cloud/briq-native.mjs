import { mkdirSync, lstatSync, readlinkSync, symlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function briqMcpEndpoint(env = {}) {
  const validate = value => {
    let endpoint;
    if (typeof value !== 'string' || /[\x00-\x20\x7f?#]/.test(value) || /^https:\/\/[^/]*@/i.test(value))
      throw Error('Briq MCP requires an HTTPS endpoint without credentials, query or fragment');
    try { endpoint = new URL(value); } catch { throw Error('Briq MCP requires an HTTPS endpoint without credentials, query or fragment'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw Error('Briq MCP requires an HTTPS endpoint without credentials, query or fragment');
    return endpoint;
  };
  return validate(env.BRIQ_MCP_URL ?? new URL('/mcp', validate(env.BRIQ_API_URL ?? 'https://api.briq.cloud')).href).href;
}

// This is the only owner capability projected into the managed executing CLI.
// CLI login/config.json and native provider credentials are never consulted.
export function briqMcpCapability(env = {}) {
  const token = env.BRIQ_MCP_TOKEN;
  if (token === undefined || token === '') return {};
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(token)) throw Error('Invalid Briq MCP capability');
  return { BRIQ_MCP_TOKEN: token };
}

// The executing app-server receives this grant through briqMcpCapability only.
// Configuration, CLI login/status, allocation and supervised helpers do not need it.
export function withoutExecutingMcpEnvironment(env = {}) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'BRIQ_MCP_TOKEN'));
}

export function installBriqSkill(root, { managed = false } = {}) {
  const source = fileURLToPath(new URL('./skills/briq', import.meta.url));
  if (!statSync(join(source, 'SKILL.md')).isFile()) throw Error('Packaged Briq skill unavailable');
  if (managed) {
    for (const directory of [dirname(root), root]) {
      try {
        if (!lstatSync(directory).isDirectory()) throw Error('Managed Briq skill changed');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, 'briq');
  let existing;
  try { existing = lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!existing) symlinkSync(source, target, 'dir');
  else if (managed && (!existing.isSymbolicLink() || readlinkSync(target) !== source))
    throw Error('Managed Briq skill changed');
}
