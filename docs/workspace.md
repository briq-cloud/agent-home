# Coding workspaces

Agent Home provides the Briq Agent orchestration runner and its native CLI connections.
[T3 Cloud](https://github.com/briq-cloud/t3-cloud) is maintained in its own repository.

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

## Auto Agent settings

The **Auto Agent** tab owns the existing routing configuration UI. Connections
contains provider key save/removal and CLI sign-ins; saving a key sends
`auto: false` and does not prepare models. The Auto Agent OpenRouter **Use Auto**
button still calls `POST /routing/models` to prepare the existing default models
with automatic harness selection. No routing policy or new stored fields are added.

Current settings and scope:

- Claude account `enabled`: `PATCH /accounts/:id` changes eligibility for new
  automatic work. Explicit account selection and active sessions stay available.
- Model profiles: `provider`, `harness`, `model`, optional `name`, and OpenRouter
  `autoEligible` use the existing `POST /profiles`; profiles can also be removed.
  Preparing defaults uses the existing catalog checks, not a new routing model.
- Chat `allowPaidApi` and Fleet paid-use consent remain per conversation/task.
  Shared MCP connections and skills remain in Tools.

Tab selection is remembered under `agent-home-tab`; `#auto-agent` opens the
settings directly. No credentials are rendered or entered on this tab.

## Local turn observations

`GET /routing/observations` uses the runner's existing authentication and returns
local metadata: configured CLI, harness, provider/model, public-endpoint fingerprint, existing decision task
category, queue time, elapsed time, first visible text latency, outcome, and
reported token/cost fields when available. No external analytics or extra model
calls are added. Prompts, responses, native error text, keys and account labels
are excluded from this metadata index. Existing conversation logs retain their
existing behavior.

The metadata index sits beside session logs under `RUNNER_STATE/observations`.
It retains two files of at most 512 KiB, at most 2,000 events and seven days in
memory; recovery reads only those bounded files, never scans prompt logs. An unavailable optional index falls back to bounded in-memory observations and a coarse persistence-error count; it cannot stop inference. Reports
include at most 100 recent turns. An unmatched start after recovery is interrupted,
not successful. The report separately shows active turns, existing quota warnings
and cooldowns; cancellation/error paths release active counts.

Token counts are finite, explicit reported session-counter differences. Context
window `used`/`size`, missing counters and invalid/reset baselines are not billable
tokens. Output tokens/second requires an explicit output delta and a positive
first-to-last visible text window; a single chunk or overlapping session turns
has no usable generation window. This is observed text throughput, not a provider
benchmark. CLI-reported costs are marked notional and never treated as invoices,
marginal subscription costs or measured savings. Adapter-priced provider profiles
retain unknown cost. Missing observations stay null.

Deterministic acceptance checks attach `PASS`, `FAIL` or `UNKNOWN` separately.
Completing a turn establishes no quality score; absent checks stay unknown.
No paid judge or new model is used.

`RUNNER_EMPIRICAL_ROUTING=1` opts into tie-breaking for new automatic selections;
it defaults to `0`. Existing sign-in, enabled-account, quota, budget,
subscription-first and operator-priority rules still apply. Equally ranked
accounts in the same configured harness/provider/model family prefer a lower
observed load or a non-full quota window. Once the existing routing decision
reports a task category, measured first-text p50 can break the remaining tie only
when both exact known endpoint/model/provider/harness/category routes have at least ten
successful timing samples within retention. Changed or unknown endpoint identities do not reuse historical timing. Unknown model/category, insufficient
samples, explicit selections and running tasks receive no empirical latency
rerank. No error triggers an automatic retry or approval/authentication bypass.

Run `node runner/benchmarks/observations.ts` for the offline synthetic comparison.
It reports ordering and hard-gate assertions with zero inference calls, not
production performance, quality improvement or cost savings.
