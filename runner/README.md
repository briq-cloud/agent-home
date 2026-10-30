# Runner API

```sh
curl -H "Authorization: Bearer $RUNNER_TOKEN" -H 'Content-Type: application/json' \
  http://localhost:8090/tasks -d '{
    "projectId":"home", "prompt":"Implement the project and run its tests.",
    "route":{"mode":"auto"}, "maxRuntimeMs":1800000
  }'
```

The response contains a task ID. Work continues after the client disconnects.
Use `route: {mode:"explicit", agentId:"codex"}` to select a harness.
New conversations stay on their selected route.
ACP clients use `/acp/auto`; `_meta.agentHome.cli` pins an explicit provider.
`_meta.agentHome.modeId` selects an advertised vendor mode.
Raw `/acp/<cli>` remains available without managed task services.

## Tasks and projects

| Endpoint | Input / result |
| --- | --- |
| `GET /features` | Enabled services and execution limits. |
| `GET /projects` | Registered roots and revisions. |
| `PUT /projects/:id` | `{root,revision}`; roots stay inside `RUNNER_CWD` and cannot be retargeted. |
| `POST /routing/models` | Prepare or refresh the curated Auto model pool from the public catalog. |
| `GET /routing/models` | List exact-version profiles approved for Auto. |
| `POST /tasks` | Task submission; default runtime limit is 30 minutes. |
| `POST /tasks/batch` | `{tasks:[...]}`; atomic dependency graph, up to 100 tasks. |
| `GET /tasks?projectId=home&limit=100&offset=0` | Task page and `nextOffset` (`null` at the end). |
| `GET /tasks/:id` | Status, references, attempt and lease state. |
| `POST /tasks/:id/cancel` | Cancel the task and its active children. |
| `POST /tasks/:id/retry` | Explicit retry, within the original attempt allowance. |
| `GET /tasks/:id/permissions` | Live permission requests. |
| `POST /tasks/:id/permissions/:requestId` | `{optionId}`; only offered options are accepted. |

A task supports optional `title` (up to 160 characters), `id`, `parentId`, `dependencyIds`, `inputRefs`, `deadline`, `notBefore`,
`maxAttempts`, `maxRuntimeMs`, `modeId`, `acceptance`, and explicit routing/context options.
Dependency failure blocks queued dependents. Crashed attempts require review before retry.
Task listings include the bounded title and a live `waitReason` when the runner can prove it:
prerequisites, scheduled start, approval, yielded coordinator, draining vendor request, capacity or workspace.
Titles default to the first nonempty instruction line; older rows are backfilled in bounded batches.
Unknown wait states stay null. Historical permission records alone do not imply a live approval request.
`modeId` must be advertised by the chosen CLI. No unattended permission mode is selected implicitly.

For API execution, pass `allowPaidApi:true`. Priced routing also needs `maxEstimatedUsd`.
`RUNNER_DYNAMIC_ROUTING` defaults to `1`, making dynamic decisions available. It does not trigger
inference by itself: a decision call also requires an OpenRouter key and a positive per-task
`decisionBudgetUsd`. Set `RUNNER_DYNAMIC_ROUTING=0` to disable dynamic decisions globally.
Estimates guard admission. CLI execution charges remain unknown; these are not hard dollar caps.

## Profiles

```json
{
  "provider":"openrouter", "harness":"claude",
  "model":"deepseek/deepseek-v4.1-flash-1017",
  "name":"openrouter-claude-fast", "autoEligible":true
}
```

Saving an OpenRouter key with `auto:true` at `PUT /keys/openrouter` prepares up to four curated,
pinned-model Auto profiles: Haiku, Sonnet, DeepSeek and GLM. A profile is added only after its exact
version passes public catalog checks for context, text, tools and pricing. This checks catalog
metadata, not successful harness execution. The operator can edit or remove profiles. These catalog
priors are a starting pool, not learned best-model results. `POST /routing/models` prepares or
refreshes the pool; `GET /routing/models` lists eligible profiles. `POST /profiles` creates an
individual profile; automatic use still requires approval and an exact catalog version. Multiple
named profiles can share a provider key. Each has its own settings folder.

## Context, memory and communication

```json
{"context":{"revision":"git-sha-or-snapshot","paths":["src/config.ts"],"memoryQuery":"config precedence"}}
```

Selected sources receive content hashes. Known credential paths are rejected.
Memory content is untrusted reference data. A current snapshot does not prove that disk files remain unchanged.

| Endpoint | Input / result |
| --- | --- |
| `POST /artifacts/:projectId` | `{content}` → project-scoped hash reference. |
| `GET /artifacts/:projectId/:hash` | Bounded artifact content. |
| `PUT /context/source` | `{project,revision,path,content}` → source reference. |
| `PUT /memories` | `{project,key,text,source:{path,hash,revision},expiresAt?}`. |
| `GET /memories?projectId=home&query=...` | Bounded FTS recall with provenance. |
| `DELETE /memories/:projectId/:key` | Forget one fact. |
| `POST /messages` | `{projectId,taskId?,recipient,text,idempotencyKey}`. |
| `GET /messages?projectId=home&limit=100&offset=0` | Message page and `nextOffset`. |

