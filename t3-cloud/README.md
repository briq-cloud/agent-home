# T3 Cloud connections

The public listener serves native T3 at `/` and owner connection management at `/_cloud/`.
Native T3 retains its own authentication. The manager uses a separate owner key and an opaque,
12-hour HttpOnly, SameSite=Strict session cookie (Secure on HTTPS). It never treats a gateway
header as the owner. Management mutations require the configured public Origin.

Set `T3_CLOUD_PUBLIC_ORIGIN` to the exact HTTPS origin and `T3_CLOUD_OWNER_KEY` to a private,
random key of at least 32 bytes. Central mode also requires a distinct private
`T3_CLOUD_EDGE_TOKEN` of at least 32 cookie-compatible ASCII characters for the private sandbox
transport. Open `/_cloud/` and enter only the owner key in its sign-in form. Keep both keys
out of URLs and browser storage. The public `PORT` defaults to 8080. Native T3 and ttyd bind loopback ports 3773 and
7681; expose only the public listener. Native T3 pairing is created by its CLI with a five-minute
expiry. Pairing responses are private and must not be recorded or stored in browser storage.

The default product role is `central`; it additionally requires a stable `T3_CLOUD_OWNER_ID` and the real broker
composition in `central-runtime.mjs`, an absolute `T3_CLOUD_STATE` directory, and a digest-pinned
`T3_CLOUD_CHILD_IMAGE`. The manager calls that same broker for Codex account
operations. Codex uses native device-code sign-in in that single app server; the owner opens
the verification URL and enters the displayed code. It does not start another Codex app server. Native T3's authenticated allocation RPC
calls the local allocation route using a dedicated process-private token, which authorizes no
other management operation. The owner identity comes from server configuration. Allocation
failure must never fall back to executing a central thread locally. The central runtime and
child image need independent security review and execution qualification before release.

The current replay guard keeps unadopted mutation markers across disconnects and restarts.
A WebSocket write callback permits the same live session to continue, but does not prove that
T3 adopted the native outcome. Reconnects cannot start or steer another turn while these
markers remain. Resume history does not clear an unknown outcome. Explicit correlated
reconciliation is not implemented; normal reconnect and sleep/resume are not release-qualified.

The broker also has a candidate scoped operation protocol. It journals an exact request hash
before dispatch and saves the native result before attempting transport delivery. The same
operation can retrieve that saved result across a broker restart; an uncertain operation never
dispatches again. Its adoption call requires a matching result hash, native identity, and event
sequence. The source integration candidate now reserves root intents before native dispatch,
records the returned native identity and result hash, and sends adoption after its first native
start event commits. Startup recovery uses the original intent and a read-only receipt when a
result or committed start exists; it retains the original run, attempt and provider turn rather
than issuing another native mutation. Pending or denied receipts remain parked for reconciliation.
Canonical history can replace partial progress and fill gaps only after the receipt is adopted.
The transport shim still has no reconnect loop, and legacy mutation markers remain quarantined.

The packaged source patch replays to the exact reviewed source tree. These remain candidate
paths: source checks and patch replay do not qualify native cloud allocation, subscription
execution, restart recovery or deployment.

The explicit diagnostic mode `T3_CLOUD_ROLE=standalone` has native T3 connections, Claude's native sign-in, Briq's native
browser sign-in, pairing, and an owner-protected terminal. Central Codex account operations,
thread allocation and the allocation-scoped Briq broker are unavailable in this mode.
Unrelated direct native MCP connections retain their own authorization.

In central mode, complete managed Briq sign-in through `/_cloud/`. Scoped resource operations
use the official CLI's central credential home, with sign-in, status and operations sharing one
credential owner. No separately copied `BRIQ_MCP_TOKEN` enables this executing-provider path.
Missing or expired CLI authentication leaves the tools unavailable; installed files alone do
not establish an authenticated connection.

The central Codex app server uses its managed `T3_CLOUD_STATE/codex` home and installs the
packaged Briq skill under `.agents/skills`. The broker supplies a separate loopback MCP
capability for each allocation on native thread start and resume. It removes the previous
managed global raw Briq MCP configuration. Unknown config edits, environment policy changes
and skill collisions stop startup. Broad Briq credentials are not forwarded to either provider.
Claude receives an in-process scoped server and the exact packaged guidance in its system
prompt; native Skill discovery, local tools, hooks and subagents remain disabled. Its enablement
gate stays closed pending the required qualification.

Use `briq_catalog` and `briq_docs` for the supported sandbox, postgres and redis recipes.
`briq_run` records newly created descendants; `briq_list` exposes only those resources.
Status, logs, execution, files and lifecycle tools accept their recorded IDs, excluding the
workspace root, central resources and other threads. Repository files and commands continue
through the allocation-bound workspace executor. Unknown mutations require reconciliation,
never automatic replay. Revocation invalidates capabilities and durably records cleanup;
failed descendant cleanup still attempts the exact workspace stop. Recovery checks unresolved
outcomes without replaying a stop.

The credential-free offline image fixture is configured to check bounded Claude
fake-provider/fake-CLI scenarios and native Codex per-thread MCP start/resume inventory
without model turns. Image CI remains pending.
It does not qualify cloud resources, subscription authentication, remote workspace composition
or deployment. Those acceptance and recovery gates remain required before enablement.

Vendor sign-in runs the installed CLI, preserves its existing credential home, and exposes only
its sign-in URL, device code, and state. The person approves in their own browser. Status comes
from vendor status commands; no token files are read. The vendor helper is a narrow extraction
of the existing Agent Home sign-in/status code, without its application or routing runtime.

The image installs exact locked dependencies, including `ws` 8.22.0, MCP SDK 1.29.0 and
Zod 4.6.5, with production-only `npm ci` and lifecycle scripts disabled. Local `node_modules` are excluded from its build
context. Manager, child and transport processes use the source-pinned Node 26.12.1 runtime;
the image also checks that `/bin/bash` is available for child execution.

Run the bounded manager contract tests with `node --test --test-timeout=20000 t3-cloud/manager.test.mjs`.
They use fake adapters and real loopback HTTP/WebSocket services; they do not qualify the broker,
a provider login, the image, or cloud allocation.
