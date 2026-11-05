# T3 source build

T3 Code is built from MIT-licensed `pingdotgg/t3code` commit
`2359643cffa6ba9ee84d6f2694b935de54a8013e` (v0.1.6), using its frozen
pnpm lock, Node 26.12.1 and pnpm 12.14.0. `source.json` records the source,
lock and patch hashes. The resource monitor is the unchanged sidecar from the
checksum-verified upstream v0.1.6 archive. No release executable is patched.

The shared native CLI stage pins Codex 0.166.0, recorded in `source.json`, for
the central app-server and child exec-server. CI resolves that exact release's
package digest and checks the installed version against the packaged metadata.
Local builds default to the same version; an empty Codex build argument fails.
T3 builds also reject a Codex version override that differs from `source.json`;
Agent Home builds may override the version independently.

The patch adds `orchestration.allocateSandboxThread` to the native RPC group
(`packages/contracts/src/rpc.ts`), protected by the same orchestration write
scope as thread creation (`clientRpcPermissions.ts`, server
`auth/RpcAuthorization.ts`). The home forwards only the assigned thread ID to
a fixed loopback allocator with an allocation-only capability. Desktop and web
clients use their authenticated native environment connection, then native
pairing to register the child environment. Allocation failure creates no local
thread. Unpatched clients cannot create threads on the home.

Home mode allows only native connection/bootstrap and allocation RPCs. HTTP
access is restricted to native authentication, sidebar database snapshots and
the packaged UI; workspace, signed asset, upload, guest, device and MCP routes
are denied before handlers, including previously issued signed URLs. The home
New thread button works without a home project and requires a write grant.

Home mode denies native provider execution and thread creation. Child mode
accepts only its allocated user thread and the central Codex bridge; other
providers, forks and delegated creation are unavailable. The event-store gate
also covers imports and internal event writers (`orchestration-v2/EventStore.ts`,
`EventSink.ts`, `project/AgentSessionImporter.ts`). Native files, git, terminals
and checkpoints remain in the child environment.

The packaged source patch is refreshed to checkpoint `3c16fb5937386a51405280742dfa87004cc04f65` and includes durable root-intent reservation, result persistence and adoption tied to the first committed native start event. Startup recovery keeps the original run, attempt and provider turn, uses a read-only receipt when an outcome or committed start is known, and reconciles canonical history after adoption. Pending and denied receipts remain parked. This describes the packaged source checkpoint; it does not establish native subprocess, cloud, or restart/recovery qualification.

This is an integration candidate with no native subprocess, cloud, or restart/recovery
qualification. Release requires focused code/security review,
image CI, and an actual native client check against the composed allocator,
bridge and child runtime. Unit checks alone do not establish that conformance.
