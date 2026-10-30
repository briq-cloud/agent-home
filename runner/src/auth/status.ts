import { spawn } from 'node:child_process';

const STATUS_OUTPUT_LIMIT = 16_384;

function explicitStatus(stream: string): boolean | undefined {
  const candidates = [stream.trim(), ...stream.split(/\r?\n/).map((line) => line.trim())];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as { loggedIn?: unknown }).loggedIn === 'boolean'
      ) {
        return (value as { loggedIn: boolean }).loggedIn;
      }
    } catch {
      /* Status commands may print human-readable text instead of JSON. */
    }
  }
  return undefined;
}

function explicitlySignedOut(text: string): boolean {
  return /\b(?:not\s+logged\s+in|logged\s+out|not\s+authenticated|not\s+signed\s+in|login\s+required)\b/i.test(text);
}

/** A status command that could not finish says nothing about the person's sign-in. */
export function commandStatus(
  command: string[],
  env: Record<string, string>,
  timeoutMs = 10_000,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command;
    const child = spawn(cmd as string, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let outputBytes = 0;
    let invalid = false;
    let timedOut = false;
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > STATUS_OUTPUT_LIMIT) {
        invalid = true;
        child.kill('SIGKILL');
      } else chunks.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || invalid || signal || code === null) return resolve(null);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      const structured = explicitStatus(out) ?? explicitStatus(err);
      if (structured !== undefined) return resolve(structured);
      if (explicitlySignedOut(`${out}\n${err}`)) return resolve(false);
      resolve(code === 0);
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
