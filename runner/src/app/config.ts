import { resolve } from 'node:path';
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
  return {
    port: integer('RUNNER_PORT', 8090, 1, 65535),
    host: env.RUNNER_HOST ?? '0.0.0.0',
    stateDir: resolve(env.RUNNER_STATE ?? '/work/.runner'),
    cwd: resolve(env.RUNNER_CWD ?? '/work'),
    maxTurns: integer('RUNNER_MAX_TURNS', 2, 1, 32),
    orchestrator: flag('RUNNER_ORCHESTRATOR', true),
    dynamicRouting: flag('RUNNER_DYNAMIC_ROUTING', false),
    delegation: flag('RUNNER_DELEGATION', false),
    memory: flag('RUNNER_MEMORY', true),
    deferred: flag('RUNNER_DEFERRED', true),
    defaultRoute: env.RUNNER_DEFAULT_ROUTE,
  };
}
