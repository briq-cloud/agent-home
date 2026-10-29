import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tasks, mockAnswers, mockFixes } from "./fixtures.mjs";
/** A free transport smoke test, not an execution-quality benchmark. */
export async function startMock() {
  const server = createServer(),
    wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    const sessions = new Map();
    ws.on("message", async (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id === undefined) return;
      let result;
      if (m.method === "initialize")
        result = {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
          agentInfo: { name: "benchmark-mock", version: "1" },
        };
      else if (m.method === "session/new") {
        const sessionId = randomUUID();
        sessions.set(sessionId, m.params.cwd);
        result = { sessionId };
      } else if (m.method === "session/prompt") {
        const text = m.params.prompt[0].text,
          task = tasks.find((t) => text.includes(t.prompt));
        const cwd = sessions.get(m.params.sessionId);
        if (task && mockFixes[task.id]) {
          const [f, source] = mockFixes[task.id];
          await writeFile(join(cwd, f), source);
        }
        const output = task ? (mockAnswers[task.id] ?? "Applied fixture fix.") : "hello";
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: m.params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: output },
              },
            },
          }),
        );
        result = {
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      } else if (m.method === "session/cancel") return;
      else {
        ws.send(
          JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } }),
        );
        return;
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
