import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

/**
 * An ACP agent on stdin and stdout for the tests, raw JSON-RPC. A prompt's text says what it
 * does: `hello` answers, `ask` asks a permission first, `slow` takes half a second, `die` exits.
 */
type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: any };

const sessions = new Map<string, Msg[]>();
const counts = new Map<string, number>();
const waiting = new Map<number | string, (m: Msg) => void>();
let next = 1;

const send = (m: Msg) => process.stdout.write(`${JSON.stringify(m)}\n`);
const update = (sessionId: string, text: string) => {
  const m: Msg = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  };
  sessions.get(sessionId)?.push(m);
  send(m);
};
const ask = (method: string, params: unknown) =>
  new Promise<Msg>((resolve) => {
    const id = `mock-${next++}`;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

async function handle(m: Msg): Promise<unknown> {
  switch (m.method) {
    case 'initialize':
      return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'mock', version: '1' } };
    case 'session/new': {
      const sessionId = randomUUID();
      sessions.set(sessionId, []);
      return { sessionId, modes: { currentModeId: 'default', availableModes: [] } };
    }
    case 'session/load': {
      const history = sessions.get(m.params.sessionId) ?? [];
      sessions.set(m.params.sessionId, history);
      for (const h of history) send(h);
      return { modes: { currentModeId: 'default', availableModes: [] } };
    }
    case 'session/prompt': {
      const { sessionId, prompt } = m.params;
      const text = prompt?.[0]?.text ?? '';
      if (text === 'die') process.exit(1);
      if (text === 'slow') await new Promise((r) => setTimeout(r, 500));
      if (text === 'ask') {
        update(sessionId, 'asking');
        const r = await ask('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: 't1', title: 'run ls', kind: 'execute' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        });
        update(sessionId, `outcome: ${r.result?.outcome?.optionId ?? r.result?.outcome?.outcome}`);
      } else update(sessionId, 'hi');
      // As Claude reports it: context use, the session's cost so far, its plan's limits; then the
      // session's token totals with the answer.
      const turns = (counts.get(sessionId) ?? 0) + 1;
      counts.set(sessionId, turns);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'usage_update',
            used: 1000 * turns,
            size: 200000,
            cost: { amount: 0.05 * turns, currency: 'USD' },
            _meta: { '_mock/rateLimit': { status: 'allowed', resetsAt: 1800000000 } },
          },
        },
      });
      return { stopReason: 'end_turn', usage: { inputTokens: 100 * turns, outputTokens: 10 * turns, totalTokens: 110 * turns } };
    }
    default:
      throw Object.assign(new Error(`no method ${m.method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line) as Msg;
  if (m.method === undefined && m.id !== undefined) return waiting.get(m.id)?.(m);
  if (m.id === undefined) return;
  handle(m).then(
    (result) => send({ jsonrpc: '2.0', id: m.id, result }),
    (err) => send({ jsonrpc: '2.0', id: m.id, error: { code: err.code ?? -32603, message: err.message } }),
  );
});
