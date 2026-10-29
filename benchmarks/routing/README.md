# Dynamic routing experiment

`node routing/refresh.mjs results/routing/catalog.json` fetches OpenRouter's public catalog at most
once per 24 hours. The daily `model catalog` workflow archives a snapshot; it runs no inference.
Failed refreshes retain the last good file. Stale snapshots disable new recommendations.

`node routing/plan.mjs results/routing` reads `inventory.json`, optional `evidence.json`, and optional
`comparison.json` from that folder. It writes five task portfolios (lookup/change/debug/plan/review),
with at most five routes each. Fewer eligible routes means a shorter list.

Inventory contains no secrets:

```json
{
  "checkedAt": "2026-10-30T00:00:00Z",
  "clis": [{ "name": "openrouter-claude", "signedIn": true }],
  "keyProviders": ["openrouter"],
  "routes": [{
    "id": "deepseek-flash", "cli": "openrouter-claude", "harness": "claude",
    "provider": "openrouter", "billing": "use", "model": "exact/catalog-id",
    "canonical": "exact/catalog-version", "compatibility": "verified"
  }]
}
```

Use the home's `/status` and `/keys` metadata, plus explicit tested route bindings. A saved key alone
does not prove credit, permission or model compatibility. Inventory expires after 60 seconds; refresh
it before each plan and revalidate again at dispatch. Sign-in `null` is not availability. Native
subscription routes require an enumerated model binding, not every model sold by that vendor.
The prototype does not discover native subscription model lists or dispatch sessions yet.

Catalog fields cover prices, context, modalities, tools and retirement. Intelligence is separate:
with `BENCH_PAID=1` and `BENCH_KEYS_FILE`, the planner fetches OpenRouter's authenticated benchmark
metadata once per day using the existing key. It joins Artificial Analysis scores by exact canonical
model version, preserving source date, citation, missing fields and configuration label. This metadata
request performs no inference. The feed does not expose its intelligence-index version or speed;
the index version stays unknown. No new account is needed for this path.

The authenticated per-model endpoints API supplies speed: latency percentiles in milliseconds
(time to first token), throughput percentiles in tokens/second, uptime, quantization and per-provider
prices. Refresh only the candidate models, at most 20, every five minutes. Unauthenticated calls
return null speed fields. A binding's optional `endpointTag` selects that endpoint's metrics. Without
a pin, show the unweighted median of active provider medians, explicitly labelled; it is neither a
traffic-weighted average nor the performance of OpenRouter's eventual selected provider. Retain all
endpoint distributions in `performance.json`. Do not combine one provider's cheap price with another's
fastest speed as a fictional route. Catalog request-price estimates remain separate from speed priors.

For richer speed and index-version metadata,
set `ARTIFICIAL_ANALYSIS_API_KEY` and provide `aliases.json` mapping an exact AA slug to
`{model, canonical, configuration}`. The importer supports the free API, pagination, index versions,
intelligence/coding/agentic scores and median speed/first-token time. Do not fuzzy-join names or silently
transfer scores to new model versions. External scores are priors; retain the tested effort/harness.
Without either feed or a sourced evidence file, intelligence stays unknown.

Local comparison results supply task acceptance, cost per accepted task (including failures), and
task time. Three trials are sparse evidence; ten is the initial configurable confidence threshold,
not proof of generality. Coding tests do not establish review, planning or lookup quality. Provider
cache state, harness, model version and backend affect results.

Portfolios preserve alternatives: task-quality leader, intelligence leader, included subscription,
cheapest estimated request and fastest measured/prior route. This is not one universal weighted
ranking. Subscription marginal dollar cost is unknown, not zero. API request price is a rough
10k-input/2k-output estimate; it excludes tool loops, retries, cache discounts and thinking overhead.
Local cost per accepted task is stronger evidence once enough trials exist.

To test a semantic choice, set `BENCH_PAID=1`, `BENCH_KEYS_FILE` and `ROUTE_TASK`. One Clef Flash
decision selects task type and an eligible route; choices outside that portfolio become abstentions.
No key or general chat model is used for catalog filtering. Unknown decision cost stops paid routing.
Explicit route selection and existing sessions should bypass classification and remain pinned.

For an actual routed fixture execution, use `ROUTE_TASK_ID=config-precedence` when planning, then
`BENCH_PAID=1 BENCH_KEYS_FILE=... RUNNER_TOKEN_FILE=... node routing/execute.mjs results/routing config-precedence`.
The executor rechecks the loopback runner's sign-ins/keys, rejects changed or unavailable routes,
and starts a fresh isolated Claude ACP session with `BENCH_MODEL` set to the selected model. It
uses the existing relay, $0.25 per-trial spend target, 180-second task deadline and external acceptance
checks. The shared accounting allowance is $0.75 so $0.20 reservations for unsettled requests do not
serialize every turn behind billing indexing. Both limits are admission targets, not guaranteed caps.
Only the three trusted medium fixtures are supported. No fallback execution or automatic retry.
Keep these integration runs separate from the frozen comparison matrix.

## Subagents

Claude definitions support `model` (alias, full ID or inherit); Agent calls accept aliases. Mapping
aliases at profile startup can use different models behind one compatible gateway. The current
runner deliberately pins all aliases to one profile model for predictable billing. It does not yet
support per-role profile maps. Do not modify a running session's provider credentials.

A Claude subscription parent and a DeepSeek/OpenRouter child should be separate runner ACP sessions,
with isolated settings and credentials. Expose delegation through a runner tool/MCP surface later:
task ID, parent ID, selected route, workspace/revision, input artifact references, budget/deadline,
status/cancel, output artifacts and measured cost. The runner owns classification and dispatch;
the parent only requests a task. Return bounded results, not the entire parent transcript.
Keep writes serialized or in separate worktrees; enforce a fleet-wide budget/concurrency limit.
No OS sandboxing or fleet dispatcher is implemented in this experiment.

Codex supports custom-agent model selection; its current custom-agent files cannot override the
parent's `model_provider`. Cross-provider children therefore also need a separate runner profile.
ACP is the child transport, not a standard native-subagent interception hook. We cannot infer and
replace every vendor's hidden delegation from ACP logs. Start with explicit runner delegation;
native hooks require a separate adapter and tests.

Claude now also documents a mods `agent.spawn` hook that can replace the subagent model. That is a
possible native interception point to investigate against our pinned CLI/adapter, rather than
patching the vendor binary. It does not itself supply a different provider credential per child.

OpenRouter's existing Pareto Code Router already selects coding models by a minimum coding percentile
and cost (or throughput with Nitro). Use it as a comparison baseline for API-key traffic; do not
reimplement its provider load balancer. It cannot enumerate the person's subscription CLI routes.
Keep model selection at session/task boundaries so tool conversations and caches remain coherent.

Sources checked 2026-10-30:

- [Claude subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude model configuration](https://code.claude.com/docs/en/model-config)
- [OpenRouter Claude integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)
  guarantees compatibility only with Anthropic 1P; open-model harness support remains experimental.
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenRouter catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
- [OpenRouter benchmarks](https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks)
- [OpenRouter endpoint performance](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model)
- [OpenRouter Pareto Router](https://openrouter.ai/docs/guides/routing/routers/pareto-router)
- [Claude mods hooks](https://code.claude.com/docs/en/plugins/mods/reference)
- [Artificial Analysis API](https://artificialanalysis.ai/data-api/docs/reference)
- [Intelligence index methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking)
