// Test-only ACP transport. Records parameters in process memory, never calls a
// vendor/model or writes credential-bearing lifecycle requests to session logs.
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
const seen: unknown[] = [];
let next = 1;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === '_test/crash') {
    process.stderr.write(String(message.params?.detail));
    setTimeout(() => process.exit(7), 10);
    continue;
  }
  let result: unknown = {};
  if (message.method === 'initialize')
    result = {
      protocolVersion: 1,
      agentCapabilities: JSON.parse(process.env.EXTENSION_TEST_CAPS ?? '{}'),
      _meta: {
        skillReadyBeforeStart: !!process.env.EXTENSION_TEST_SKILL && existsSync(process.env.EXTENSION_TEST_SKILL),
      },
    };
  else if (message.method === '_test/inspect') result = seen;
  else {
    seen.push({ method: message.method, params: message.params });
    if (message.method === 'session/new') result = { sessionId: `session-${next++}` };
    else if (message.method === 'session/prompt') result = { stopReason: 'end_turn' };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
