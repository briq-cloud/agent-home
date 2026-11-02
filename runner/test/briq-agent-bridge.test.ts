import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

for (const optin of [false, true]) test(`local Briq Agent bridge applies explicit routing consent (${optin})`, { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'briq-agent-bridge-'));
  const tokenFile = join(dir, 'token'), policyFile = join(dir, 'policy.json');
  writeFileSync(tokenFile, 'local-only-token', { mode: 0o600 });
  writeFileSync(policyFile, JSON.stringify({ optinOpenRouter: optin }));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const port = (server.address() as { port: number }).port;
  const connected = once(server, 'connection');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/briq-agent-acp.ts', import.meta.url))], {
    env: { PATH: process.env.PATH, AGENT_HOME_TOKEN_FILE: tokenFile, AGENT_HOME_POLICY_FILE: policyFile,
      AGENT_HOME_RUNNER_PORT: String(port), AGENT_HOME_CWD: dir, RUNNER_TOKEN: 'unrelated-secret' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const [socket, req] = await connected;
  assert.equal(req.url, '/acp/auto');
  assert.equal(req.headers.authorization, 'Bearer local-only-token');
  const received = once(socket, 'message');
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {
    cwd: '/client/project', mcpServers: [], _meta: { agentHome: { allowPaidApi: !optin, decisionBudgetUsd: 0.05 } },
  } }) + '\n');
  const [data] = await received;
  const request = JSON.parse(data.toString());
  assert.equal(request.params.cwd, '/client/project');
  assert.deepEqual(request.params._meta.agentHome, {
    allowPaidApi: optin, maxEstimatedUsd: optin ? 0.1 : 0, decisionBudgetUsd: optin ? 0.001 : 0, useCwd: true,
  });
  socket.close();
});
