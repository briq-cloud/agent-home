# Small ACP benchmarks

```sh
cd benchmarks
npm ci
npm test
npm run mock
```

Requires Node 22.22+ (Node 24 recommended). Dependencies stay outside the home image.
The free mock run exercises all twelve Promptfoo cases through ACP. It measures plumbing, not model quality.

## Paid staging runs

Run on the home, where its provider key already lives. Do not export the key to a client.

```sh
BENCH_PAID=1 BENCH_KEYS_FILE=/work/.logins/keys.json npm run decisions
BENCH_PAID=1 BENCH_KEYS_FILE=/work/.logins/keys.json npm run live
```

`BENCH_RUNNER_SOURCE` can name an existing runner source folder (with its installed adapters).
`BENCH_RESULTS` chooses a new output folder. `BENCH_MODEL` selects a fixed OpenRouter model ID.
The default is `anthropic/claude-haiku-5.5`; the catalog's canonical identity and prices are recorded at startup.
Anthropic models pin the Anthropic first-party backend.
No `auto`, `latest` or moving `~` alias is accepted. Reports include the model actually billed.

- Decisions: 24 human policy labels, split 12/12 into development and held-out cases. Clef Flash and
  Jev 1.14 make at most 48 requests. Target: $0.05; no retries. This is policy agreement, not task quality.
- Execution: six tasks, two arms, one attempt each, sequentially. Alternate AB/BA order. Fresh fixture
  and ACP session per run. Target: $2 total, $0.15 per trial; 90 seconds and twelve generation requests
  per trial. No automatic execution retry. A model/tool failure remains a failed observation.
- Learned semantic choices use typed decision models. Objective acceptance, permission and budget
  checks use code. No general chat model grades the results.

## What the first comparison means

The context arm supplies curated source excerpts selected by fixture metadata. It is an upper bound
on retrieval quality, not a production retrieval algorithm. It never includes grading code or gold
answers. The freshness case rejects a stale revision deterministically.

Source lookup uses exact JSON assertions and verifies that source files remain unchanged. Coding
checks exercise edge cases outside the workspace in a separate process, with a five-second deadline.
Workspaces are isolated folders, not security sandboxes. Use the trusted synthetic fixtures only.
Live permission requests select `allow_once` for the fixture task. The CLI is instructed to stay in
its workspace; that instruction is not an OS-enforced boundary.

## Billing and time

The live run starts its own localhost runner and isolated Claude API-key profile. It does not read
vendor subscription tokens, start Codex, change the user's profiles, or alter the public home page.
A localhost relay holds the OpenRouter key and only forwards `/v1/messages` to OpenRouter. The CLI
receives a random relay credential. Each response's generation ID is reconciled through OpenRouter's
`/generation` metadata API; cost is `total_cost`, not Claude's Anthropic-price estimate.

The relay pins the model and caps output at 2048 tokens. Forwarded requests are sequential. Billing reconciles in the background, with a $0.20 admission
reservation per unsettled request. Billing is joined after all task executions. Pending costs remain null in provisional records.
Final `results.json` joins the provider ledger; exhausted reservations wait for settlement.
Errored model attempts carry explicit zero-cost provenance from OpenRouter’s published error policy.
Other unknown billing stops further paid requests. A
threshold cannot guarantee a hard dollar cap: one accepted request can cross it. Cancellation
cannot undo charges. Paid CI calls are never enabled.

The raw report preserves ACP token counters without assuming cumulative semantics. Task time
includes fixture setup, agent execution and external grading. Post-turn billing wait is reported
separately as `accountingWaitMs`, outside task time. Admission may wait near the budget limit.
Fresh sessions do not guarantee cold provider caches. Cache counters, order and provider are recorded.
Costs of failures remain in totals. Unknown cost stays `null`. Home compute is billed separately by
briq and is not guessed into the API-dollar total.

## Results and later work

Each output folder has `report.html`, `results.json`, immutable per-case records and fresh fixture
folders. Results are local; telemetry, uploads and response caching are disabled. Secrets and relay
credentials are not included in reports. Keep output folders private.

No new acceptance failures plus 20% lower time or cost is only a discovery signal. Confirm on a
separate held-out task suite, with three repetitions, before claiming a general improvement.

For routing, add a second execution route on four tasks and reuse the first-route observations.
Replay Jev/Clef recommendations against that outcome matrix without rerunning execution agents.
Do not train a router on these six tasks. RouteLLM and LLMRouter are comparison tools, not a proxy
for vendor subscription traffic.

## Larger tasks and execution-model comparison

```sh
BENCH_SUITE=medium npm run mock
BENCH_PAID=1 BENCH_KEYS_FILE=/work/.logins/keys.json npm run compare
```

The medium suite covers configuration precedence/client integration, a cancellable bounded async
queue, and tenant-cache TTL/single-flight/invalidation races. Reference implementations stay outside
agent workspaces and are used only by the free mock. Separate acceptance checks reject the broken
projects before any paid run.

`compare` runs three tasks on Haiku 5.5, DeepSeek V4.1 Flash (1017) and GLM 5.3. It holds baseline
context fixed and rotates model order per task. Every run has a fresh workspace/profile, 180 seconds,
24 generation requests and 8192 output tokens per request. The $2 target is shared across all nine
executions and six decision calls, using finalized spend from earlier runs before admitting the next.
Unknown billing stops the matrix. Task failures are retained, not retried.

Clef/Jev choices are recorded in `routing-frozen.json` before execution. They see only task and
catalog metadata, not task outcomes. The final report replays those choices against measured results.
This is an observed single-attempt comparison, not a trained router or an intrinsic model ranking.
All profiles use Claude ACP; compatibility errors may matter. Tool search and prompt suggestions are
explicitly disabled for every profile. Actual model, backend, cache usage and admission waits remain
in the raw records. Anthropic is pinned for Haiku; OpenRouter chooses the open-weight backends.

Use `BENCH_TASK_IDS` to select task IDs and `BENCH_ARMS=baseline` for a fixed-context comparison.
`BENCH_SUITE` defaults to `smoke`, preserving the original twelve-case before/after benchmark.

The [dynamic routing experiment](routing/README.md) combines a daily model catalog, external
intelligence priors, measured task outcomes and current home availability into task-specific
portfolios. Clef can choose among those routes. This remains an explicit experiment; it does not
change the home's dispatcher or native subagent configuration.