Enable `RUNNER_DELEGATION=1` to expose task-scoped MCP tools to executor sessions.
The coordinator spawns children, yields with `home_task_wait`, reads results and exchanges messages.
Children cannot spawn grandchildren. Cancelling a wait cancels its coordinator.
Shared-workspace coordination is cooperative; it is not an OS write lock.

Set `RUNNER_FLEET_CONCURRENCY=4` and `RUNNER_MAX_TURNS=4` for two independent coordinator/child pairs.
Values `6` and `8` allow three or four pairs. Each pair reserves a child slot to avoid deadlocks.
Canonical project roots must be separate folders or worktrees. Aliases and nested roots serialize.
Cancelled native prompts retain their slots until the vendor finishes; `/features.fleet` lists draining tasks.
Keep active checkout folders in place. External processes and raw ACP clients are outside this coordination.
The page provides a project fleet inspector, task creation, dependencies, permissions and durable messages.
Messages are stored for recipient polling; sending one does not wake an agent.

## Acceptance checks

Tasks may include `acceptance:{commands:[{argv:["npm","test"],timeoutMs:30000}],artifacts:[{path:"dist/app.js",sha256:"<64 hex characters>"}]}`.
The same option is accepted at ACP `session/new` as `_meta.agentHome.acceptance`. Checks are bounded
to four commands, sixteen artifacts and 120 seconds total. Commands are owner-provided argv executed
as the runner's user, without a shell; they are not sandboxed. Credential paths are refused for
artifact checks. No declared checks means the result is `unverified`, not passed.

## Deferred tasks

Pass `schedule:{flexibleDeadline:true,userWindows:[{start:"22:00",end:"24:00"}]}` with a deadline.
Windows use UTC. Pricing schedules additionally require source, expiry, provider and exact model evidence.
The executor rechecks that evidence against the selected route before execution.
Scheduling a CLI at night does not turn it into a batch API request.
Deferred jobs need an awake home; arranging external wake scheduling is a deployment responsibility.

## Offline text batches

Enable `RUNNER_BATCH=1` with an OpenRouter key. This handles summarize, extract and rewrite jobs separately from CLI sessions.

```json
{
  "idempotencyKey":"release-notes-1", "operation":"summarize",
  "model":"anthropic/claude-haiku-5.5", "allowPaid":true, "budgetEstimateUsd":0.01,
  "items":[{"id":"notes","text":"The release adds tenant-scoped cache invalidation."}]
}
```

| Endpoint | Result |
| --- | --- |
| `POST /text-batches` | Submit once with the body above; repeating the same key and intent returns the stored job. |
| `GET /text-batches?limit=100&offset=0` | Local job history. |
| `GET /text-batches/:id` | Durable state, text results and reported cost; unknown cost stays null. |
| `POST /text-batches/:id/poll` | Refresh the existing provider ID. |

The provider may take 24 hours. It currently has no batch cancellation endpoint.
At most 16 jobs remain unsettled, with 16 text items each. Inputs and outputs are bounded.
`RUNNER_BATCH_MAX_ESTIMATED_USD` limits the caller estimate; it does not cap provider charges.
Ambiguous submissions remain `submission_unknown` and are never automatically repeated.
The runner polls stored jobs while awake and resumes after restart. Provider retention is 30 days.
Vendor subscription traffic, interactive tools and typed routing decisions use their existing paths.

For standalone launches, `bin/agent-home-start` defaults each vendor home under
`$RUNNER_LOGINS` (`claude`, `codex`, `copilot`, `grok`, `vibe`, `config`, `gemini`) and respects
explicit home-variable overrides. The writable terminal runs in `tmux` so it survives tab
disconnects.

[ACP, sign-in and usage reference](../docs/transport.md) · [Architecture](../docs/architecture.md)

## Optional semantic memory search

Set `RUNNER_SEMANTIC_MEMORY=1` alongside `RUNNER_MEMORY=1` and an OpenRouter key.
`POST /memories/search` accepts `{projectId,revision,query,allowPaid:true,budgetEstimateUsd,idempotencyKey}`.
The default estimate ceiling is $0.01; `RUNNER_SEMANTIC_MEMORY_MAX_ESTIMATED_USD` can raise it to $0.10.
Estimates are admission checks, not provider billing caps.

The pinned BGE-M3 model on DeepInfra ranks up to 64 current project facts. Provider fallback is disabled.
Results include source citations,
coverage, similarity scores and nullable provider cost. Scores are not confidence or factual answers.
Source and query vectors are cached; new cache-only requests cost zero. No automatic prompt injection occurs.
Completed idempotency keys replay only while citations remain current; unknown requests never resubmit.
The private cache retains up to 1,024 intents, then refuses new ones to preserve replay protection.

## Shared skills and tools

The owner page and `/extensions` API manage shared skills and MCP connections.
`RUNNER_EXTENSIONS=0` disables this feature. See [configuration and compatibility](../docs/extensions.md).
