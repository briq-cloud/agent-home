import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "../mock.mjs";
import BenchmarkProvider from "../provider.mjs";
import { promptAcp } from "../acp.mjs";
import { WebSocketServer } from "ws";
test("provider goes through real ACP transport and external acceptance checks", async () => {
  const mock = await startMock(),
    root = await mkdtemp(join(tmpdir(), "bench-acp-"));
  try {
    const provider = new BenchmarkProvider({
      config: { root },
      runtime: {
        url: mock.url,
        token: "secret",
        end: async () => ({ costUsd: 0, provenance: "mock" }),
      },
    });
    const result = await provider.callApi("", {
      vars: { taskId: "lookup-config", arm: "context-pack" },
    });
    assert.equal(JSON.parse(result.output).grade.pass, true);
    assert.ok(result.metadata.firstOutputMs !== null);
    assert.ok(result.metadata.rawUsage.length);
    assert.ok(!JSON.stringify(provider).includes("secret"));
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("deadline closes an unresponsive ACP connection", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  try {
    await assert.rejects(
      promptAcp({
        url: `ws://127.0.0.1:${wss.address().port}`,
        token: "x",
        cwd: "/tmp",
        prompt: "x",
        timeoutMs: 30,
      }),
      /trial-timeout/,
    );
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
  }
});

for (const allowed of [false, true])
  test(`permission policy selects ${allowed ? "allow_once" : "reject_once"}`, async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    let selected, promptId;
    wss.on("connection", (ws) =>
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        const send = (result) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        if (m.method === "initialize")
          send({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
        else if (m.method === "session/new") send({ sessionId: "permission-session" });
        else if (m.method === "session/prompt") {
          promptId = m.id;
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "permission",
              method: "session/request_permission",
              params: {
                sessionId: "permission-session",
                toolCall: { toolCallId: "edit", kind: "edit", title: "fixture edit" },
                options: [
                  { optionId: "yes", kind: "allow_once", name: "Allow once" },
                  { optionId: "no", kind: "reject_once", name: "Reject once" },
                ],
              },
            }),
          );
        } else if (m.id === "permission") {
          selected = m.result.outcome.optionId;
          ws.send(
            JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } }),
          );
        }
      }),
    );
    try {
      await promptAcp({
        url: `ws://127.0.0.1:${wss.address().port}`,
        token: "x",
        cwd: "/tmp",
        prompt: "test",
        allowTools: allowed,
      });
      assert.equal(selected, allowed ? "yes" : "no");
    } finally {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(r));
    }
  });
