# briq agent home

The image behind `briq_run({ recipe: "agent-home" })` on [briq](https://briq.cloud): one person's
computer in the cloud, where they sign in to each vendor's agent CLI with the vendor's own flow,
and their agents run on their own plans.

```
ghcr.io/briq-cloud/agent-home:latest
```

The [briq sandbox](https://github.com/briq-cloud/sandbox) (Ubuntu 24.04, Python, Node.js, git, the
usual tools) plus:

| CLI | Command | Sign-in |
| --- | --- | --- |
| Claude Code | `claude` | `claude auth login` |
| Codex | `codex` | `codex login --device-auth` |
| Copilot CLI | `copilot` | `copilot login --device-code` |
| Cursor | `agent` | `NO_OPEN_BROWSER=1 agent login` |
| Grok Build | `grok` | `grok login --device-auth` |
| Mistral Vibe | `vibe` | `vibe --setup` |
| OpenCode | `opencode` | `opencode auth login` (its Zen and Go keys, Copilot, xAI, ChatGPT) |
| Cline | `cline` | `cline auth` (a Cline account by device code, or a provider's key) |
| Gemini CLI | `gemini` | API key only (`GEMINI_API_KEY`), enforced by its system settings |
| Qwen Code | `qwen` | API key only (`QWENCLOUD_API_KEY`…): its free sign-in ended in April 2026 |

and `ttyd` for a terminal page, and `agent-home-runner`: it drives the CLIs over ACP for apps and
keeps their sessions while nobody is connected ([runner/README.md](runner/README.md)). Every version, as the last build left them:
**[REFERENCE.md](REFERENCE.md)**. Inside a home, `agent-home-versions` prints the same.

## How it is built

- **Unmodified binaries**, each from the vendor's own release channel.
- **Pinned per build.** A build takes each CLI's current stable release; a date tag
  (`2026-10-27`) never moves. `latest` follows the newest build, every Monday and on every change
  here, for `linux/amd64`.
- **Self-update off.** `DISABLE_AUTOUPDATER` and `DISABLE_UPDATES` (Claude Code),
  `/etc/codex/config.toml`, `COPILOT_AUTO_UPDATE=false`, `GROK_DISABLE_AUTOUPDATER` and
  `/etc/grok/managed_config.toml`, `OPENCODE_DISABLE_AUTOUPDATE` and `/etc/opencode/opencode.json`,
  `/etc/gemini-cli/settings.json`, `/etc/qwen-code/settings.json`, `CLINE_NO_AUTO_UPDATE`. Cursor
  and Vibe read theirs from the user's own config, and Cline its telemetry setting, which the briq
  recipe writes at boot. Gemini's and Qwen's usage statistics are off in their system settings.
- **Checked downloads.** Each one against its publisher's checksum (Claude Code's manifest, the
  GitHub release digests, ttyd's `SHA256SUMS`, PyPI's); Cursor and Grok publish none, so their
  hashes are recorded. Every sha256 and the base image's digest are in REFERENCE.md.
- **Provenance.** Each pushed image is attested by this repo's build:
  `gh attestation verify oci://ghcr.io/briq-cloud/agent-home:<tag> --repo briq-cloud/agent-home`.
- **No browser.** A CLI that opens a link (a sign-in page) calls `xdg-open` or `$BROWSER`; here both
  are `show-url`, which shows the link as plain text in a terminal window of its own.

Sign-ins live where each CLI's variable says (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`,
`GROK_HOME`, `VIBE_HOME`, `XDG_CONFIG_HOME`). On briq they are on the home's volume, which is never
forked or backed up.

## Run it elsewhere

```bash
docker run --rm -it ghcr.io/briq-cloud/agent-home:latest bash
```

## Build it

```bash
docker build -t agent-home .
docker run --rm agent-home agent-home-versions
```

## Links

- [The recipe](https://briq.cloud/cookbook/agent-home): sign-in, sessions, limits.
- [The sandbox reference](https://briq.cloud/docs/sandbox): what the base image has.

MIT licensed. The briq service is operated by Uplab SAS under its
[terms](https://briq.cloud/legal/terms).
