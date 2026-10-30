import { spawn } from 'node:child_process';

/** A status command that could not finish says nothing about the person's sign-in. */
export function commandStatus(
  command: string[],
  env: Record<string, string>,
  timeoutMs = 10_000,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command;
    const child = spawn(cmd as string, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let timedOut = false;
    child.stdout?.on('data', (b: Buffer) => {
      if (Buffer.byteLength(out) + b.length > 16384) {
        timedOut = true;
        child.kill('SIGKILL');
      } else out += b.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || signal || code === null) return resolve(null);
      const m = /"loggedIn"\s*:\s*(true|false)/.exec(out);
      resolve(m ? m[1] === 'true' : code === 0);
    });
  });
}

/** Non-secret auth-mode metadata from the vendor's status command; unknown is never an included plan. */
export function parseBillingStatus(output: string): 'subscription' | 'use' | 'unknown' {
  if (/"authMethod"\s*:\s*"(?:api[_-]?key|token)"|logged in using an? api key/i.test(output)) return 'use';
  if (/"authMethod"\s*:\s*"claude\.ai"|logged in using chatgpt/i.test(output)) return 'subscription';
  return 'unknown';
}
export async function commandBilling(
  command: string[],
  env: Record<string, string>,
): Promise<'subscription' | 'use' | 'unknown'> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '',
      bad = false;
    const collect = (b: Buffer) => {
      if (Buffer.byteLength(text) + b.length > 16384) {
        bad = true;
        child.kill('SIGKILL');
      } else text += b.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      bad = true;
      child.kill('SIGKILL');
    }, 5000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve('unknown');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(!bad && code === 0 ? parseBillingStatus(text) : 'unknown');
    });
  });
}
