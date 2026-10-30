# Managed execution experiment

This is separate from the earlier ACP prompt/context-pack benchmark. Every arm
submits through production `Application.http` `/tasks`, `Engine`, durable task
storage, `Routing`, and `ContextStore`. Delegation uses the production MCP tool
process and capability-scoped `/delegate` methods. There are no runtime changes.

The isolated host adapts only provider connections: fresh API-only Claude profile
directories, per-profile relay credentials/model pins, and a benchmark-only fetch
relay for the real typed OpenRouter decision SDK and routing metadata. The real
provider key stays in the parent relay. Subscription credentials and ambient API
keys are excluded from the host and harness environment. Clef Flash is the
default; `BENCH_CHOOSER=typesafe/jev-1.14-20261014` selects Jev at the relay while
retaining the production classification inputs and typed-choice schema. Both the
requested and actual decision model are recorded.

## Protocol

Two new multi-file repair cases use fresh workspaces and identical deterministic
acceptance across arms. Gold and grader code remain outside those workspaces.
All policy facts injected as memory also exist in baseline source files. Curated
context paths are an injection upper bound, not a retrieval-quality measurement.
No model grades another model.

Fixture version 2 explicitly specifies every checked behavior, including invoice
row kinds, signed decimal grammar, duplicate-before-validation rules, integer
range/zero normalization, and request timing/error/retry semantics. Earlier
invoice runs used an underspecified contract and cannot support quality claims;
retain their cost accounting separately. Results record each fixture version and
content hash, so revisions cannot silently replace earlier cases.

Default discovery arms isolate baseline, Auto routing, curated context, memory,
and delegation. `BENCH_ARMS=factorial` selects all 16 combinations; the all-enabled
stack is optional as `BENCH_ARMS=baseline,all-enabled`. Live delegation is left to
the coordinator, without a forced extra agent. Reports distinguish requested
features from observed injection, routed dispatch, and durable child attempts.
An unused feature is not credited with a benefit. The mock deliberately exercises
delegation for a functional test; this predicts no model quality or cost gain.

The fixed baseline and other fixed-route arms use Haiku 5.5 through the same Claude
ACP harness. Auto may choose only that profile or DeepSeek V4.1 Flash 1017 using
fresh exact canonical catalog identities. Haiku traffic pins Anthropic's backend.
Native turn limits, output bounds, one attempt, tool permission policy, and
acceptance are shared. Tasks are rotated across arm order. Provider cache state
is not reset. This small discovery run supports per-case observations, not a
statistical/general optimization claim or a neutral model ranking.

## Accounting and checkpoints

One serialized relay admission ledger covers root execution, children, native
retries, and typed routing decisions. Execution cost comes from settled generation
`total_cost`; decision cost comes from typed response `usage.cost`, with separate
provenance. The engine's own unknown CLI cost stays unknown. All failed attempts
remain in aggregate cost per accepted case. A declared `$2` admission target and
unsettled-call allowances are not a hard provider spend guarantee.

Each trial intent is checkpointed before startup, and request IDs are persisted
before upstream paid requests. Decision answers are saved before execution uses
them. Unknown/untracked cost stops new work. Infrastructure failures are separate
from model attempts. Existing result directories cannot be rerun accidentally.
`settle` only reads existing generation IDs and updates accounting; it never
launches a runner, reclassifies a task, or repeats completed/uncertain work.

Before live key access or trial intent, a no-process preflight uses production
`cliEnv` resolution and checks that the Claude native binary and ACP adapter are
executable files. It saves `preflight.json`; it invokes no vendor/auth/model
commands. The isolated host also uses `cliEnv`, covered by an actual-host mock
regression that checks the resolved native path and excluded provider secrets.

The trial ends the isolated runner before final accounting and an external grader
confirmation. Grade-file hashes are checked before/after, but the same UID can
potentially read or alter files outside the workspace. This is not an OS sandbox
or proof that graders are untainted by a hostile agent.

