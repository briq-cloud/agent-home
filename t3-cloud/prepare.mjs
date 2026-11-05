import { mkdirSync, existsSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function prepare(env = process.env, run = spawnSync) {
  for (const key of ['T3_CWD', 'T3_STATE', 'HOME', 'T3_LOGINS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    'COPILOT_HOME', 'GROK_HOME', 'VIBE_HOME', 'XDG_CONFIG_HOME', 'GEMINI_CLI_HOME', 'BRIQ_CONFIG_DIR']) {
    if (!env[key] || !isAbsolute(env[key])) throw Error(`${key} must be an absolute path`);
    mkdirSync(env[key], { recursive: true, mode: 0o700 });
  }
  // Seed vendor update settings only for fresh native homes; owner settings win.
  mkdirSync(join(env.XDG_CONFIG_HOME, 'cursor'), { recursive: true, mode: 0o700 });
  for (const [path, content] of [
    [join(env.XDG_CONFIG_HOME, 'cursor/cli-config.json'), JSON.stringify({ version: 1, editor: { vimMode: false }, permissions: { allow: [], deny: [] }, channel: 'static' })],
    [join(env.VIBE_HOME, 'config.toml'), 'enable_update_checks = false\n'],
  ]) {
    try { writeFileSync(path, content, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const endpoint = new URL(env.BRIQ_MCP_URL ?? new URL('/mcp', env.BRIQ_API_URL ?? 'https://api.briq.cloud'));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw Error('Briq MCP requires an HTTPS endpoint without credentials, query or fragment');
  // Native commands own their config schema and preserve any existing Briq definition.
  // No model requests, sign-in probes, credential reads, or token literals are needed.
  const nativeEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('T3_CLOUD_')));
  const invoke = (command, args, inspect = false) => run(command, args, { env: nativeEnv,
    stdio: inspect ? ['ignore', 'pipe', 'pipe'] : 'ignore', encoding: 'utf8', maxBuffer: 65536, timeout: 15000 });
  const absent = {
    codex: "Error: No MCP server named 'briq' found.",
    claude: 'No MCP server named "briq". Run `claude mcp add` to add one.',
  };
  for (const [command, args] of [
    ['codex', ['mcp', 'add', 'briq', '--url', endpoint.href, '--bearer-token-env-var', 'BRIQ_MCP_TOKEN']],
    ['claude', ['mcp', 'add-json', '--scope', 'user', 'briq', JSON.stringify({ type: 'http', url: endpoint.href,
      headers: { Authorization: 'Bearer ${BRIQ_MCP_TOKEN}' } })]],
  ]) {
    const existing = invoke(command, ['mcp', 'get', 'briq'], true);
    if (existing.error || existing.signal || existing.status === null) throw Error(`${command} MCP configuration unavailable`);
    if (existing.status !== 0) {
      // Unknown failures (including malformed owner config) never authorize a write.
      // A future CLI wording change fails closed and can be qualified with its image build.
      if (existing.status !== 1 || existing.stdout?.trim() || existing.stderr?.trim() !== absent[command])
        throw Error(`${command} MCP configuration unavailable`);
      const result = invoke(command, args);
      if (result.error || result.status !== 0) throw Error(`${command} Briq MCP configuration failed`);
    }
  }
  const source = fileURLToPath(new URL('./skills/briq', import.meta.url));
  for (const root of [join(env.HOME, '.agents/skills'), join(env.CLAUDE_CONFIG_DIR, 'skills')]) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = join(root, 'briq');
    // Do not replace a user's skill, including dangling symbolic links.
    let present = existsSync(target);
    try { present ||= Boolean(lstatSync(target)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!present) symlinkSync(source, target, 'dir');
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) prepare();
