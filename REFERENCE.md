# What is in the agent home

`x86_64`, Ubuntu 24.04.5 LTS, built 2026-11-06. Printed by `agent-home-versions` inside the image. Everything in the [briq sandbox](https://github.com/briq-cloud/sandbox/blob/main/REFERENCE.md) is here too.

## Agent CLIs

The vendors' own binaries, unmodified, with their self-update off: a newer version comes with the next build. Each one is signed in with the person's own account; the variable sets where it keeps the sign-in.

| CLI | Version | Sign-in kept under |
| --- | --- | --- |
| Claude Code (`claude`) | 2.1.311 | `CLAUDE_CONFIG_DIR` |
| Codex (`codex`) | 0.166.0 | `CODEX_HOME` |
| Copilot CLI (`copilot`) | 1.0.106 | `COPILOT_HOME` |
| Cursor (`agent`) | 2026.11.05-86047df | `XDG_CONFIG_HOME`/cursor |
| Grok Build (`grok`) | 1.0.77 | `GROK_HOME` |
| Mistral Vibe (`vibe`) | 3.1.0 | `VIBE_HOME` |
| Gemini CLI (`gemini`), API key only | 0.67.0 | `GEMINI_CLI_HOME`/.gemini |

DSH preview 0.2.1-rc.5 is installed at `/opt/dsh/node_modules/.bin/dsh`, disabled until explicitly configured ([dsh/README.md](dsh/README.md)).

## Terminal

`ttyd` 1.7.7 serves it. A link a CLI opens (`BROWSER`, `xdg-open`) shows as plain text in a window of its own: `show-url`.

## Coding workspace

T3 Code is available separately in the t3-cloud image.
Briq CLI 0.1.3 is installed with a complete integrity-checked npm lockfile. Its native sign-in uses `BRIQ_CONFIG_DIR` (default `RUNNER_LOGINS/config/briq`).

## Runner

`agent-home-runner` 0.5.1 drives the CLIs over ACP for apps ([runner/README.md](runner/README.md)), with `claude-agent-acp` 0.98.0 and `codex-acp` 2.3.0, on `@agentclientprotocol/sdk` 2.1.0.

## Downloads

Each one checked against its publisher's checksum at build, or recorded where none is published.

| Download | sha256 | Checked against |
| --- | --- | --- |
| Claude Code | `86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada` | its release manifest |
| Codex | `1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254` | the GitHub release digest |
| Copilot CLI | `bb2ac6a50c2d7ceffee3b489f278fb9ba4fd39d4678dd75b5b021d4feedcc3ef` | the GitHub release digest |
| Cursor | `170b77786cbf4c93064d64fff12b71a178b968730561c64afc2e8e752535442e` | none published: recorded |
| Grok Build | `b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a` | none published: recorded |
| Mistral Vibe | `214f2e6a392e0d057087fe0c706c9617bc0bcacea593a19b166b79a7ac05233c` | the PyPI digest of its wheel |
| Gemini CLI | `3f42374e88171031459ad16e5fac32b161adba330292a1822fb7aae7fb476fc2` | the npm registry integrity |
| ttyd | `8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55` | its SHA256SUMS |

## Image

`ghcr.io/briq-cloud/agent-home:2026-11-06.2`, 1609 MB compressed, digest `sha256:080363498c98a40ece958686044d4ce565aec28d0536a5a4210a8d97e2d3a089`, on `ghcr.io/briq-cloud/sandbox@sha256:1791ed759c6ecdc18546b76541194b60a4c25b2bf8e205de28476c0bf54c3e6d`. The Dockerfile: [Dockerfile](Dockerfile). Its provenance: `gh attestation verify oci://ghcr.io/briq-cloud/agent-home:2026-11-06.2 --repo briq-cloud/agent-home`.
