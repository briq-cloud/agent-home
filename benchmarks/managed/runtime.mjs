import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile, appendFile, access, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { constants } from "node:fs";

/** Resolve the exact production adapter environment without starting a vendor
 * process, opening auth state, or sending a model request. Run before intents.
 */
export async function preflightManagedRuntime({
  mode = "live",
  runnerSource = resolve(fileURLToPath(new URL("../../runner", import.meta.url))),
  path = process.env.PATH ?? "",
  profileHome,
} = {}) {
  if (!profileHome) throw Error("preflight requires an isolated profile home");
  const { clis, cliEnv, which } = await import(
    pathToFileURL(join(runnerSource, "src/providers/catalog.ts"))
  );
  const env = cliEnv({
    PATH: path,
    HOME: profileHome,
    TMPDIR: profileHome,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: join(profileHome, "config"),
  });
  const harness = clis({}).find((cli) => cli.name === "claude")?.acp;
  const executable = async (file, label) => {
    if (!file) throw Error(`${label} was not resolved by production cliEnv/PATH`);
    try {
      await access(file, constants.X_OK);
      if (!(await stat(file)).isFile()) throw Error("not a file");
    } catch {
      throw Error(`${label} is not an executable file`);
    }
  };
  if (mode === "live") {
    await executable(env.CLAUDE_CODE_EXECUTABLE, "Claude native executable");
    await executable(
      harness?.[0]?.includes("/") ? harness[0] : which(harness?.[0] ?? "", path),
      "Claude ACP adapter",
    );
  }
  return {
    status: "passed",
    checkedAt: new Date().toISOString(),
    productionHelper: "cliEnv",
    mode,
    nativeExecutable: env.CLAUDE_CODE_EXECUTABLE ?? null,
    adapterExecutable: harness?.[0] ?? null,
    executableChecks: mode === "live",
    modelCalls: 0,
    authReads: 0,
  };
}

export async function startManagedRuntime({
  root,
  workspace,
  arm,
  profiles,
  meter,
  relayUrl,
  fixtureId,
  mode = "mock",
  maxOutputTokens = 4096,
  runnerSource = resolve(fileURLToPath(new URL("../../runner", import.meta.url))),
  startupMs = 45_000,
  entryPath = fileURLToPath(new URL("./entry.mjs", import.meta.url)),
}) {
  if (!Number.isSafeInteger(startupMs) || startupMs < 100 || startupMs > 60_000)
    throw Error("invalid managed startup deadline");
  const portServer = createServer();
  await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
  const port = portServer.address().port;
  await new Promise((r) => portServer.close(r));
  const profileHome = join(root, "api-profile"),
    stateDir = join(root, "runner-state"),
    readyFile = join(root, "ready.json");
  await mkdir(profileHome, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const { clis } = await import(pathToFileURL(join(runnerSource, "src/providers/catalog.ts")));
  const harness =
    mode === "mock"
      ? [process.execPath, fileURLToPath(new URL("./mock-agent.mjs", import.meta.url))]
      : clis({}).find((cli) => cli.name === "claude")?.acp;
  if (!harness) throw Error("Claude API harness unavailable");
  const adminToken = randomBytes(24).toString("hex");
  const config = {
    mode,
    port,
    root,
    workspace,
    arm,
    profiles,
    fixtureId,
    profileHome,
    stateDir,
    readyFile,
    runnerSource,
    harness,
    adminToken,
    relayUrl,
    relayToken: meter.token,
    profileTokens: meter.tokens,
    baselineId: profiles[0].id,
    maxOutputTokens,
  };
  const configPath = join(root, "private-runtime.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const logs = join(root, "private-runner.log"),
    lifecyclePath = join(root, "private-lifecycle.json");
  await writeFile(logs, "", { mode: 0o600 });
  const lifecycle = {
    startedAt: new Date().toISOString(),
    startupMs,
    pid: null,
    ready: false,
    exitCode: null,
    signal: null,
    spawnError: null,
  };
  // Deliberate allowlist: no BENCH_KEYS_FILE, provider keys, subscription auth dirs,
  // preloaded Node hooks or ambient API credentials reach the runner/harness.
  const child = spawn(process.execPath, [entryPath, configPath], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: profileHome,
      TMPDIR: profileHome,
      LANG: "C.UTF-8",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  lifecycle.pid = child.pid ?? null;
  let logBytes = 0;
  const log = (chunk) => {
    if (logBytes < 256_000) {
      logBytes += chunk.length;
      void appendFile(logs, chunk.subarray(0, 256_000 - Math.max(0, logBytes - chunk.length)), {
        mode: 0o600,
      });
    }
  };
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  const exited = new Promise((r) => {
    child.once("exit", (code, signal) => {
      lifecycle.exitCode = code;
      lifecycle.signal = signal;
      lifecycle.exitedAt = new Date().toISOString();
      r();
    });
    child.once("error", (error) => {
      lifecycle.spawnError = error.code ?? error.name;
      r();
    });
  });
  await writeFile(lifecyclePath, JSON.stringify(lifecycle), { mode: 0o600 });
  let closed;
  const close = () =>
    (closed ??= (async () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      let timer;
      await Promise.race([
        exited,
        new Promise((r) => {
          timer = setTimeout(r, 3000);
        }),
      ]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        await exited;
      }
      await writeFile(lifecyclePath, JSON.stringify(lifecycle), { mode: 0o600 });
    })());
  let ready = false;
  const startupDeadline = Date.now() + startupMs;
  while (Date.now() < startupDeadline) {
    if (child.exitCode !== null || child.signalCode !== null || lifecycle.spawnError) break;
    try {
      await readFile(readyFile);
      ready = true;
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    await close();
    throw Error(
      `managed runtime did not start: exit=${lifecycle.exitCode} signal=${lifecycle.signal} error=${lifecycle.spawnError} (private-lifecycle.json/private-runner.log)`,
    );
  }
  lifecycle.ready = true;
  lifecycle.readyAt = new Date().toISOString();
  await writeFile(lifecyclePath, JSON.stringify(lifecycle), { mode: 0o600 });
  const url = `http://127.0.0.1:${port}`;
  const api = (method, path, input) => managedApiRequest(url, adminToken, method, path, input);
  return { api, close, stateDir, profileHome, url };
}

/** Retry bounded local GET transport failures only. A mutation is never replayed
 * after an uncertain response. Avoid keepalive sockets across process churn. */
export async function managedApiRequest(
  url,
  token,
  method,
  path,
  input,
  { fetcher = fetch, retryDelayMs = 100 } = {},
) {
  const attempts = method === "GET" ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response, value;
    try {
      response = await fetcher(url + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          connection: "close",
          ...(input === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        signal: AbortSignal.timeout(15000),
      });
      value = await response.json();
    } catch (error) {
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw Error(
        `managed API transport ${method} ${path}: ${error.cause?.code ?? error.code ?? error.name}`,
      );
    }
    if (!response.ok)
      throw Error(`managed API ${response.status}: ${JSON.stringify(value).slice(0, 400)}`);
    return value;
  }
}
