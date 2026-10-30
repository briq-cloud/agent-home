import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Rpc } from '../acp/agent.ts';

/** Token counts as ACP reports them (`Usage`, unstable): totals for a session so far. */
export interface Tokens {
  input: number;
  output: number;
  cachedRead: number;
  cachedWrite: number;
  thought: number;
  total: number;
}

/** A cost the CLI reports, at its API price: notional on a subscription. */
export interface Cost {
  amount: number;
  currency: string;
}

export interface CliUsage {
  name: string;
  sessions: number;
  turns: number;
  tokens: Tokens;
  cost?: Cost;
  /** By UTC day of the turn's end: what that day's turns added. */
  days: Record<string, { turns: number; tokens: Tokens; cost?: Cost }>;
  /**
   * What the CLI last said of its plan's limits, as it said it: a `_meta` entry of a
   * `usage_update` whose key names a rate limit or quota (Claude: `_claude/rateLimit`).
   */
  limits?: { key: string; value: unknown; at?: string };
}

export interface SessionUsage {
  id: string;
  cli: string;
  turns: number;
  lastTurnAt?: string;
  tokens: Tokens;
  cost?: Cost;
  /** How full its context is: `used` of `size` tokens. */
  context?: { used: number; size: number };
}

const zero = (): Tokens => ({ input: 0, output: 0, cachedRead: 0, cachedWrite: 0, thought: 0, total: 0 });

function tokensOf(u: Record<string, unknown> | undefined): Tokens | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return {
    input: n('inputTokens'),
    output: n('outputTokens'),
    cachedRead: n('cachedReadTokens'),
    cachedWrite: n('cachedWriteTokens'),
    thought: n('thoughtTokens'),
    total: n('totalTokens'),
  };
}

function add(a: Tokens, b: Tokens, sign = 1): Tokens {
  return {
    input: a.input + sign * b.input,
    output: a.output + sign * b.output,
    cachedRead: a.cachedRead + sign * b.cachedRead,
    cachedWrite: a.cachedWrite + sign * b.cachedWrite,
    thought: a.thought + sign * b.thought,
    total: a.total + sign * b.total,
  };
}

function addCost(a: Cost | undefined, amount: number, currency: string): Cost {
  return { amount: (a?.amount ?? 0) + amount, currency: a?.currency ?? currency };
}

/**
 * What the home's sessions used, read from the runner's logs: tokens and cost as the CLIs report
 * them (each a session's running total, so a turn's share is the difference with the turn
 * before), the number of turns, and the last word of each CLI on its plan's limits. `noCost`: the
 * CLIs whose cost is not what they report, profiles priced by Claude Code at Anthropic's prices.
 */
export function usageReport(
  stateDir: string,
  clis: string[],
  noCost = new Set<string>(),
): { clis: CliUsage[]; sessions: SessionUsage[] } {
  const out: CliUsage[] = [];
  const sessions: SessionUsage[] = [];
  for (const cli of clis) {
    const total: CliUsage = { name: cli, sessions: 0, turns: 0, tokens: zero(), days: {} };
    let files: string[] = [];
    try {
      files = readdirSync(join(stateDir, 'sessions', cli)).filter((f) => f.endsWith('.jsonl'));
    } catch {}
    for (const file of files) {
      const s: SessionUsage = { id: file.replace(/\.jsonl$/, ''), cli, turns: 0, tokens: zero() };
      let cost: { amount: number; currency: string } | undefined;
      let costCounted = 0;
      let lines: string[] = [];
      try {
        lines = readFileSync(join(stateDir, 'sessions', cli, file), 'utf8').split('\n');
      } catch {}
      for (const line of lines) {
        if (!line) continue;
        let m: Rpc;
        try {
          m = JSON.parse(line) as Rpc;
        } catch {
          continue;
        }
        const p = m.params ?? {};
        if (m.method === 'session/update' && p.update?.sessionUpdate === 'usage_update') {
          const u = p.update;
          if (typeof u.used === 'number' && typeof u.size === 'number') s.context = { used: u.used, size: u.size };
          if (!noCost.has(cli) && u.cost && typeof u.cost.amount === 'number')
            cost = { amount: u.cost.amount, currency: u.cost.currency ?? 'USD' };
          for (const [key, value] of Object.entries((u._meta ?? {}) as Record<string, unknown>))
            if (/rate.?limit|quota/i.test(key) && value)
              total.limits = { key, value, ...(s.lastTurnAt ? { at: s.lastTurnAt } : {}) };
        } else if (m.method === '_runner/turn' && p.state === 'idle' && p.stopReason !== 'cancelled' && p.at) {
          s.turns++;
          s.lastTurnAt = p.at;
          const day = String(p.at).slice(0, 10);
          const bucket = (total.days[day] ??= { turns: 0, tokens: zero() });
          bucket.turns++;
          const now = tokensOf(p.usage);
          if (now) {
            bucket.tokens = add(bucket.tokens, add(now, s.tokens, -1));
            s.tokens = now;
          }
          if (cost && cost.amount > costCounted) {
            bucket.cost = addCost(bucket.cost, cost.amount - costCounted, cost.currency);
            costCounted = cost.amount;
          }
        }
      }
      if (cost) s.cost = cost;
      total.sessions++;
      total.turns += s.turns;
      total.tokens = add(total.tokens, s.tokens);
      if (cost) total.cost = addCost(total.cost, cost.amount, cost.currency);
      sessions.push(s);
    }
    out.push(total);
  }
  sessions.sort((a, b) => (b.lastTurnAt ?? '').localeCompare(a.lastTurnAt ?? ''));
  return { clis: out, sessions };
}
