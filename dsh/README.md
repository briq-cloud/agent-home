# Optional DSH ACP harness

The image installs the preview `@deepseek-ai/dsh@0.2.1-rc.5` with a complete npm lockfile and registry integrity checks. Installation disables lifecycle scripts and checks `dsh --version` inside the Linux image. DSH uses its native `--profile acp`; no additional scheduler or superagent plugin is installed.

DSH is disabled by default. To configure a home, set:

- `RUNNER_DSH=1`
- `DSH_HOME` to an absolute persistent directory dedicated to this harness
- `RUNNER_DSH_PATCH` to an existing absolute provider patch file
- `AGENT_HOME_DSH_PROVIDER_KEY` through the home's credential gateway; the patch's `apiKeyEnv` must name this variable

Configure the provider, exact model and limits in the DSH patch using DSH's documented configuration. Keep keys out of the patch. The runner gives DSH its own `HOME=DSH_HOME`, strips other vendors' keys and subscription-folder variables, passes only the named provider credential plus baseline process and credential-gateway variables, and disables DSH telemetry. Configuration does not establish model compatibility, account permissions or credit. Its provider is billed by use.

Choose `dsh` explicitly in BriqAgent with paid API use allowed. It is excluded from automatic route selection and the approved Auto model pool. A per-request budget requires known pricing and fails closed when pricing is unavailable. Existing subscription sign-ins are not copied into DSH. Operators must retain provider egress and credential gateway policy for this additional harness.

Native DSH advertises `session/resume`, not `session/load`. The runner's load operation replays its own transcript and then uses advertised native resume for DSH. If the capability is missing it fails without issuing resume. This adapts the runner lifecycle; it does not claim DSH implements transcript replay. Mock coverage checks the configured launch, credential allowlist, restart recovery and explicit route gates. Real models, provider billing, permission tools and the Linux image remain separate qualification gates.
