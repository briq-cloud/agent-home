import { readFileSync } from 'node:fs';
import type { SignInDates } from './clis.ts';

/** What `/status` says of a sign-in's life. */
export interface SignInLife {
  /** When it ends unless renewed: ISO. */
  endsAt?: string;
  /** Whether a refresh moves `endsAt` (`POST /refresh/<cli>`), or only a new sign-in does. */
  renews: boolean;
  /** Ends within a week. */
  endsSoon: boolean;
  /** The access token's end, when the file says: the next use refreshes after it. */
  accessEndsAt?: string;
  /** From when a use, or `POST /refresh/<cli>`, refreshes it: before, the CLI does not. */
  refreshableAt?: string;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * Reads the dates of a sign-in file, field by field from its text: the tokens beside them are
 * never parsed, kept or returned. `undefined` when the file or a date is not there.
 */
export function signInLife(dates: SignInDates, env: Record<string, string | undefined>, now = Date.now()): SignInLife | undefined {
  const file = dates.file.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name: string) => env[name] ?? '');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const at = (field: string | undefined): number | undefined => {
    if (!field) return undefined;
    const m = new RegExp(`"${field}"\\s*:\\s*("([^"]*)"|(\\d+))`).exec(text);
    if (!m) return undefined;
    const t = m[3] !== undefined ? Number(m[3]) : Date.parse(m[2] ?? '');
    return Number.isFinite(t) && t > 0 ? t : undefined;
  };
  const refreshed = at(dates.refreshedAt);
  const ends = at(dates.endsAt) ?? (refreshed !== undefined && dates.days ? refreshed + dates.days * 86_400_000 : undefined);
  if (ends === undefined) return undefined;
  const access = at(dates.accessEndsAt);
  return {
    endsAt: new Date(ends).toISOString(),
    renews: dates.endsAt === undefined,
    endsSoon: ends - now < WEEK_MS,
    ...(access !== undefined ? { accessEndsAt: new Date(access).toISOString() } : {}),
    ...(refreshed !== undefined && dates.refreshAfterDays
      ? { refreshableAt: new Date(refreshed + dates.refreshAfterDays * 86_400_000).toISOString() }
      : {}),
  };
}
