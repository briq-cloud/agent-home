#!/usr/bin/env node
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

/**
 * An agent home as a local ACP agent, for a client that only starts agents on its own machine
 * (an editor, `acpx`): ACP on stdin and stdout here, the home's runner over WebSocket there.
 *
 *   agent-home-acp wss://home-x7k2.briq.run/acp/claude
 *
 * AGENT_HOME_TOKEN is the runner's key (`RUNNER_TOKEN`), AGENT_HOME_BRIQ_TOKEN the token of the
 * home's private URL. A session's folder is the client's, which the home does not have: it
 * becomes AGENT_HOME_CWD, or `/work/<the folder's name>` on the home.
 */
const url = process.argv[2];
if (!url) {
  process.stderr.write('usage: agent-home-acp <wss://…/acp/<cli>>\n');
  process.exit(2);
}
const headers: Record<string, string> = {};
if (process.env.AGENT_HOME_TOKEN) headers.authorization = `Bearer ${process.env.AGENT_HOME_TOKEN}`;
if (process.env.AGENT_HOME_BRIQ_TOKEN) headers.cookie = `briq_token=${process.env.AGENT_HOME_BRIQ_TOKEN}`;

/** The client's folder, as a folder on the home. */
function homeCwd(cwd: unknown): unknown {
  if (typeof cwd !== 'string') return cwd;
  if (process.env.AGENT_HOME_CWD) return process.env.AGENT_HOME_CWD;
  return cwd.startsWith('/work') ? cwd : `/work/${basename(cwd) || 'work'}`;
}

const ws = new WebSocket(url, { headers });
const waiting: string[] = [];
let open = false;

ws.on('open', () => {
  open = true;
  for (const line of waiting.splice(0)) ws.send(line);
});
ws.on('message', (data) => {
  process.stdout.write(`${String(data)}\n`);
});
ws.on('close', () => process.exit(0));
ws.on('error', (err) => {
  process.stderr.write(`agent-home-acp: ${err.message}\n`);
  process.exit(1);
});

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let out = line;
  try {
    const msg = JSON.parse(line);
    if ((msg.method === 'session/new' || msg.method === 'session/load') && msg.params) {
      msg.params.cwd = homeCwd(msg.params.cwd);
      out = JSON.stringify(msg);
    }
  } catch {}
  if (open) ws.send(out);
  else waiting.push(out);
}).on('close', () => ws.close());
