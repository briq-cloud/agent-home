# Application boundaries

```text
runner/src/
  app/             configuration, composition, HTTP API
  acp/             vendor processes, sessions, direct and Auto transports
  providers/       CLI catalog, keys and isolated profiles
  auth/            vendor sign-in and non-secret status metadata
  orchestration/   executor, project registry, scoped delegation
  tasks/           SQLite migrations, DAGs, leases, messages
  context/         source snapshots, artifacts, explicit factual memory
  routing/         metadata adapters, candidates, typed decisions
  scheduling/      bounded UTC admission policies
  telemetry/       session usage and logs
  ui/              local page and assets
```

TypeScript runs on Node 22.18+. SQLite needs no database service.
Rust components can sit behind backend interfaces when their measured benefit justifies another runtime.

| Rule | Enforcement |
| --- | --- |
| Credentials stay with their owner | Separate provider settings; no subscription proxy. |
| Sessions retain their model | Auto checkpoint binds the actual CLI/session. |
| Side effects are not blindly replayed | Lease loss fails by default; explicit bounded retry. |
| Stale workers cannot finish tasks | Transactional leases and fencing tokens. |
| Provider choices need live availability | Signed-in routes, quota checks and opt-in paid execution. |
| Unknown cost is not free | Null cost remains null across attempts. |
| Context has a source | Project, revision, path and content hash. |
| Memory is inspectable | Explicit write, provenance, expiry and deletion. |
| Delegation stays bounded | One coordinator, one yielded child, eight children per coordinator. |
| Tool credentials stay scoped | Attempt-fenced capabilities; no runner admin token. |

Root identities are immutable. New checkouts need new project IDs.
Source freshness means the selected snapshot; callers must refresh changed files/revisions.
Provider caches remain vendor-managed. No semantic response cache serves stale code answers.

The local baseline deliberately avoids mandatory Postgres, Redis and vector services.
T3 Code informs command/effect separation; its private packages are not imported.
Tencent memory, external durable engines and batch adapters remain benchmark candidates.

[Research decisions](research/2026-10-30-architecture.html) · [API](../runner/README.md)
