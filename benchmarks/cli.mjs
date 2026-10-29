import { mkdir, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import BenchmarkProvider from "./provider.mjs";
import { tasks } from "./fixtures.mjs";
import { startMock } from "./mock.mjs";
import { report } from "./report.mjs";
process.env.PROMPTFOO_DISABLE_TELEMETRY = "1";
process.env.PROMPTFOO_DISABLE_UPDATE = "1";
const mode = process.argv[2];
if (!["mock", "live"].includes(mode)) throw Error("usage: node cli.mjs mock|live");
const root = resolve(
  process.env.BENCH_RESULTS ??
    fileURLToPath(
      new URL(`results/${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`, import.meta.url),
    ),
);
await mkdir(root, { recursive: true, mode: 0o700 });
process.env.PROMPTFOO_CONFIG_DIR = join(root, ".promptfoo");
const runtime =
  mode === "mock" ? await startMock() : await (await import("./live.mjs")).startLive(root);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  });
const provider = new BenchmarkProvider({
  config: { root: join(root, "work"), timeoutMs: 90000, allowTools: mode === "live" },
  runtime: {
    url: runtime.url,
    token: runtime.token ?? "mock",
    begin: runtime.meter ? (label) => runtime.meter.begin(label) : undefined,
    end: runtime.meter
      ? () => runtime.meter.end()
      : async () => ({ costUsd: 0, provenance: "mock" }),
  },
});
try {
  const { evaluate } = await import("promptfoo");
  const tests = tasks.flatMap((task, i) =>
    (i % 2 ? ["context-pack", "baseline"] : ["baseline", "context-pack"]).map((arm) => ({
      vars: { taskId: task.id, arm },
      assert: [
        {
          type: "javascript",
          value: "JSON.parse(output).grade.pass === true && JSON.parse(output).error === null",
        },
      ],
    })),
  );
  await evaluate(
    {
      description: "agent-home paired smoke v0.1",
      providers: [provider],
      prompts: ["Task {{taskId}} ({{arm}})"],
      tests,
      writeLatestResults: false,
    },
    {
      cache: false,
      maxConcurrency: 1,
      repeat: 1,
      progressBar: false,
      showProgressBar: false,
      write: false,
      maxRetries: 0,
    },
  );
  if (runtime.meter) await runtime.meter.settle();
  const files = (await readdir(join(root, "work"))).filter((f) => f.endsWith(".result.json"));
  const records = await Promise.all(
    files.map((f) => readFile(join(root, "work", f), "utf8").then(JSON.parse)),
  );
  if (runtime.meter)
    for (const record of records) {
      const generations = runtime.meter.records.filter(
        (g) => g.taskId === record.taskId && g.arm === record.arm,
      );
      record.generations = generations;
      record.costUsd = generations.some((g) => g.costUsd === null)
        ? null
        : generations.reduce((n, g) => n + g.costUsd, 0);
      record.billingPending = false;
      record.billingFinalizedAt = new Date().toISOString();
    }
  records.sort(
    (a, b) =>
      tasks.findIndex((t) => t.id === a.taskId) - tasks.findIndex((t) => t.id === b.taskId) ||
      a.arm.localeCompare(b.arm),
  );
  const summary = await report(root, records, {
    mode,
    model: runtime.model ?? "mock",
    canonical: runtime.canonical ?? null,
  });
  console.log(JSON.stringify({ root, mode, arms: summary.arms }));
  if (
    records.length !== 12 ||
    records.some(
      (r) =>
        r.error || (mode === "mock" && !r.grade.pass) || (mode === "live" && r.costUsd === null),
    )
  )
    process.exitCode = 1;
} finally {
  await runtime.close();
}
