import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Cli } from './catalog.ts';

/** Owner metadata only. Vendor sign-ins stay in native config directories and are never imported. */
export type SubscriptionAccount = {
  id: string;
  label: string;
  enabled: boolean;
  priority: number;
  isDefault: boolean;
  harness: 'claude';
};
export type Account = SubscriptionAccount & { cli: string };
const fields = {
  label: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(1000),
};
export const createAccount = z
  .object({
    harness: z.literal('claude').optional(),
    label: fields.label,
    enabled: fields.enabled.optional(),
    priority: fields.priority.optional(),
  })
  .strict();
export const updateAccount = z
  .object({ label: fields.label.optional(), enabled: fields.enabled.optional(), priority: fields.priority.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const storedAccount = z.object({ id: z.string().regex(/^(default|[a-f0-9]{12})$/), ...fields }).strict();
const stored = z.object({ version: z.literal(1), accounts: z.array(storedAccount).max(9) }).strict();
const defaults = { id: 'default', label: 'Claude Code', enabled: true, priority: 0 };

export class Accounts {
  private readonly file: string;
  private readonly logins: string;
  constructor(options: { stateDir: string; logins: string }) {
    this.file = join(options.stateDir, 'accounts.json');
    this.logins = resolve(options.logins);
    this.read();
  }
  private read(): z.infer<typeof storedAccount>[] {
    if (!existsSync(this.file)) return [{ ...defaults }];
    if (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink() || lstatSync(this.file).size > 32768)
      throw Error('Invalid account metadata');
    chmodSync(this.file, 0o600);
    const value = stored.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    if (
      new Set(value.accounts.map((a) => a.id)).size !== value.accounts.length ||
      !value.accounts.some((a) => a.id === 'default')
    )
      throw Error('Invalid account metadata');
    return value.accounts;
  }
  list(): Account[] {
    return this.read().map((a) => ({
      ...a,
      harness: 'claude',
      isDefault: a.id === 'default',
      cli: a.id === 'default' ? 'claude' : `claude-account-${a.id}`,
    }));
  }
  create(raw: unknown): Account {
    const input = createAccount.parse(raw),
      accounts = this.read();
    if (accounts.length >= 9) throw Error('Account limit reached');
    let id: string;
    do {
      id = randomBytes(6).toString('hex');
    } while (accounts.some((a) => a.id === id));
    const account = { id, label: input.label, enabled: input.enabled ?? true, priority: input.priority ?? 100 };
    this.prepare(id);
    this.write([...accounts, account]);
    return this.list().find((a) => a.id === id)!;
  }
  update(id: string, raw: unknown): Account {
    const input = updateAccount.parse(raw),
      accounts = this.read();
    if (!accounts.some((a) => a.id === id)) throw Error('Unknown account');
    this.write(accounts.map((a) => (a.id === id ? { ...a, ...input } : a)));
    return this.list().find((a) => a.id === id)!;
  }
  private prepare(id: string): string {
    let directory = this.logins;
    for (const segment of ['accounts', id, 'claude']) {
      directory = join(directory, segment);
      if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()))
        throw Error('Account directory conflict');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    return directory;
  }
  /** Account aliases are native Claude instances, never API-key profiles. */
  clis(base: Cli, inherited: Record<string, string>): Cli[] {
    return this.list()
      .sort((a, b) => a.priority - b.priority || Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id))
      .map(({ cli, ...account }) => {
        if (account.isDefault) return { ...base, subscriptionAccount: account };
        const overrides: Record<string, string | null> = { ...base.env };
        // Strip endpoint, key and model overrides from every effective layer.
        for (const name of new Set([...Object.keys(inherited), ...Object.keys(overrides), ...SUBSCRIPTION_CLEAR]))
          if (/^(ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|USE_|SUBAGENT_MODEL))/.test(name) || SUBSCRIPTION_CLEAR.includes(name))
            overrides[name] = null;
        overrides.CLAUDE_CONFIG_DIR = this.prepare(account.id);
        return {
          ...base,
          name: cli,
          env: overrides,
          profile: undefined,
          apiKeys: undefined,
          keyFrom: undefined,
          subscriptionAccount: account,
        };
      });
  }
  private write(accounts: z.infer<typeof storedAccount>[]): void {
    const value = stored.parse({ version: 1, accounts });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      const fd = openSync(temporary, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file);
      const directory = openSync(dirname(this.file), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
const SUBSCRIPTION_CLEAR = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AGENT_HOME_PROVIDER_KEY',
];
