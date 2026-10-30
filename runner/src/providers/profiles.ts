import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Cli } from './catalog.ts';

/**
 * A provider the person brings a key for, and the harnesses that can use it: Claude Code on an
 * Anthropic-compatible endpoint, Codex on one that serves OpenAI's Responses API (the only API
 * Codex speaks since 2026-02), or a CLI of its own.
 */
export interface Provider {
  id: string;
  name: string;
  /** A monthly plan sold as a key, or billed by use. */
  billing: 'plan' | 'use';
  claude?: {
    baseUrl: string;
    /** `token`: `ANTHROPIC_AUTH_TOKEN` (a bearer); `key`: `ANTHROPIC_API_KEY`. As each one's docs say. */
    auth: 'token' | 'key';
    /** Without a model, the provider maps Claude's names to its own. */
    needsModel: boolean;
  };
  codex?: { baseUrl: string };
  /** A CLI of the home that takes the key itself, and the variable it reads it from. */
  cli?: { name: string; env: string };
  /** A model's name, shown as an example: models change faster than this table. */
  example?: string;
}

export const PROVIDERS: Provider[] = [
  {
    id: 'zai',
    name: 'GLM Coding Plan (Z.ai)',
    billing: 'plan',
    claude: { baseUrl: 'https://api.z.ai/api/anthropic', auth: 'token', needsModel: false },
    example: 'glm-5.3',
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    billing: 'plan',
    claude: { baseUrl: 'https://api.kimi.com/coding/', auth: 'key', needsModel: true },
    example: 'k3.1-pro',
  },
  {
    id: 'minimax',
    name: 'MiniMax Token Plan',
    billing: 'plan',
    claude: { baseUrl: 'https://api.minimax.io/anthropic', auth: 'token', needsModel: true },
    example: 'MiniMax-M3.1-Flash',
  },
  {
    id: 'alibaba',
    name: 'Alibaba Coding Plan',
    billing: 'plan',
    claude: { baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic', auth: 'token', needsModel: true },
    example: 'qwen3.5-plus',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    billing: 'use',
    claude: { baseUrl: 'https://api.deepseek.com/anthropic', auth: 'key', needsModel: false },
    example: 'deepseek-v4-pro',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    billing: 'use',
    claude: { baseUrl: 'https://openrouter.ai/api', auth: 'token', needsModel: true },
    codex: { baseUrl: 'https://openrouter.ai/api/v1' },
    example: 'vendor/model, from openrouter.ai/models',
  },
  { id: 'google', name: 'Gemini API', billing: 'use', cli: { name: 'gemini', env: 'GEMINI_API_KEY' } },
];

export type Harness = 'claude' | 'codex';

/** A provider run by a harness: a CLI of its own in the runner, `<provider>-<harness>`. */
export interface Profile {
  name: string;
  provider: string;
  harness: Harness;
  model?: string;
  /** Exact catalog version, approved for automatic selection by the home's operator. */
  canonical?: string;
  autoEligible?: boolean;
}

/** The variable a Codex profile reads its key from: its config names it, nothing else does. */
const CODEX_KEY = 'AGENT_HOME_PROVIDER_KEY';

/**
 * The person's keys and profiles, on the home's volume: keys in one file only its owner reads,
 * never sent back by the API; profiles beside the runner's state.
 */
export class Keys {
  private readonly keysFile: string;
  private readonly profilesFile: string;
  private readonly logins: string;

  constructor(opts: { keysFile: string; profilesFile: string; logins: string }) {
    this.keysFile = opts.keysFile;
    this.profilesFile = opts.profilesFile;
    this.logins = opts.logins;
  }

  key(provider: string): string | undefined {
    return this.read<Record<string, string>>(this.keysFile, {})[provider];
  }

  /** The providers with a key. */
  set(): string[] {
    return Object.keys(this.read<Record<string, string>>(this.keysFile, {}));
  }

  putKey(provider: string, key: string | undefined): void {
    const keys = this.read<Record<string, string>>(this.keysFile, {});
    if (key) keys[provider] = key;
    else delete keys[provider];
    this.write(this.keysFile, keys);
  }

  profiles(): Profile[] {
    return this.read<Profile[]>(this.profilesFile, []);
  }

  putProfile(p: Profile): void {
    this.write(this.profilesFile, [...this.profiles().filter((q) => q.name !== p.name), p]);
  }

  dropProfile(name: string): void {
    this.write(
      this.profilesFile,
      this.profiles().filter((q) => q.name !== name),
    );
  }

  /**
   * A profile as a CLI: its harness's ACP agent with the provider's endpoint and key, in a
   * settings folder of its own. Never the person's own Claude or Codex folder: the harness would
   * send their subscription's token to another vendor.
   */
  cliOf(p: Profile, harnessCli: Cli): Cli {
    const provider = providerOf(p.provider);
    const key = this.key(p.provider) ?? '';
    const home = join(this.logins, 'profiles', p.name);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const base = {
      name: p.name,
      acp: harnessCli.acp,
      profile: { provider: p.provider, harness: p.harness, ...(p.model ? { model: p.model } : {}) },
    };
    if (p.harness === 'claude') {
      const c = provider.claude as NonNullable<Provider['claude']>;
      const models = p.model
        ? Object.fromEntries(
            [
              'ANTHROPIC_MODEL',
              'ANTHROPIC_DEFAULT_FABLE_MODEL',
              'ANTHROPIC_DEFAULT_OPUS_MODEL',
              'ANTHROPIC_DEFAULT_SONNET_MODEL',
              'ANTHROPIC_DEFAULT_HAIKU_MODEL',
              'CLAUDE_CODE_SUBAGENT_MODEL',
            ].map((n) => [n, p.model as string]),
          )
        : {};
      return {
        ...base,
        env: {
          CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_BASE_URL: c.baseUrl,
          ANTHROPIC_AUTH_TOKEN: c.auth === 'token' ? key : null,
          ANTHROPIC_API_KEY: c.auth === 'key' ? key : null,
          ...models,
          // Nothing of Anthropic's (telemetry, update checks) with another vendor's key.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          API_TIMEOUT_MS: '3000000',
        },
      };
    }
    const c = provider.codex as NonNullable<Provider['codex']>;
    // Codex reads a custom provider from its user config only.
    writeFileSync(
      join(home, 'config.toml'),
      [
        `model = ${JSON.stringify(p.model ?? '')}`,
        `model_provider = ${JSON.stringify(p.provider)}`,
        '',
        `[model_providers.${p.provider}]`,
        `name = ${JSON.stringify(provider.name)}`,
        `base_url = ${JSON.stringify(c.baseUrl)}`,
        `env_key = "${CODEX_KEY}"`,
        'wire_api = "responses"',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    return { ...base, env: { CODEX_HOME: home, [CODEX_KEY]: key, OPENAI_API_KEY: null, CODEX_API_KEY: null } };
  }

  private read<T>(file: string, fallback: T): T {
    if (!existsSync(file)) return fallback;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  /** Whole or not at all: a new file, then a rename over the old one. */
  private write(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
}

export function providerOf(id: string): Provider {
  const p = PROVIDERS.find((q) => q.id === id);
  if (!p) throw new Error(`no provider named ${id}`);
  return p;
}

/** A profile the person asks for, checked against the table: its name, or why it cannot be. */
export function profileFor(provider: unknown, harness: unknown, model: unknown): Profile | string {
  const p = PROVIDERS.find((q) => q.id === provider);
  if (!p) return `no provider named ${String(provider)}: ${PROVIDERS.map((q) => q.id).join(', ')}`;
  if (harness === undefined || harness === 'auto') harness = p.claude ? 'claude' : 'codex';
  if (model === 'auto') model = undefined;
  if (!model && p.id === 'openrouter') model = 'openrouter/auto';
  if (!model && p.claude?.needsModel && p.id !== 'openrouter') model = p.example;
  if (harness !== 'claude' && harness !== 'codex')
    return `harness is claude or codex${p.cli ? `; ${p.id}'s key goes to ${p.cli.name} itself` : ''}`;
  if (!p[harness])
    return `${p.name} has no endpoint ${harness === 'codex' ? 'that serves the Responses API, which Codex needs' : 'for Claude Code'}`;
  if (model !== undefined && (typeof model !== 'string' || !/^[\w./:@[\]-]{1,128}$/.test(model)))
    return 'model is a model name';
  const needsModel = harness === 'codex' || Boolean(p.claude?.needsModel);
  if (needsModel && !model)
    return `${p.name} needs a model with ${harness}${p.example ? `, such as ${p.example}` : ''}`;
  return { name: `${p.id}-${harness}`, provider: p.id, harness, ...(model ? { model: model as string } : {}) };
}
