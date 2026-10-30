// Isolated benchmark host. Runtime classes and /tasks handlers are production;
// only provider transport/profile credentials and signed-in inventory are local.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init),
    url = new URL(request.url);
  if (url.hostname !== "openrouter.ai") return nativeFetch(input, init);
  if (
    !(request.method === "GET" && url.pathname.startsWith("/api/v1/")) &&
    !(request.method === "POST" && url.pathname === "/api/alpha/decisions")
  )
    throw Error("benchmark upstream path forbidden");
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${config.relayToken}`);
  return nativeFetch(config.relayUrl + url.pathname + url.search, {
    method: request.method,
    headers,
    ...(request.method === "GET" ? {} : { body: await request.text() }),
    signal: request.signal,
    redirect: "error",
  });
};
const load = (file) => import(pathToFileURL(join(config.runnerSource, file)).href);
const [{ Application }, { Hub }, { Keys }, { configuration }, { cliEnv }] = await Promise.all([
  load("src/app/services.ts"),
  load("src/acp/hub.ts"),
  load("src/providers/profiles.ts"),
  load("src/app/config.ts"),
  load("src/providers/catalog.ts"),
]);
const keys = new Keys({
  keysFile: join(config.stateDir, "relay-key.json"),
  profilesFile: join(config.stateDir, "profiles.json"),
  logins: config.profileHome,
});
keys.putKey("openrouter", config.relayToken);
for (const profile of config.profiles)
  keys.putProfile({
    name: profile.id,
    provider: "openrouter",
    harness: "claude",
    model: profile.model,
    canonical: profile.canonical,
    autoEligible: true,
  });
const table = keys.profiles().map((profile) => {
  const cli = keys.cliOf(profile, { name: "claude", acp: config.harness });
  return {
    ...cli,
    env: {
      ...cli.env,
      ANTHROPIC_BASE_URL: config.relayUrl,
      ANTHROPIC_AUTH_TOKEN: config.profileTokens[profile.name],
      ANTHROPIC_API_KEY: null,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.maxOutputTokens),
      API_TIMEOUT_MS: "90000",
      ...(config.mode === "mock" ? { MANAGED_MOCK_FIXTURE: config.fixtureId } : {}),
    },
  };
});
const settings = configuration({
  RUNNER_CWD: config.workspace,
  RUNNER_STATE: config.stateDir,
  RUNNER_PORT: String(config.port),
  RUNNER_HOST: "127.0.0.1",
  RUNNER_MAX_TURNS: config.arm.delegation ? "2" : "1",
  RUNNER_FLEET_CONCURRENCY: config.arm.delegation ? "2" : "1",
  RUNNER_ORCHESTRATOR: "1",
  RUNNER_DYNAMIC_ROUTING: config.arm.auto ? "1" : "0",
  RUNNER_DELEGATION: config.arm.delegation ? "1" : "0",
  RUNNER_MEMORY: config.arm.memory ? "1" : "0",
  RUNNER_DEFERRED: "0",
  RUNNER_DEFAULT_ROUTE: config.baselineId,
});
const signedIn = async (id) => table.some((cli) => cli.name === id);
const authEnv = cliEnv({
  PATH: process.env.PATH ?? "",
  HOME: config.profileHome,
  TMPDIR: config.profileHome,
  LANG: "C.UTF-8",
  XDG_CONFIG_HOME: join(config.profileHome, "config"),
});
const hub = new Hub({
  clis: table,
  env: authEnv,
  cwd: config.workspace,
  stateDir: config.stateDir,
  maxTurns: settings.maxTurns,
  signedIn,
});
const application = new Application({
  config: settings,
  hub,
  keys,
  table: () => table,
  signedIn,
  authEnv,
});
const body = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 500_000) throw Error("body limit");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
};
const send = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname === "/delegate" && req.method === "POST") {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
        input = await body(req);
      res.once("close", () => {
        if (!res.writableEnded) application.delegation.disconnect(token);
      });
      return send(
        res,
        200,
        await application.delegation.call(token, input.action, input.input ?? {}),
      );
    }
    if (req.headers.authorization !== `Bearer ${config.adminToken}`)
      return send(res, 401, { error: "benchmark admin credential required" });
    if (!(await application.http(req, res, url, () => body(req))))
      send(res, 404, { error: "not found" });
  } catch {
    if (!res.headersSent) send(res, 400, { error: "benchmark request failed" });
  }
});
await new Promise((resolve) => server.listen(config.port, "127.0.0.1", resolve));
await writeFile(config.readyFile, JSON.stringify({ port: config.port }), { mode: 0o600 });
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    await application.stop();
    hub.stop();
    server.closeAllConnections();
    server.close();
  });
