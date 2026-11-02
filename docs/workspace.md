# Home workspace

Connections holds native CLI sign-ins and provider keys. Chat offers Briq Agent (the existing Auto
orchestrator) and specific connected agents. Fleet, context, shared skills and MCP tools use the
same services whether work starts from the home or T3 Code. ACP is the agent transport; MCP adds
tools to an agent. No second scheduler is introduced.

## T3 Code

The image includes the official T3 Code 0.1.6 standalone Linux x64 release, checked against the
publisher's SHA-256. Start it explicitly from the T3 Code tab. Its state is isolated under
`RUNNER_STATE/t3`; existing native T3 configurations and sign-ins are never imported or rewritten.
The first launch creates a local **Briq Agent** provider using the image's `briq-agent-acp` wrapper.
Default native Claude/Codex providers are disabled to keep one owner for shared CLI sessions.
A conflicting native provider configuration blocks the managed launch until the operator resolves it.

T3 listens on loopback port 3773 by default. Set `RUNNER_T3_HOST=0.0.0.0` only when a trusted
gateway publishes that port. Set `RUNNER_T3_PUBLIC_URL` to its dedicated HTTP(S) origin. T3 uses
root API/WebSocket routes and its own authentication cookies, so a subpath URL is unsupported.
The runner's existing origin must remain available. Without a separate origin, the page starts
the local process but does not invent a browser link. Local operators can publish both ports
and use `http://localhost:3773` as the dedicated origin.

Create a browser pairing link on demand. The native T3 auth CLI issues a one-use link with a
five-minute lifetime. The authenticated home response is not cached, and the link is not persisted
in page storage or logs. Pairing authenticates the browser to T3; it does not sign in a CLI vendor.

For a private Briq gateway on the separate origin, set `RUNNER_T3_GATEWAY_URL_FILE` to an
absolute, owner-readable file with mode 0600 containing that endpoint's private URL. Its origin
must match `RUNNER_T3_PUBLIC_URL`; its only query parameter must be `briq_token`. Missing or
invalid configured files block navigation and pairing with a fixed error. The URL is never
included in service status. Open T3 Code uses the authenticated `/api/services/t3/open` redirect
with no-store and no-referrer headers. Pairing adds the gateway token to the private one-use link
so a fresh browser can acquire the gateway cookie before native T3 authentication. Keep this
file and pairing links private. Standalone origins without a gateway need no gateway file.

The local ACP wrapper connects to `/acp/auto` over loopback and reads its runner token from a private
file. T3 settings contain no runner token. The wrapper passes an allowlisted environment to the
existing bridge; native subscription credential folders remain with the runner.
Each new T3 conversation resolves its actual working directory to an immutable project root
inside `RUNNER_CWD`. Existing project identities are reused; new directories receive stable
project IDs. Outside paths and symlinks escaping the workspace are rejected before any task starts.

OpenRouter routing is off for T3 by default. Its checkbox records `optinOpenRouter` for new bridge
connections. After changing it, reconnect the Briq Agent in T3. A saved OpenRouter key, eligible
profiles and ordinary routing gates are still required. Admission estimates are $0.10 per task
for API execution and $0.001 for decision calls; CLI execution charges remain unknown and these
are not hard billing caps. Existing conversations retain their original consent.

The runner owns and stops the T3 process on shutdown. Startup reports process state, not a model
qualification or successful vendor connection. It never starts inference merely to check status.

## Terminal and Briq

The Terminal tab opens the existing authenticated persistent terminal. The Briq tab checks
`briq whoami --json` and starts the native `briq login` browser flow. Its existing native login is
retained; credential values and raw command output are not returned. Select Check connection
after starting sign-in to retrieve the approval link and completion status. The CLI and the
shared Briq MCP tool connection are distinct; manage shared tools in Tools.
The image includes the pinned native `@briq-cloud/cli@0.1.3` with a complete integrity-checked
npm lockfile and a build-time version check. The standalone supervisor persists its sign-in
under `BRIQ_CONFIG_DIR`, defaulting to `RUNNER_LOGINS/config/briq`. Set `BRIQ_API_URL` to the
deployment's API origin before starting the home when using a nonproduction environment.

## Optional DSH

The image also installs the pinned DSH preview. Its experimental ACP route requires explicit
operator configuration and selection, and is excluded from default Auto routing.
See [DSH configuration and lifecycle limits](../dsh/README.md).
