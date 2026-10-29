import WebSocket from "ws";
import { client, methods } from "@agentclientprotocol/sdk";

/** SDK framing over the runner's existing raw-message WebSocket endpoint. */
export async function promptAcp({
  url,
  token,
  cwd,
  prompt,
  timeoutMs = 90000,
  allowTools = false,
}) {
  const started = performance.now();
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  let connection,
    sessionId,
    timer,
    completed = false,
    firstOutputMs = null,
    output = "",
    toolCalls = 0,
    toolOutputBytes = 0;
  const toolIds = new Set(),
    rawUsage = [];
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const readable = new ReadableStream({
    start(controller) {
      ws.on("message", (data) => {
        try {
          controller.enqueue(JSON.parse(String(data)));
        } catch {
          controller.error(Error("invalid-acp-message"));
        }
      });
      ws.once("close", () => {
        try {
          controller.close();
        } catch {}
      });
      ws.on("error", () => {
        try {
          controller.error(Error("acp-transport-error"));
        } catch {}
      });
    },
  });
  const writable = new WritableStream({
    write(message) {
      ws.send(JSON.stringify(message));
    },
    close() {
      ws.close();
    },
  });
  const app = client({ name: "agent-home-benchmark", version: "0.1.0" })
    .onNotification(methods.client.session.update, ({ params: { update } }) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        firstOutputMs ??= performance.now() - started;
        output += update.content.text;
      }
      if (update.sessionUpdate === "tool_call" && !toolIds.has(update.toolCallId)) {
        toolIds.add(update.toolCallId);
        toolCalls++;
      }
      if (update.sessionUpdate === "tool_call_update")
        for (const c of update.content ?? [])
          if (c.type === "content" && c.content?.type === "text")
            toolOutputBytes += Buffer.byteLength(c.content.text);
      if (update.sessionUpdate === "usage_update") rawUsage.push(update);
    })
    .onRequest(methods.client.session.requestPermission, ({ params: { options } }) => {
      const option = options.find((x) => x.kind === (allowTools ? "allow_once" : "reject_once"));
      return {
        outcome: option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" },
      };
    });
  const work = (async () => {
    await opened;
    connection = app.connect({ readable, writable });
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientInfo: { name: "agent-home-benchmark", version: "0.1.0" },
      clientCapabilities: {},
    });
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    sessionId = session.sessionId;
    const result = await connection.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    completed = true;
    return {
      output,
      sessionId,
      stopReason: result.stopReason,
      firstOutputMs,
      agentMs: performance.now() - started,
      toolCalls,
      toolOutputBytes,
      rawUsage: [...rawUsage, ...(result.usage ? [result.usage] : [])],
    };
  })();
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("trial-timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (sessionId && !completed) {
      try {
        await Promise.race([
          connection.agent.notify(methods.agent.session.cancel, { sessionId }),
          new Promise((r) => setTimeout(r, 100)),
        ]);
      } catch {}
    }
    connection?.close();
    ws.terminate();
  }
}
