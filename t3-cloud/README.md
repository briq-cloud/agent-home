# T3 Cloud connections

The public listener serves native T3 at `/` and owner connection management at `/_cloud/`.
Native T3 retains its own authentication. The manager uses a separate owner key and an opaque,
12-hour HttpOnly, SameSite=Strict session cookie (Secure on HTTPS). It never treats a gateway
header as the owner. Management mutations require the configured public Origin.

Set `T3_CLOUD_PUBLIC_ORIGIN` to the exact HTTPS origin and `T3_CLOUD_OWNER_KEY` to a private,
random key of at least 32 bytes. Open `/_cloud/` and enter the key in its sign-in form. Keep it
out of URLs. The public `PORT` defaults to 8080. Native T3 and ttyd bind loopback ports 3773 and
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

The packaged source patch has not yet been refreshed with that source candidate. These are
implemented candidate paths, not native subprocess, cloud allocation, or restart qualification.
Release requires the refreshed source patch, focused review and CI, then composed native
client and restart/recovery evidence. No deployment or image conformance is established here.

The explicit diagnostic mode `T3_CLOUD_ROLE=standalone` has native T3 connections, Claude's native sign-in, Briq's native
browser sign-in, pairing, and an owner-protected terminal. Central Codex account operations and
thread allocation are unavailable without the broker. The CLI's sign-in and an MCP capability
are separate: a configured MCP token is reported as unverified, never as CLI authentication.

Vendor sign-in runs the installed CLI, preserves its existing credential home, and exposes only
its sign-in URL, device code, and state. The person approves in their own browser. Status comes
from vendor status commands; no token files are read. The vendor helper is a narrow extraction
of the existing Agent Home sign-in/status code, without its application or routing runtime.

The image installs the runtime's exact locked `ws` 8.22.0 dependency with production-only
`npm ci` and lifecycle scripts disabled. Local `node_modules` are excluded from its build
context. Manager, child and transport processes use the source-pinned Node 26.12.1 runtime;
the image also checks that `/bin/bash` is available for child execution.

Run the bounded manager contract tests with `node --test --test-timeout=20000 t3-cloud/manager.test.mjs`.
They use fake adapters and real loopback HTTP/WebSocket services; they do not qualify the broker,
a provider login, the image, or cloud allocation.
