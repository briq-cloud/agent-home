// Native-resume-only ACP fixture: no provider credentials, network or model calls.
import { createInterface } from 'node:readline';
const seen: Array<{ method: string; params: unknown }> = [];
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === 'session/load') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported' } }) + '\n');
    continue;
  }
  let result: unknown = {};
  if (message.method === 'initialize') result = {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: process.argv[2] === '1' ? { resume: {} } : {} },
  };
  else if (message.method === '_test/inspect') result = seen;
  else if (message.method === '_test/environment') result = process.env;
  else {
    seen.push({ method: message.method, params: message.params });
    if (message.method === 'session/new') result = { sessionId: 'persisted-session' };
    if (message.method === 'session/prompt') result = { stopReason: 'end_turn' };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
