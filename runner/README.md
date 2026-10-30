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
| `POST /tasks` | Task submission; default runtime limit is 30 minutes. |
| `POST /tasks/batch` | `{tasks:[...]}`; atomic dependency graph, up to 100 tasks. |
| `GET /tasks?projectId=home` | Up to 100 tasks. |
| `GET /tasks/:id` | Status, references, attempt and lease state. |
| `POST /tasks/:id/cancel` | Cancel the task and its active children. |
| `POST /tasks/:id/retry` | Explicit retry, within the original attempt allowance. |
| `GET /tasks/:id/permissions` | Live permission requests. |
| `POST /tasks/:id/permissions/:requestId` | `{optionId}`; only offered options are accepted. |

A task supports `id`, `parentId`, `dependencyIds`, `inputRefs`, `deadline`, `notBefore`,
`maxAttempts`, `maxRuntimeMs`, `modeId`, and explicit routing/context options.
Dependency failure blocks queued dependents. Crashed attempts require review before retry.
`modeId` must be advertised by the chosen CLI. No unattended permission mode is selected implicitly.

For API execution, pass `allowPaidApi:true`. Priced routing also needs `maxEstimatedUsd`.
Dynamic decisions need `decisionBudgetUsd` and `RUNNER_DYNAMIC_ROUTING=1`.
Estimates guard admission. CLI execution charges remain unknown; these are not hard dollar caps.

## Profiles

```json
{
  "provider":"openrouter", "harness":"claude",
  "model":"deepseek/deepseek-v4.1-flash-1017",
  "name":"openrouter-claude-fast", "autoEligible":true
}
```

`POST /profiles` creates the named profile and pins its catalog version for automatic routing.
Approve models after checking their harness compatibility. A catalog score does not prove tool support.
Multiple named profiles can share a provider key. Each has its own settings folder.

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
| `GET /messages?projectId=home` | Durable project messages. |

Enable `RUNNER_DELEGATION=1` to expose task-scoped MCP tools to executor sessions.
The coordinator spawns children, yields with `home_task_wait`, reads results and exchanges messages.
Children cannot spawn grandchildren. Cancelling a wait cancels its coordinator.
Shared-workspace coordination is cooperative; it is not an OS write lock.

## Deferred tasks

Pass `schedule:{flexibleDeadline:true,userWindows:[{start:"22:00",end:"24:00"}]}` with a deadline.
Windows use UTC. Pricing schedules additionally require source, expiry, provider and exact model evidence.
The executor rechecks that evidence against the selected route before execution.
Scheduling a CLI at night does not turn it into a batch API request.

[ACP, sign-in and usage reference](../docs/transport.md) · [Architecture](../docs/architecture.md)
