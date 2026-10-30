// Transport/feature smoke double. Only mock mode loads reference patches. Live
// mode executes the real installed Claude ACP harness instead of this module.
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { managedFixtures } from "./fixtures.mjs";
const { Client } = await import(
  new URL(
    "../../runner/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    import.meta.url,
  )
);
const { StdioClientTransport } = await import(
  new URL(
    "../../runner/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js",
    import.meta.url,
  )
);
const sessions = new Map(),
  fixture = managedFixtures.find((task) => task.id === process.env.MANAGED_MOCK_FIXTURE);
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
async function handle(message) {
  if (message.method === "initialize")
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "managed-mock", version: "1" },
    };
  if (message.method === "session/new") {
    const id = randomUUID();
    sessions.set(id, message.params);
    return { sessionId: id };
  }
  if (message.method === "session/set_model" || message.method === "session/cancel") return {};
  if (message.method !== "session/prompt") throw Error("unexpected mock method");
  const session = sessions.get(message.params.sessionId),
    text = message.params.prompt[0].text;
  // Fixture-only commands follow the task after the production context prefix.
  const taskMarker = "\n\n[CURRENT TASK]\n";
  const taskStart = text.lastIndexOf(taskMarker);
  const taskText = taskStart < 0 ? text : text.slice(taskStart + taskMarker.length);
  if (taskText === "__BENCH_REPORT_NATIVE_ENV__") {
    send({
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({
              nativeExecutable: process.env.CLAUDE_CODE_EXECUTABLE ?? null,
              providerKeyInherited: Boolean(
                process.env.OPENROUTER_API_KEY || process.env.BENCH_KEYS_FILE,
              ),
            }),
          },
        },
      },
    });
    return { stopReason: "end_turn" };
  }
  const functional = text.includes("DELEGATION FUNCTIONAL");
  const isChild =
    text.includes("MANAGED MOCK CHILD") ||
    (functional && !text.includes("DELEGATION FUNCTIONAL PROBE."));
  const server = session.mcpServers?.[0];
  let client, transport;
  try {
    // Even the smoke run traverses the actual API-key relay and records a fake
    // upstream generation. No real model service exists in mock mode.
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL,
        max_tokens: 8,
        messages: [{ role: "user", content: "mock transport" }],
      }),
    });
    if (!response.ok) throw Error("mock execution relay rejected");
    await response.text();
    if (server && !isChild) {
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: {
          PATH: process.env.PATH ?? "",
          ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
        },
        stderr: "ignore",
      });
      client = new Client({ name: "managed-benchmark-mock", version: "1" });
      await client.connect(transport);
      const spawned = await client.callTool({
        name: "home_task_spawn",
        arguments: functional
          ? { prompt: "DELEGATION FUNCTIONAL CHILD", agentId: "bench-deepseek" }
          : { prompt: "MANAGED MOCK CHILD: repair only " + fixture.childFile },
      });
      const child = JSON.parse(spawned.content[0].text);
      const waited = await client.callTool({
        name: "home_task_wait",
        arguments: { taskIds: [child.id] },
      });
      if (waited.isError) throw Error("mock child failed");
    }
    if (functional)
      await writeFile(
        join(session.cwd, isChild ? "child.txt" : "root.txt"),
        isChild ? "child:beta\n" : "root:alpha\n",
      );
    else
      for (const [file, content] of Object.entries(fixture.reference))
        if (isChild ? file === fixture.childFile : !server || file !== fixture.childFile)
          await writeFile(join(session.cwd, file), content);
    if (!isChild && !functional)
      await writeFile(
        join(session.cwd, "CHANGELOG.md"),
        "Implemented exact contract behavior and checked boundaries.\n",
      );
    send({
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Applied fixture contract changes." },
        },
      },
    });
    return { stopReason: "end_turn" };
  } finally {
    await client?.close();
    await transport?.close();
  }
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  handle(message).then(
    (result) => send({ id: message.id, result }),
    () =>
      send({ id: message.id, error: { code: -32603, message: "mock managed operation failed" } }),
  );
});
