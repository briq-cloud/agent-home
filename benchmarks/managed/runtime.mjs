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
}) {
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
  // Deliberate allowlist: no BENCH_KEYS_FILE, provider keys, subscription auth dirs,
  // preloaded Node hooks or ambient API credentials reach the runner/harness.
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./entry.mjs", import.meta.url)), configPath],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: profileHome,
        TMPDIR: profileHome,
        LANG: "C.UTF-8",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logs = join(root, "private-runner.log");
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
    child.once("exit", r);
    child.once("error", r);
  });
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
    })());
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      await readFile(readyFile);
      ready = true;
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    await close();
    throw Error("managed runtime did not start (private-runner.log)");
  }
  const url = `http://127.0.0.1:${port}`;
  const api = async (method, path, input) => {
    const response = await fetch(url + path, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(input === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    if (!response.ok)
      throw Error(`managed API ${response.status}: ${JSON.stringify(value).slice(0, 400)}`);
    return value;
  };
  return { api, close, stateDir, profileHome, url };
}