## Commands

From `benchmarks/` (dependencies already shared with existing benchmarks):

```sh
BENCH_RESULTS=/tmp/managed-mock node managed/run.mjs mock
```

The operator, rather than an assistant's unapproved test run, starts paid work:

```sh
BENCH_PAID=1 BENCH_KEYS_FILE=/private/provider/keys.json \
BENCH_BUDGET_USD=2 BENCH_RESULTS=/private/managed-discovery \
node managed/run.mjs live
```

Use `BENCH_TASK_IDS=invoice-rollup` and `BENCH_ARMS=baseline,auto-only` for a smaller
paid discovery subset. `BENCH_RUNNER_SOURCE` selects an uploaded isolated source
tree. `BENCH_TIMEOUT_MS` is 180000 by default, at most 300000. Do not run parallel
paid trials on a small shared home. Preserve `results.json`, `meter.jsonl`, and the
private trial logs for audit; runtime config contains relay credentials and is
not a public report. Never publish the provider-key file.

```sh
BENCH_PAID=1 BENCH_KEYS_FILE=/private/provider/keys.json \
BENCH_RESULTS=/private/managed-discovery node managed/run.mjs settle
```

After every existing attempt is terminal and its billing is known, `continue`
can execute only plan entries that have never started. It verifies the original
arms, fixtures, canonical models, grader, relay, host, runtime and recorded runner
core hashes; prior successes and failures are skipped. Past charges are loaded
into the admission meter and the original total budget remains immutable.
Uncertain/interrupted or infrastructure attempts block continuation.

The resume driver is the sole permitted source change. When it differs, provide
the preserved original `run.mjs`; its bytes must match the original result hash.
Old experiments that did not record execution limits require the operator to
attest their original limits explicitly. New runs store limits directly.

```sh
BENCH_PAID=1 BENCH_KEYS_FILE=/private/provider/keys.json \
BENCH_RESULTS=/private/managed-discovery \
BENCH_RUNNER_SOURCE=/private/unchanged-original-runner \
BENCH_ORIGINAL_RUN_SOURCE=/private/preserved/managed/run.mjs \
BENCH_LEGACY_LIMITS_JSON='{"timeoutMs":180000,"perTrialUsd":0.2,"maxCallsPerTrial":20,"maxOutputTokens":4096}' \
node managed/run.mjs continue
```

Continuation records both driver hashes and its protocol without replacing the
original source manifest. Each continuation writes a separate metadata/preflight
snapshot. Billing settlement restores observed provider/model/token fields and
refreshes eligibility from frozen outcomes; it never reroutes or regrades an old
attempt. A process lock prevents overlapping continuation commands. A leftover
lock requires inspection of the old process before the operator removes it.

The revised remaining-fixture experiment records `BENCH_FIXTURE_OFFSET=1` so its
coalesced-request seed (18) and rotated arm order match the original second-case
plan. It has a separate results directory and revision manifest; it does not
erase or retry the original zero-paid startup failure. Benchmark HTTP GETs may
retry at most three transport attempts; POST/PUT mutations never replay. Host
lifecycle diagnostics and a bounded 45-second startup allowance are private.
Frozen model identity checks require the exact recorded canonical revision when
one is available. `report.mjs` publishes only allowlisted measurements and raw
provenance hashes, excluding prompts, configs, logs and generation IDs.

`functional.mjs` is a separate, explicitly forced two-file root/child lifecycle
check. It pins Haiku and DeepSeek profiles, requires one succeeded durable child,
exact canonical identities and distinct settled provider names, and uses an
external exact-byte grader. It makes no quality, speed or savings comparison.
Its $0.15 admission target uses a $0.03 unsettled-call allowance and at most 20
calls; the shared relay's default $0.20 allowance remains unchanged. A result
directory is never rerun. `functional.mjs settle` only reconciles existing IDs
and refreshes proof from frozen task outcomes. No subscription auth is used.
