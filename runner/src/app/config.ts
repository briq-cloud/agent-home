import { resolve } from 'node:path';
import { z } from 'zod';
import { validateDeploymentContext } from '../extensions/index.ts';
export function configuration(env: NodeJS.ProcessEnv) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw Error(`${name} must be ${min}..${max}`);
    return value;
  };
  const flag = (name: string, fallback: boolean) => {
    if (env[name] === undefined) return fallback;
    if (!['0', '1'].includes(env[name]!)) throw Error(`${name} must be 0 or 1`);
    return env[name] === '1';
  };
  const maxTurns = integer('RUNNER_MAX_TURNS', 2, 1, 32);
  const fleetConcurrency = integer('RUNNER_FLEET_CONCURRENCY', Math.min(2, maxTurns), 1, 8);
  if (fleetConcurrency > 1 && fleetConcurrency % 2) throw Error('RUNNER_FLEET_CONCURRENCY must be 1, 2, 4, 6 or 8');
  const batchMaxEstimatedUsd = Number(env.RUNNER_BATCH_MAX_ESTIMATED_USD ?? 0.05);
  if (!Number.isFinite(batchMaxEstimatedUsd) || batchMaxEstimatedUsd < 0 || batchMaxEstimatedUsd > 2)
    throw Error('RUNNER_BATCH_MAX_ESTIMATED_USD must be between 0 and 2');
  const memory = flag('RUNNER_MEMORY', true);
  const semanticMemory = flag('RUNNER_SEMANTIC_MEMORY', false);
  if (semanticMemory && !memory) throw Error('RUNNER_SEMANTIC_MEMORY requires RUNNER_MEMORY=1');
  const semanticMemoryMaxEstimatedUsd = Number(env.RUNNER_SEMANTIC_MEMORY_MAX_ESTIMATED_USD ?? 0.01);
  if (
    !Number.isFinite(semanticMemoryMaxEstimatedUsd) ||
    semanticMemoryMaxEstimatedUsd <= 0 ||
    semanticMemoryMaxEstimatedUsd > 0.1
  )
    throw Error('RUNNER_SEMANTIC_MEMORY_MAX_ESTIMATED_USD must be positive and at most 0.1');
  let deployment;
  if (env.RUNNER_DEPLOYMENT_CONTEXT !== undefined) {
    try {
      deployment = validateDeploymentContext(
        z
          .object({ platform: z.literal('briq'), apiUrl: z.string(), homeId: z.string(), stackId: z.string() })
          .strict()
          .parse(JSON.parse(env.RUNNER_DEPLOYMENT_CONTEXT)),
      );
    } catch {
      throw Error('RUNNER_DEPLOYMENT_CONTEXT must be strict public Briq deployment metadata without credentials');
    }
  }
  return {
    fleetConcurrency,
    port: integer('RUNNER_PORT', 8090, 1, 65535),
    host: env.RUNNER_HOST ?? '0.0.0.0',
    stateDir: resolve(env.RUNNER_STATE ?? '/work/.runner'),
    cwd: resolve(env.RUNNER_CWD ?? '/work'),
    maxTurns,
    orchestrator: flag('RUNNER_ORCHESTRATOR', true),
    dynamicRouting: flag('RUNNER_DYNAMIC_ROUTING', true),
    delegation: flag('RUNNER_DELEGATION', false),
    memory,
    extensions: flag('RUNNER_EXTENSIONS', true),
    deployment,
    semanticMemory,
    semanticMemoryMaxEstimatedUsd,
    deferred: flag('RUNNER_DEFERRED', true),
    batch: flag('RUNNER_BATCH', false),
    batchMaxEstimatedUsd,
    defaultRoute: env.RUNNER_DEFAULT_ROUTE,
  };
}
