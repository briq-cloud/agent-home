import { test } from "node:test";
import assert from "node:assert/strict";
import { Meter } from "../meter.mjs";
const generation =
  (cost = 0.02) =>
  async (url) =>
    url.includes("/generation?")
      ? Response.json({ data: { total_cost: cost, model: "fixed", provider_name: "fake" } })
      : new Response(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"gen-test"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
async function request(meter, url, body = { model: "untrusted", max_tokens: 99999 }) {
  return fetch(url + "/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${meter.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("billing uses generation actual cost, pins model and bounds output", async () => {
  let seen;
  const fake = generation(),
    m = new Meter({
      key: "provider-secret",
      model: "fixed",
      fetcher: async (url, opts) => {
        if (!url.includes("/generation?")) seen = JSON.parse(opts.body);
        return fake(url, opts);
      },
    }),
    url = await m.start();
  try {
    m.begin({ taskId: "test", arm: "baseline" });
    await (await request(m, url)).text();
    const bill = await m.end();
    assert.equal(bill.costUsd, 0.02);
    assert.equal(seen.model, "fixed");
    assert.equal(seen.max_tokens, 2048);
    assert.ok(!JSON.stringify(bill).includes("provider-secret"));
  } finally {
    await m.close();
  }
});
test("unreconciled request cost is unknown and blocks subsequent paid traffic", async () => {
  let calls = 0;
  const m = new Meter({
      key: "secret",
      model: "fixed",
      fetcher: async () => {
        calls++;
        return Response.json({ id: "unrecognized", error: "failed" });
      },
    }),
    url = await m.start();
  try {
    m.begin({ taskId: "test" });
    await (await request(m, url)).text();
    assert.equal((await m.end()).costUsd, null);
    assert.throws(() => m.begin({ taskId: "next" }), /meter-stopped/);
    assert.equal(calls, 1);
  } finally {
    await m.close();
  }
});
test("known spend stops the next request at the budget", async () => {
  const m = new Meter({
      key: "secret",
      model: "fixed",
      budgetUsd: 0.01,
      fetcher: generation(0.01),
    }),
    url = await m.start();
  try {
    m.begin({ taskId: "test" });
    await (await request(m, url)).text();
    await m.end();
    assert.throws(() => m.begin({ taskId: "next" }), /meter-stopped/);
  } finally {
    await m.close();
  }
});

test("Anthropic message IDs differ from the billing ID in response headers", async () => {
  const m = new Meter({
    key: "secret",
    model: "fixed",
    fetcher: async (url) =>
      url.includes("/generation?")
        ? Response.json({ data: { total_cost: 0.0001 } })
        : new Response('event: message_start\ndata: {"message":{"id":"msg-native"}}\n\n', {
            headers: { "content-type": "text/event-stream", "x-generation-id": "gen-billing" },
          }),
  });
  const url = await m.start();
  try {
    m.begin({ taskId: "header" });
    await (await request(m, url)).text();
    const bill = await m.end();
    assert.equal(bill.costUsd, 0.0001);
    assert.equal(bill.generations[0].generationId, "gen-billing");
    assert.equal(m.blocked, false);
  } finally {
    await m.close();
  }
});
