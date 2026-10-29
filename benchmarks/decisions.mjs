import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { OpenRouter } from "@openrouter/sdk";
import { providerKey } from "./live.mjs";
import { decisionCases, rulesBaseline } from "./decision-cases.mjs";
export function scoreAnswers(answers, expected) {
  for (const k of ["kind", "route"]) {
    const a = answers?.[k];
    if (
      a?.type !== "choice" ||
      !{ kind: ["lookup", "change", "plan"], route: ["efficient", "capable", "abstain"] }[
        k
      ].includes(a.choice)
    )
      return { valid: false, pass: false };
  }
  return { valid: true, pass: Object.entries(expected).every(([k, v]) => answers[k].choice === v) };
}
export async function runDecisions() {
  const key = await providerKey(),
    root = resolve(process.env.BENCH_RESULTS ?? "results/decisions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sdk = new OpenRouter({
    apiKey: key,
    serverURL: "https://openrouter.ai",
    retryConfig: { strategy: "none" },
  });
  const models = ["cloudflare/clef-flash", "typesafe/jev-1.14-20261014"],
    rows = [];
  let spent = 0,
    stopped = null;
  for (const model of models) {
    for (const c of decisionCases) {
      if (stopped || spent >= 0.045) {
        stopped ??= "budget-target";
        break;
      }
      const start = performance.now();
      try {
        const response = await sdk.alpha.decisions.create(
          {
            decisionsRequest: {
              model,
              state: {
                task: c.text,
                routes: {
                  efficient: "Small bounded coding and source lookup tasks.",
                  capable: "Complex multi-component planning and difficult cross-system tasks.",
                },
              },
              questions: {
                kind: {
                  type: "choice",
                  instructions: "Classify the requested work.",
                  criteria: {
                    lookup: "Read existing sources and report facts without changing code.",
                    change: "Make a bounded code change.",
                    plan: "Create a plan for a complex project.",
                  },
                },
                route: {
                  type: "choice",
                  instructions:
                    "Choose the route under the stated policy. Use abstain only if there is insufficient information.",
                  criteria: {
                    efficient: "Small bounded coding and source lookup tasks.",
                    capable: "Complex multi-component planning and difficult cross-system tasks.",
                    abstain: "The task is too ambiguous to route.",
                  },
                },
              },
            },
          },
          { timeoutMs: 15000, retries: { strategy: "none" } },
        );
        const cost = response.usage?.cost;
        const validCost = typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
        const row = {
          id: c.id,
          split: c.split,
          requestedModel: model,
          actualModel: response.model,
          provider: response.provider,
          ms: performance.now() - start,
          costUsd: validCost ? cost : null,
          expected: c.expected,
          answers: response.answers,
          score: scoreAnswers(response.answers, c.expected),
          usage: response.usage,
        };
        rows.push(row);
        if (validCost) spent += cost;
        else stopped = "unknown-cost";
      } catch (e) {
        rows.push({
          id: c.id,
          split: c.split,
          requestedModel: model,
          error: e.statusCode ? `http-${e.statusCode}` : "request-failed",
          ms: performance.now() - start,
          costUsd: null,
        });
        stopped = "request-failed-cost-unknown";
      }
      await writeFile(
        join(root, "decisions.json"),
        JSON.stringify(
          {
            dataset: "24 human-labeled policy packets; not task-quality ground truth",
            rulesBaseline: decisionCases.map((c) => ({
              id: c.id,
              split: c.split,
              prediction: rulesBaseline(c.text),
              expected: c.expected,
            })),
            models,
            spentUsd: spent,
            stopped,
            rows,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
    if (stopped) break;
  }
  console.log(JSON.stringify({ requests: rows.length, spentUsd: spent, stopped, root }));
  return { rows, spent, stopped };
}
if (import.meta.url === new URL(process.argv[1], "file:").href) await runDecisions();
