import type { Keys, Profile } from './profiles.ts';

export const DEFAULT_AUTO_PROFILE = 'openrouter-claude-haiku';
export const AUTO_POOL_SOURCE = 'curated starting pool; catalog priors, not learned best';
export const CURATED_AUTO_MODELS = [
  { name: 'openrouter-claude-sonnet', model: 'anthropic/claude-sonnet-5.5' },
  { name: DEFAULT_AUTO_PROFILE, model: 'anthropic/claude-haiku-5.5' },
  { name: 'openrouter-claude-deepseek', model: 'deepseek/deepseek-v4.1-flash-1017' },
  { name: 'openrouter-claude-glm', model: 'z-ai/glm-5.3' },
] as const;
export type AutoProfilePreparation = {
  created: Profile[];
  unavailable: { name: string; model: string; reason: string }[];
  source: typeof AUTO_POOL_SOURCE;
};
type Options = {
  keys: Pick<Keys, 'profiles' | 'putProfile'>;
  claudeAvailable: boolean;
  fetcher?: typeof fetch;
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const positive = (value: unknown): boolean => {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value))
  )
    return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
};
function metadata(row: Record<string, unknown>): { canonical: string } | { reason: string } {
  if (typeof row.canonical_slug !== 'string' || !row.canonical_slug.trim() || row.canonical_slug.length > 256)
    return { reason: 'exact canonical version unavailable' };
  if (!Number.isSafeInteger(row.context_length) || (row.context_length as number) < 16_000)
    return { reason: 'catalog context is unknown or below 16000 tokens' };
  const modalities = object(row.architecture).input_modalities;
  if (!Array.isArray(modalities) || !modalities.includes('text')) return { reason: 'catalog text input unavailable' };
  if (!Array.isArray(row.supported_parameters) || !row.supported_parameters.includes('tools'))
    return { reason: 'catalog tool calling unavailable' };
  const pricing = object(row.pricing);
  if (!positive(pricing.prompt) || !positive(pricing.completion))
    return { reason: 'positive input/output prices unavailable' };
  if (row.expiration_date !== undefined && row.expiration_date !== null) {
    if (typeof row.expiration_date !== 'string' || !Number.isFinite(Date.parse(row.expiration_date)))
      return { reason: 'catalog retirement metadata invalid' };
    if (Date.parse(row.expiration_date) <= Date.now()) return { reason: 'catalog model retired' };
  }
  return { canonical: row.canonical_slug };
}

/**
 * The operator's Save Auto action approves this small curated pool. This helper
 * reads public metadata only: no key access, inference, compatibility probe or
 * claim that a model is quality-tested with this harness. A model being listed
 * does not establish account credit, permissions or successful tool execution.
 * Existing profile names always remain owned by the operator.
 */
export async function prepareAutoProfiles({
  keys,
  claudeAvailable,
  fetcher = fetch,
}: Options): Promise<AutoProfilePreparation> {
  const result: AutoProfilePreparation = { created: [], unavailable: [], source: AUTO_POOL_SOURCE };
  const existing = new Set(keys.profiles().map((profile) => profile.name));
  const missing = CURATED_AUTO_MODELS.filter((model) => !existing.has(model.name));
  if (!missing.length) return result;
  const unavailable = (reason: string) => {
    result.unavailable.push(...missing.map(({ name, model }) => ({ name, model, reason })));
    return result;
  };
  if (!claudeAvailable) return unavailable('Claude ACP harness unavailable');
  let rows: unknown[];
  try {
    const response = await fetcher('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) return unavailable(`public catalog unavailable (HTTP ${response.status})`);
    const raw = object(await response.json());
    if (!Array.isArray(raw.data)) return unavailable('public catalog response invalid');
    rows = raw.data;
  } catch {
    return unavailable('public catalog request failed or timed out');
  }
  for (const candidate of missing) {
    // Re-read after the network await: a concurrent manual edit wins.
    if (keys.profiles().some((profile) => profile.name === candidate.name)) continue;
    const matches = rows.map(object).filter((row) => row.id === candidate.model);
    if (matches.length !== 1) {
      result.unavailable.push({
        ...candidate,
        reason: matches.length ? 'exact catalog model is ambiguous' : 'exact model absent from public catalog',
      });
      continue;
    }
    const valid = metadata(matches[0]!);
    if ('reason' in valid) {
      result.unavailable.push({ ...candidate, reason: valid.reason });
      continue;
    }
    const profile: Profile = {
      name: candidate.name,
      provider: 'openrouter',
      harness: 'claude',
      model: candidate.model,
      canonical: valid.canonical,
      autoEligible: true,
    };
    try {
      keys.putProfile(profile);
      result.created.push(profile);
    } catch {
      result.unavailable.push({ ...candidate, reason: 'profile persistence failed' });
    }
  }
  return result;
}
