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
The default is `qwen/qwen3-coder`; the catalog's canonical identity and prices are recorded at startup.
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

The relay pins the model and caps output at 2048 tokens. Requests are sequential and billing is
reconciled before another request is admitted. Unknown billing stops further paid requests. A
threshold cannot guarantee a hard dollar cap: one accepted request can cross it. Cancellation
cannot undo charges. Paid CI calls are never enabled.

The raw report preserves ACP token counters without assuming cumulative semantics. Total time
includes fixture setup, agent execution, billing lookup and external grading. Billing lookup is
benchmark instrumentation; inspect agent and provider timings before making latency claims.
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
