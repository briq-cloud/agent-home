import { spawn } from 'node:child_process';

/** A status command that could not finish says nothing about the person's sign-in. */
export function commandStatus(command: string[], env: Record<string, string>, timeoutMs = 10_000): Promise<boolean | null> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command;
    const child = spawn(cmd as string, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let timedOut = false;
    child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || signal || code === null) return resolve(null);
      const m = /"loggedIn"\s*:\s*(true|false)/.exec(out);
      resolve(m ? m[1] === 'true' : code === 0);
    });
  });
}
