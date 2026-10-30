/** Free native conformance fixture: isolated Claude CLI + production ACP/Hub,
 * deterministic localhost Anthropic responses and SDK MCP server. No vendor
 * credentials, logins, remote model endpoints or provider purchases. */
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub, type Peer } from '../src/acp/hub.ts';
import { cliEnv, CLIS } from '../src/providers/catalog.ts';
import { ExtensionRegistry } from '../src/extensions/index.ts';

const TOOL_MARKER = 'HOME_NATIVE_MCP_PING_EXECUTED';
const USER_MARKER = 'HOME_NATIVE_USER_INSTRUCTIONS_PRESERVED';
const PROJECT_MARKER = 'HOME_NATIVE_PROJECT_INSTRUCTIONS_PRESERVED';
const script = fileURLToPath(import.meta.url);
if (process.argv[2] === '--mcp') {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('zod'),
  ]);
  const markerFile = process.argv[3]!;
  const server = new McpServer({ name: 'home-native-probe', version: '1.0.0' });
  server.registerTool(
    'ping',
    {
      description: 'Return the deterministic local native conformance marker.',
      inputSchema: { nonce: z.string().optional() },
    },
    async () => {
      appendFileSync(markerFile, TOOL_MARKER + '\n', { mode: 0o600 });
      return { content: [{ type: 'text' as const, text: TOOL_MARKER }] };
    },
  );
  await server.connect(new StdioServerTransport());
} else {
  await main();
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'home-native-extensions-'));
  const home = join(root, 'home'),
    config = join(root, 'claude'),
    workspace = join(root, 'workspace'),
    stateDir = join(root, 'state');
  for (const path of [home, config, workspace, stateDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, 'CLAUDE.md'), USER_MARKER + '\n', { mode: 0o600 });
  writeFileSync(join(workspace, 'CLAUDE.md'), PROJECT_MARKER + '\n', { mode: 0o600 });
  const markerFile = join(root, 'tool-marker');
  const registry = new ExtensionRegistry({ stateDir });
  registry.installBuiltins();
  registry.putServer({
    name: 'home-probe',
    transport: 'stdio',
    command: process.execPath,
    args: [script, '--mcp', markerFile],
    required: true,
  });
  const payloads: Array<{ path: string; body: any }> = [];
  const unknownPaths: string[] = [];
  let requestedTool: string | undefined,
    toolResultSeen = false,
    calls = 0;
  const provider = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 4_000_000) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (path !== '/v1/messages') {
      unknownPaths.push(path);
      res.writeHead(404).end();
      return;
    }
    payloads.push({ path, body });
    calls++;
    if (calls > 8) {
      res.writeHead(429).end();
      return;
    }
    const tools = Array.isArray(body.tools) ? body.tools : [];
    requestedTool ??= tools.find(
      (tool: any) => typeof tool.name === 'string' && /ping/.test(tool.name) && /mcp/i.test(tool.name),
    )?.name;
    toolResultSeen ||= JSON.stringify(body.messages).includes(TOOL_MARKER);
    const useTool = !!requestedTool && !toolResultSeen;
    const content = useTool
      ? [{ type: 'tool_use', id: 'toolu_home_probe', name: requestedTool, input: { nonce: 'local-only' } }]
      : [{ type: 'text', text: 'HOME_NATIVE_CONFORMANCE_DONE' }];
    const message = {
      id: 'msg_home_' + calls,
      type: 'message',
      role: 'assistant',
      model: body.model || 'claude-sonnet-4-5',
      content,
      stop_reason: useTool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 10 },
    };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type: string, value: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    event('message_start', {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } },
    });
    if (useTool) {
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_home_probe', name: requestedTool, input: {} },
      });
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"nonce":"local-only"}' },
      });
    } else {
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'HOME_NATIVE_CONFORMANCE_DONE' },
      });
    }
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 10 },
    });
    event('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw Error('No local fixture port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const env = cliEnv({
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: root,
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: join(home, 'config'),
  });
  if (!env.CLAUDE_CODE_EXECUTABLE) throw Error('Installed Claude executable unavailable');
  const native = CLIS.find((cli) => cli.name === 'claude')!;
  const hub = new Hub({
    clis: [
      {
        name: 'native-probe',
        acp: native.acp,
        profile: { provider: 'anthropic', harness: 'claude', model: 'claude-sonnet-4-5' },
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: 'local-fixture-not-a-real-key',
          ANTHROPIC_AUTH_TOKEN: null,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
          ENABLE_TOOL_SEARCH: 'false',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_UPDATES: '1',
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024',
          API_TIMEOUT_MS: '30000',
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        },
      },
    ],
    env,
    cwd: workspace,
    stateDir,
    maxTurns: 1,
    signedIn: async () => true,
    extensions: { registry, env: () => ({}) },
  });
  const notifications: any[] = [],
    permissions: string[] = [];
  const peer: Peer = {
    send: (rpc) => {
      if (rpc.method === '_runner/extensions' || rpc.params?.update?.sessionUpdate === 'available_commands_update')
        notifications.push(rpc);
    },
    ask: async (method, params: any) => {
      permissions.push(method);
      const option =
        method === 'session/request_permission' && params?.options?.find((value: any) => value.kind === 'allow_once');
      return {
        jsonrpc: '2.0',
        id: 'local-probe-permission',
        result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } },
      };
    },
  };
  let response: any, initialized: any, failure: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  try {
    await Promise.race([
      (async () => {
        initialized = await hub.initialize('native-probe');
        const opened: any = await hub.newSession('native-probe', { cwd: workspace, mcpServers: [] }, peer);
        response = await hub.prompt(
          'native-probe',
          {
            sessionId: opened.sessionId,
            prompt: [
              {
                type: 'text',
                text: 'Run the local home-probe ping tool once, then report done. This is a deterministic local conformance fixture.',
              },
            ],
          },
          peer,
        );
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Native conformance deadline exceeded')), 100_000);
      }),
    ]);
  } catch (error) {
    failure = error instanceof Error ? error.message.slice(0, 200) : 'Native conformance failed';
  } finally {
    clearTimeout(timer);
    hub.detach(peer);
    await hub.remove('native-probe');
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
  const payload = JSON.stringify(payloads.map((value) => value.body));
  const declaredSkills = registry.list().skills;
  const checks = {
    localhostProviderCalled: payloads.length > 0,
    negotiatedAppendCapability: !!initialized?.agentCapabilities?.sessionCapabilities?.systemPrompt,
    nativePayloadHasHomeAppend: payload.includes('Agent Home provides durable task state'),
    nativePayloadPreservesUserInstructions: payload.includes(USER_MARKER),
    nativePayloadPreservesProjectInstructions: payload.includes(PROJECT_MARKER),
    nativeAdvertisedProbeTool: !!requestedTool,
    actualToolExecuted: existsSync(markerFile) && readFileSync(markerFile, 'utf8').includes(TOOL_MARKER),
    providerReceivedToolResult: toolResultSeen,
    nativeTurnFinished: response?.stopReason === 'end_turn',
  };
  const result = {
    status: !failure && Object.values(checks).every(Boolean) ? 'passed' : 'failed',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    checks,
    skillDiscovery: declaredSkills.map((skill) => ({
      name: skill.name,
      nameInPayload: payload.includes(skill.name),
      descriptionInPayload: payload.includes(skill.description),
      note: 'Payload metadata observation only; not a workflow-quality guarantee.',
    })),
    provider: {
      kind: 'deterministic localhost Anthropic fixture',
      requests: payloads.length,
      unknownPaths,
      paidCalls: 0,
      externalModelRequests: 0,
    },
    native: { executable: env.CLAUDE_CODE_EXECUTABLE, adapter: native.acp[0], version: initialized?.agentInfo ?? null },
    requestedTool,
    permissionRequests: permissions.length,
    extensionSnapshots: notifications
      .filter((value) => value.method === '_runner/extensions')
      .map((value) => value.params),
    isolation: { root, credentialSource: 'synthetic fixture constant only', userLoginFilesRead: false },
    ...(failure ? { failure } : {}),
  };
  const output = process.argv[2] || join(root, 'result.json');
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      status: result.status,
      output,
      checks,
      skillDiscovery: result.skillDiscovery,
      provider: result.provider,
      ...(failure ? { failure } : {}),
    }),
  );
  if (result.status !== 'passed') process.exitCode = 1;
}
