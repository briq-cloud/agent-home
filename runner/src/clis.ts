import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One CLI the runner drives. Nothing else about a CLI is written anywhere in the runner. */
export interface Cli {
  name: string;
  /** Its ACP agent, speaking JSON-RPC on stdin and stdout. */
  acp: string[];
  /** The vendor's own sign-in, which the runner runs and reads the page's address and code from. */
  login?: string[];
  /** A sign-in that asks questions first (a provider to pick): the command to run in the terminal. */
  terminalLogin?: string;
  /**
   * API-key mode: the variables it reads a key from, as the home's team secrets give them. A CLI
   * whose only sign-in this is counts as signed in when one is set.
   */
  apiKeys?: string[];
  /**
   * Its ACP sign-in methods the home never offers: left out of its `initialize` answer, and an
   * `authenticate` with one refused. Gemini's Google sign-in with a personal account.
   */
  blockedAuth?: string[];
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
  {
    // Its own Zen and Go keys, Copilot and xAI by device code, ChatGPT by a headless code: a
    // provider to pick first.
    name: 'opencode',
    acp: ['opencode', 'acp'],
    terminalLogin: 'opencode auth login',
  },
  {
    // A Cline account by device code, or a provider's key: picked in its wizard.
    name: 'cline',
    acp: ['cline', '--acp'],
    terminalLogin: 'cline auth',
  },
  // API keys only: Google's consumer plans are not for a computer hosted for someone else, and Qwen
  // ended its free sign-in (2026-04). The image's system settings enforce it for Gemini.
  {
    name: 'gemini',
    acp: ['gemini', '--acp'],
    apiKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    // ACP's authenticate does not check the image's enforced type.
    blockedAuth: ['oauth-personal'],
  },
  {
    name: 'qwen',
    acp: ['qwen', '--acp'],
    apiKeys: ['QWENCLOUD_API_KEY', 'QWENCLOUD_TOKEN_PLAN_API_KEY', 'BAILIAN_CODING_PLAN_API_KEY', 'BAILIAN_TOKEN_PLAN_API_KEY'],
  },
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
  'XDG_DATA_HOME',
  'GEMINI_CLI_HOME',
  'QWEN_HOME',
  'CLINE_DIR',
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
  'OPENCODE_DISABLE_AUTOUPDATE',
  'CLINE_NO_AUTO_UPDATE',
  'BROWSER',
  // API-key mode, as placeholders.
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'CURSOR_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'QWENCLOUD_API_KEY',
  'QWENCLOUD_TOKEN_PLAN_API_KEY',
  'BAILIAN_CODING_PLAN_API_KEY',
  'BAILIAN_TOKEN_PLAN_API_KEY',
  'CLINE_API_KEY',
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
