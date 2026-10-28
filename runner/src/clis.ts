import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One CLI the runner drives. Nothing else about a CLI is written anywhere in the runner. */
export interface Cli {
  name: string;
  /** Its ACP agent, speaking JSON-RPC on stdin and stdout. */
  acp: string[];
  /** The vendor's own sign-in, run in a terminal. */
  login: string[];
  /** Asks whether its person is signed in: exit 0, or `"loggedIn": true` in what it prints. */
  status?: string[];
  /**
   * Its processes share one sign-in whose refresh token works once: two that refresh at the same
   * moment sign the person out. The runner starts its sessions one at a time, and lets one prompt
   * at a time make its first model call.
   */
  oneRefresher?: boolean;
  /** Where its sign-in says when it ends: read for its dates only, never its tokens. */
  signIn?: SignInDates;
}

/**
 * A sign-in file's dates. `$NAME` in `file` is the variable's value. A field is a number of
 * milliseconds or an ISO date. A sign-in either ends at a fixed time (`endsAt`, a new sign-in
 * moves it) or a set number of days after its last refresh (`refreshedAt` and `days`).
 */
export interface SignInDates {
  file: string;
  endsAt?: string;
  accessEndsAt?: string;
  refreshedAt?: string;
  days?: number;
  /** Days after its last refresh before a use refreshes it again: earlier, a refresh moves nothing. */
  refreshAfterDays?: number;
}

/** The adapters this package pins, for the two CLIs that have no ACP mode of their own. */
const BIN = fileURLToPath(new URL('../node_modules/.bin/', import.meta.url));

export const CLIS: Cli[] = [
  {
    name: 'claude',
    acp: [join(BIN, 'claude-agent-acp')],
    login: ['claude', 'auth', 'login'],
    status: ['claude', 'auth', 'status'],
    oneRefresher: true,
    // About 29 days from the sign-in, used or not; the access token lasts 8 hours (measured).
    signIn: { file: '$CLAUDE_CONFIG_DIR/.credentials.json', endsAt: 'refreshTokenExpiresAt', accessEndsAt: 'expiresAt' },
  },
  {
    name: 'codex',
    acp: [join(BIN, 'codex-acp')],
    login: ['codex', 'login', '--device-auth'],
    status: ['codex', 'login', 'status'],
    oneRefresher: true,
    // 30 days from the last refresh, each one a new 30 (OpenAI's token reference); Codex refreshes
    // on a use 8 days after the last (TOKEN_REFRESH_INTERVAL, codex-rs/login).
    signIn: { file: '$CODEX_HOME/auth.json', refreshedAt: 'last_refresh', days: 30, refreshAfterDays: 8 },
  },
  {
    name: 'copilot',
    acp: ['copilot', '--acp', '--stdio'],
    // Its default flow waits on a loopback callback, which a remote browser cannot reach.
    login: ['copilot', 'login', '--device-code'],
  },
  {
    name: 'cursor',
    acp: ['agent', 'acp'],
    login: ['agent', 'login'],
    status: ['agent', 'status'],
  },
  { name: 'grok', acp: ['grok', 'agent', 'stdio'], login: ['grok', 'login', '--device-auth'] },
  { name: 'vibe', acp: ['vibe-acp'], login: ['vibe', '--setup'] },
];

/** The CLIs, or `RUNNER_CLIS` (a JSON array of `Cli`) in their place: another CLI, or a test's. */
export function clis(env: NodeJS.ProcessEnv): Cli[] {
  return env.RUNNER_CLIS ? (JSON.parse(env.RUNNER_CLIS) as Cli[]) : CLIS;
}

/**
 * What a CLI's process may see of the runner's environment: names, never everything. A stray
 * variable (a briq secret, the runner's own token) stays out; a vendor's API key passes only
 * because the agent-home recipe takes one as a credential-gateway placeholder and nothing else.
 */
const KEEP = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'USER',
  'SHELL',
  'TMPDIR',
  // Where each CLI keeps its sign-in, on the home's volume.
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  'GROK_HOME',
  'VIBE_HOME',
  'XDG_CONFIG_HOME',
  // The credential gateway, and the CA it signs with.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // Self-update off, and links shown instead of opened.
  'DISABLE_AUTOUPDATER',
  'DISABLE_UPDATES',
  'COPILOT_AUTO_UPDATE',
  'GROK_DISABLE_AUTOUPDATER',
  'BROWSER',
  // API-key mode, as placeholders.
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'CURSOR_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
];

export function cliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEEP) if (env[name] !== undefined) out[name] = env[name] as string;
  // The adapters run the home's own binaries, never a copy of their own.
  const claude = which('claude', env.PATH);
  if (claude) out.CLAUDE_CODE_EXECUTABLE = claude;
  const codex = which('codex', env.PATH);
  if (codex) out.CODEX_PATH = codex;
  // Sign-in goes through the runner's terminal, never a browser on this machine.
  out.NO_BROWSER = '1';
  out.NO_OPEN_BROWSER = '1';
  return out;
}

export function which(name: string, path = ''): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return undefined;
}
