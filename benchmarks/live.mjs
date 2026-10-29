import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { Meter } from "./meter.mjs";
export async function providerKey() {
  if (process.env.BENCH_PAID !== "1")
    throw Error("Set BENCH_PAID=1 for the explicitly budgeted paid experiment.");
  const file = process.env.BENCH_KEYS_FILE;
  if (!file) throw Error("BENCH_KEYS_FILE must point to the home API-key file.");
  const key = JSON.parse(await readFile(file, "utf8")).openrouter;
  if (typeof key !== "string" || !key) throw Error("OpenRouter key missing on home.");
  return key;
}
async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
export async function startLive(root) {
  const key = await providerKey(),
    model = process.env.BENCH_MODEL ?? "anthropic/claude-haiku-5.5";
  const catalog = await (
    await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15000) })
  ).json();
  const entry = catalog.data?.find((m) => m.id === model);
  if (!entry || model.includes("auto") || model.includes("latest") || model.startsWith("~"))
    throw Error("A fixed catalog model is required.");
  await writeFile(
    join(root, "model-snapshot.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        id: entry.id,
        canonical: entry.canonical_slug,
        pricing: entry.pricing,
      },
      null,
      2,
    ),
  );
  const meter = new Meter({
      key,
      model,
      onRecord: (record) =>
        appendFileSync(join(root, "meter.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 }),
    }),
    baseUrl = await meter.start(),
    port = await freePort(),
    token = randomBytes(24).toString("hex");
  const source = resolve(
    process.env.BENCH_RUNNER_SOURCE ?? fileURLToPath(new URL("../runner", import.meta.url)),
  );
  const { clis } = await import(pathToFileURL(join(source, "src/clis.ts")));
  const harness = clis({}).find((c) => c.name === "claude");
  if (!harness) throw Error("Claude adapter missing.");
  const configDir = join(root, "profile");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    RUNNER_HOST: "127.0.0.1",
    RUNNER_PORT: String(port),
    RUNNER_TOKEN: token,
    RUNNER_STATE: join(root, "runner-state"),
    RUNNER_LOGINS: configDir,
    RUNNER_MAX_TURNS: "1",
    RUNNER_ROUTE: "bench",
  };
  // The relay replaces this random internal credential with the provider key. No subscription config is used.
  env.RUNNER_CLIS = JSON.stringify([
    {
      name: "bench",
      acp: harness.acp,
      profile: { provider: "openrouter", harness: "claude", model },
      env: {
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: meter.token,
        ANTHROPIC_API_KEY: null,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048",
        API_TIMEOUT_MS: "90000",
      },
    },
  ]);
  delete env.BENCH_KEYS_FILE;
  delete env.OPENROUTER_API_KEY;
  const child = spawn(process.execPath, [join(source, "src/main.ts")], {
    env,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try {
      if (
        (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const close = async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await meter.close();
  };
  if (!ready) {
    await close();
    throw Error("Benchmark runner did not start.");
  }
  return {
    url: `ws://127.0.0.1:${port}/acp/bench`,
    token,
    meter,
    model: entry.id,
    canonical: entry.canonical_slug,
    close,
  };
}
