import { randomBytes, createHash, randomUUID } from "node:crypto";
import { Meter } from "../meter.mjs";

export const decisionModels = ["cloudflare/clef-flash", "typesafe/jev-1.14-20261014"];
const finiteCost = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
async function body(req, limit = 500_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw Error("request-limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function reply(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** One serialized, shared admission ledger across profiles, child tasks, native
 * retries and typed routing decisions. Provider keys stay in this relay only.
 * Meter's $0.20 unsettled-call allowance is admission, not a hard spend guarantee.
 */
export class ManagedMeter extends Meter {
  constructor({ profiles, chooser = decisionModels[0], ...options }) {
    if (!profiles?.length || profiles.length > 5 || !decisionModels.includes(chooser))
      throw Error("invalid managed meter configuration");
    super({ ...options, model: profiles[0].model });
    this.profiles = profiles;
    this.chooser = chooser;
    this.tokens = Object.fromEntries(
      profiles.map((profile) => [profile.id, randomBytes(24).toString("hex")]),
    );
    this.metadata = [];
    this.metadataCache = new Map();
    const upstream = this.fetcher;
    this.fetcher = async (url, options) => {
      const execution = new URL(url).pathname === "/api/v1/messages";
      const record = execution ? this.records.at(-1) : null;
      if (record) {
        record.managedRequestId ??= randomUUID();
        record.kind = "execution";
        record.dispatchedAt ??= new Date().toISOString();
        record.profile = this.profiles.find((profile) => profile.model === this.model)?.id;
        this.onRecord({ ...record, phase: "dispatched" }); // Persist before upstream paid work.
      }
      const response = await upstream(url, options);
      if (!record || !response.body) return response;
      let buffer = "";
      const decoder = new TextDecoder();
      const stream = response.body.pipeThrough(
        new TransformStream({
          transform: (chunk, controller) => {
            buffer = (buffer + decoder.decode(chunk, { stream: true })).slice(-64_000);
            const id = /"id"\s*:\s*"(gen-[A-Za-z0-9_-]+)"/.exec(buffer)?.[1];
            if (id && record.generationId !== id) {
              record.generationId = id;
              this.onRecord({ ...record, phase: "generation-observed" });
            }
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(stream, { status: response.status, headers: response.headers });
    };
  }
  async metadataRequest(path) {
    if (
      !/^\/api\/v1\/(?:models(?:\/[A-Za-z0-9._~%/-]+\/endpoints)?|benchmarks\?source=artificial-analysis)$/.test(
        path,
      )
    )
      throw Error("metadata path not allowed");
    if (!this.metadataCache.has(path)) {
      const response = await this.fetcher("https://openrouter.ai" + path, {
        headers: { authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok) throw Error("routing metadata unavailable");
      const content = await response.text();
      if (Buffer.byteLength(content) > 8_000_000) throw Error("metadata limit");
      this.metadataCache.set(path, JSON.parse(content));
      this.metadata.push({
        path,
        checkedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: Buffer.byteLength(content),
      });
    }
    return this.metadataCache.get(path);
  }
  async handle(req, res) {
    const path = req.url ?? "",
      authorization = req.headers.authorization;
    const profile = this.profiles.find(
      (candidate) => authorization === `Bearer ${this.tokens[candidate.id]}`,
    );
    if (path.split("?")[0] === "/v1/messages" && profile) {
      const previous = this.model,
        start = this.records.length;
      this.model = profile.model;
      req.headers.authorization = `Bearer ${this.token}`;
      try {
        await super.handle(req, res);
      } finally {
        for (const record of this.records.slice(start)) {
          record.kind = "execution";
          record.profile = profile.id;
        }
        this.model = previous;
      }
      return;
    }
    if (authorization !== `Bearer ${this.token}`)
      return reply(res, 403, { error: "relay credential required" });
    if (req.method === "GET" && path.startsWith("/api/v1/")) {
      try {
        return reply(res, 200, await this.metadataRequest(path));
      } catch {
        return reply(res, 503, { error: "routing metadata unavailable" });
      }
    }
    if (req.method !== "POST" || path !== "/api/alpha/decisions")
      return reply(res, 403, { error: "relay path not allowed" });
    if (!this.active || this.blocked) return reply(res, 429, { error: "meter stopped" });
    const input = await body(req, 128_000);
    if (
      !decisionModels.includes(input.model) ||
      !input.questions ||
      Object.values(input.questions).some((question) => question.type !== "choice")
    )
      return reply(res, 400, { error: "typed decision model and choice questions required" });
    // A declared experiment factor chooses Clef or Jev; the production Routing
    // state/choice schema is unchanged. Requested and actual chooser are recorded.
    const requestedChooser = input.model;
    input.model = this.chooser;
    while (
      this.spent +
        (this.records.filter((record) => record.costUsd === null).length + 1) *
          this.unsettledCallAllowanceUsd >
        this.budgetUsd &&
      this.pendingBilling.size &&
      !this.blocked
    )
      await Promise.race(this.pendingBilling);
    const trial = this.records.slice(this.active.start);
    if (
      this.blocked ||
      this.spent +
        (this.records.filter((record) => record.costUsd === null).length + 1) *
          this.unsettledCallAllowanceUsd >
        this.budgetUsd ||
      trial.reduce((sum, record) => sum + (record.costUsd ?? 0), 0) >= this.perTrialUsd ||
      trial.length >= this.maxCallsPerTrial
    ) {
      this.blocked = true;
      return reply(res, 429, { error: "managed admission allowance reached" });
    }
    const record = {
      ...this.active,
      start: undefined,
      managedRequestId: randomUUID(),
      kind: "routing",
      requestedModel: requestedChooser,
      model: input.model,
      costUsd: null,
      generationId: null,
      status: null,
    };
    this.records.push(record);
    this.onRecord({ ...record, phase: "dispatched" });
    try {
      const response = await this.fetcher("https://openrouter.ai/api/alpha/decisions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      record.status = response.status;
      const value = await response.json();
      record.actualModel = value.model;
      record.generationId = typeof value.id === "string" ? value.id : null;
      if (response.ok && finiteCost(value.usage?.cost)) {
        record.costUsd = value.usage.cost;
        record.costSource = "typed-decision-response-usage.cost";
        record.answers = value.answers;
        record.decisionFrozenAt = new Date().toISOString();
      } else this.blocked = true; // Error/unknown decision charges are never presumed free.
      return reply(res, response.status, value);
    } catch {
      this.blocked = true;
      return reply(res, 502, { error: "decision measurement unavailable" });
    } finally {
      this.onRecord({ ...record });
    }
  }
}

/** Deterministic provider double: production SDKs/HTTP still run, no inference. */
export function mockManagedFetcher(profiles) {
  let generation = 0;
  const models = new Map();
  return async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v1/models")
      return Response.json({
        data: profiles.map((profile, index) => ({
          id: profile.model,
          canonical_slug: profile.canonical,
          context_length: 64000,
          supported_parameters: ["tools"],
          architecture: { input_modalities: ["text"] },
          pricing: { prompt: String((index + 1) / 1e6), completion: "0.000002", request: "0" },
        })),
      });
    if (parsed.pathname === "/api/v1/benchmarks")
      return Response.json({
        meta: { as_of: new Date().toISOString(), citation: "mock-fixture-no-model-evidence" },
        data: profiles.map((profile) => ({
          source: "artificial-analysis",
          model_permaslug: profile.canonical,
          intelligence_index: 50,
          coding_index: 50,
          agentic_index: 50,
        })),
      });
    if (parsed.pathname.endsWith("/endpoints"))
      return Response.json({
        data: {
          id: decodeURIComponent(
            parsed.pathname.slice("/api/v1/models/".length, -"/endpoints".length),
          ),
          endpoints: [
            { status: 0, throughput_last_30m: { p50: 20 }, latency_last_30m: { p50: 1, p90: 2 } },
          ],
        },
      });
    if (parsed.pathname === "/api/alpha/decisions") {
      const input = JSON.parse(options.body),
        route = Object.keys(input.questions.route.criteria).find((id) => id !== "abstain");
      return Response.json({
        id: `mock-decision-${++generation}`,
        model: input.model,
        usage: { cost: 0, input_tokens: 1, output_tokens: 1 },
        answers: {
          type: { type: "choice", choice: "change" },
          route: { type: "choice", choice: route },
        },
      });
    }
    if (parsed.pathname === "/api/v1/messages") {
      const id = `gen-mock-${++generation}`;
      models.set(id, JSON.parse(options.body).model);
      return Response.json({
        id,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "mock" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    if (parsed.pathname === "/api/v1/generation")
      return Response.json({
        data: {
          total_cost: 0,
          model:
            profiles.find((profile) => profile.model === models.get(parsed.searchParams.get("id")))
              ?.canonical ?? models.get(parsed.searchParams.get("id")),
          provider_name: `mock-${profiles.find((profile) => profile.model === models.get(parsed.searchParams.get("id")))?.id ?? "provider"}`,
          native_tokens_prompt: 1,
          native_tokens_completion: 1,
        },
      });
    throw Error("unexpected mock provider URL");
  };
}
