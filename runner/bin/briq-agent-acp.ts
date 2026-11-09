#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Local Briq Agent bridge. Pass only bridge inputs to the ACP process. */
const tokenFile = process.env.AGENT_HOME_TOKEN_FILE;
if (!tokenFile) { process.stderr.write('Briq Agent is not configured\n'); process.exit(1); }
let token: string;
try { token = readFileSync(tokenFile, 'utf8').trim(); } catch { process.stderr.write('Briq Agent credentials unavailable\n'); process.exit(1); }
const port = Number(process.env.AGENT_HOME_RUNNER_PORT);
if (!token || !Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ'].flatMap((name) =>
  process.env[name] === undefined ? [] : [[name, process.env[name]!]],
));
// Permission is captured for this bridge's new conversations, never changed mid-session.
let optin = false;
try { optin = JSON.parse(readFileSync(process.env.AGENT_HOME_POLICY_FILE ?? '', 'utf8')).optinOpenRouter === true; } catch {}
const child = spawn(process.execPath, [fileURLToPath(new URL('./agent-home-acp.ts', import.meta.url)), `ws://127.0.0.1:${port}/acp/auto`],
  { env: { ...env, AGENT_HOME_TOKEN: token, AGENT_HOME_LOCAL_CWD: '1', AGENT_HOME_OPTIN_OPENROUTER: optin ? '1' : '0' }, stdio: 'inherit' });
child.once('error', () => { process.stderr.write('Briq Agent bridge unavailable\n'); process.exit(1); });
child.once('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
