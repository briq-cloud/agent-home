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
  scheduling/      UTC admission policies, opt-in persistent text batches
  verification/    caller-owned command and artifact acceptance
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
| Provider choices need live availability | Signed-in routes, quota checks and opt-in paid execution. Dynamic decisions are enabled by default but require an OpenRouter key and a positive per-task decision budget; `RUNNER_DYNAMIC_ROUTING=0` disables them. |
| Automatic models need exact approval | The operator's OpenRouter `auto:true` opt-in prepares up to four curated pinned models after public catalog checks. Catalog priors are not learned best-model results. |
| Unknown cost is not free | Null cost remains null across attempts. |
| Context has a source | Project, revision, path and content hash. |
| Memory is inspectable | Explicit write, provenance, expiry and deletion. |
| Delegation stays bounded | One coordinator and one yielded child per project; eight children per coordinator. Opt-in fleet slots require separate roots. |
| Tool credentials stay scoped | Attempt-fenced capabilities; no runner admin token. |
| Acceptance claims stay bounded | Caller-provided commands and artifact checks only; absent checks mean `unverified`. Commands run as the runner user, not in a sandbox. |

Root identities are immutable. New checkouts need new project IDs.
Source freshness means the selected snapshot; callers must refresh changed files/revisions.
Prompt recall excludes memories whose source hash or revision is no longer current. Inspection keeps those records visible.
Cancelled native prompts keep workspace slots until they settle. Cancellation alone does not prove the vendor stopped writing.
Provider caches remain vendor-managed. No semantic response cache serves stale code answers.
Standalone launches persist vendor homes beneath `RUNNER_LOGINS` unless an operator supplies explicit home paths.

The local baseline deliberately avoids mandatory Postgres, Redis and vector services.
T3 Code informs command/effect separation; its private packages are not imported.
Tencent memory and external durable engines remain evaluated alternatives.
The OpenRouter SDK batch adapter is opt-in, text-only, and separate from interactive ACP execution.

[Research decisions](research/2026-10-30-architecture.html) · [API](../runner/README.md)
