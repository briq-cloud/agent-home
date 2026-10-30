import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const CAPABILITY = 'synthetic-task-capability-only';
let server: Server;
let baseUrl = '';
let transport: StdioClientTransport;
let client: Client;
let requests: Array<{ authorization: string | undefined; path: string; body: Record<string, unknown> }> = [];
let waitStarted: (() => void) | undefined;
let responseClosed: (() => void) | undefined;
let waitStartedPromise: Promise<void>;
let responseClosedPromise: Promise<void>;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk.toString();
  return JSON.parse(text) as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function bounded<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function firstText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content[0]?.type !== 'text' || typeof content[0]?.text !== 'string') {
    throw new Error('MCP result did not contain text');
  }
  return content[0].text;
}

before(async () => {
  requests = [];
  waitStartedPromise = new Promise((resolve) => {
    waitStarted = resolve;
  });
  responseClosedPromise = new Promise((resolve) => {
    responseClosed = resolve;
  });
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ authorization: req.headers.authorization, path: req.url ?? '', body });
    const payload = body as { action?: string; input?: Record<string, unknown> };
    if (payload.action === 'wait') {
      waitStarted?.();
      res.once('close', () => responseClosed?.());
      return;
    }
    if (payload.action === 'status' && payload.input?.taskId === 'return-error') {
      return json(res, 200, { error: 'synthetic capability refusal' });
    }
    return json(res, 200, { action: payload.action, input: payload.input, scope: 'same-task' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate local stub server port');
  baseUrl = `http://127.0.0.1:${address.port}/delegate`;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [`${here}../bin/task-tools.ts`],
    env: {
      PATH: process.env.PATH ?? '',
      AGENT_HOME_TASK_URL: baseUrl,
      AGENT_HOME_TASK_CAP: CAPABILITY,
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'agent-home-task-tools-test', version: '1.0.0' });
  await client.connect(transport);
});

after(async () => {
  try {
    await client?.close();
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test('stdio bridge registers exactly eight task-scoped MCP tools', async () => {
  const result = await client.listTools();
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    'home_memory_recall',
    'home_task_ack',
    'home_task_inbox',
    'home_task_result',
    'home_task_send',
    'home_task_spawn',
    'home_task_status',
    'home_task_wait',
  ]);
});

test('tool calls use only the scoped capability and send action/input over the stub HTTP API', async () => {
  const result = await client.callTool({ name: 'home_task_status', arguments: { taskId: 'child-7' } });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(firstText(result)), {
    action: 'status',
    input: { taskId: 'child-7' },
    scope: 'same-task',
  });
  assert.deepEqual(requests.at(-1), {
    authorization: `Bearer ${CAPABILITY}`,
    path: '/delegate',
    body: { action: 'status', input: { taskId: 'child-7' } },
  });
});

test('a JSON error returned with HTTP 200 becomes an MCP tool error result', async () => {
  const result = await client.callTool({ name: 'home_task_status', arguments: { taskId: 'return-error' } });
  assert.equal(result.isError, true);
  assert.match(firstText(result), /synthetic capability refusal/);
});

test('MCP client timeout cancels the pending HTTP response', async () => {
  const call = client.callTool({ name: 'home_task_wait', arguments: { taskIds: ['slow-child'] } }, undefined, {
    timeout: 100,
  });
  await bounded(waitStartedPromise, 1_000, 'wait action did not reach the local HTTP stub');
  await assert.rejects(call, /timed out|timeout/i);
  await bounded(responseClosedPromise, 1_000, 'HTTP response remained open after MCP cancellation');
  assert.equal(requests.at(-1)?.body && (requests.at(-1)?.body as { action?: string }).action, 'wait');
});
