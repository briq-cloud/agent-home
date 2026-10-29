import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/** API-key-only local relay. Never points a subscription CLI at a proxy. */
export class Meter {
  constructor({ key, model, budgetUsd = 2, perTrialUsd = 0.15, fetcher = fetch }) {
    Object.assign(this, { key, model, budgetUsd, perTrialUsd, fetcher });
    this.token = randomBytes(24).toString("hex");
    this.records = [];
    this.blocked = false;
    this.active = null;
    this.tail = Promise.resolve();
  }
  get spent() {
    return this.records.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  }
  begin(label) {
    if (this.blocked || this.spent >= this.budgetUsd) throw Error("meter-stopped");
    this.active = { ...label, start: this.records.length };
  }
  async end() {
    await this.tail;
    const records = this.records.slice(this.active?.start ?? this.records.length);
    this.active = null;
    return {
      costUsd: records.some((r) => r.costUsd === null)
        ? null
        : records.reduce((n, r) => n + r.costUsd, 0),
      provenance: "openrouter-generation-total_cost",
      generations: records,
    };
  }
  async start() {
    this.server = createServer((req, res) => {
      const run = this.tail.then(() => this.handle(req, res));
      this.tail = run.catch(() => {
        this.blocked = true;
        if (!res.headersSent) res.writeHead(502);
        res.end('{"error":{"type":"billing_unavailable","message":"benchmark stopped"}}');
      });
    });
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${this.server.address().port}`;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
  async handle(req, res) {
    if (
      req.headers.authorization !== `Bearer ${this.token}` ||
      req.method !== "POST" ||
      req.url?.split("?")[0] !== "/v1/messages"
    ) {
      res.writeHead(403);
      res.end("{}");
      return;
    }
    if (!this.active || this.blocked) {
      res.writeHead(429);
      res.end('{"error":{"type":"rate_limit_error","message":"benchmark meter stopped"}}');
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 500000) {
        res.writeHead(413);
        res.end("{}");
        return;
      }
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks));
    } catch {
      res.writeHead(400);
      res.end("{}");
      return;
    }
    // The caller cannot switch models, enable paid provider tools, or ask for unbounded output.
    body.model = this.model;
    body.max_tokens = Math.min(Math.max(Number(body.max_tokens) || 2048, 1), 2048);
    delete body.plugins;
    delete body.web_search_options;
    delete body.thinking;
    const trialRecords = this.records.slice(this.active.start),
      trialCost = trialRecords.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    if (
      this.spent >= this.budgetUsd ||
      trialCost >= this.perTrialUsd ||
      trialRecords.length >= 12
    ) {
      this.blocked = true;
      res.writeHead(429);
      res.end('{"error":{"type":"rate_limit_error","message":"benchmark budget reached"}}');
      return;
    }
    const record = {
      ...this.active,
      start: undefined,
      model: this.model,
      costUsd: null,
      generationId: null,
      status: null,
    };
    this.records.push(record);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 90000);
    res.once("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const upstream = await this.fetcher("https://openrouter.ai/api/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.key}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      record.status = upstream.status;
      const headerId =
        upstream.headers.get("x-generation-id") ?? upstream.headers.get("request-id");
      if (headerId?.startsWith("gen-")) record.generationId = headerId;
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      let pending = "",
        whole = "";
      const decoder = new TextDecoder();
      const inspect = (line) => {
        try {
          const j = JSON.parse(line.startsWith("data:") ? line.slice(5).trim() : line);
          const id = j.message?.id ?? j.id;
          if (typeof id === "string" && id.startsWith("gen-")) record.generationId = id;
        } catch {}
      };
      for await (const chunk of upstream.body) {
        res.write(chunk);
        const text = decoder.decode(chunk, { stream: true });
        pending += text;
        whole += text;
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) {
          inspect(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
      }
      pending += decoder.decode();
      inspect(pending);
      if (!record.generationId) inspect(whole);
      res.end();
      if (record.generationId) {
        for (let attempt = 0; attempt < 6; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 500));
          const response = await this.fetcher(
            `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(record.generationId)}`,
            { headers: { authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(8000) },
          );
          const data = (await response.json()).data;
          if (
            response.ok &&
            typeof data?.total_cost === "number" &&
            Number.isFinite(data.total_cost) &&
            data.total_cost >= 0
          ) {
            record.costUsd = data.total_cost;
            record.provider = data.provider_name;
            record.actualModel = data.model;
            record.providerMs = data.generation_time;
            record.nativeTokens = {
              input: data.native_tokens_prompt,
              output: data.native_tokens_completion,
              cached: data.native_tokens_cached,
            };
            break;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      if (record.costUsd === null) this.blocked = true;
    }
  }
}
