# What is in the agent home

`x86_64`, Ubuntu 24.04.5 LTS, built 2026-10-27. Printed by `agent-home-versions` inside the image. Everything in the [briq sandbox](https://github.com/briq-cloud/sandbox/blob/main/REFERENCE.md) is here too.

## Agent CLIs

The vendors' own binaries, unmodified, with their self-update off: a newer version comes with the next build. Each one is signed in with the person's own account; the variable sets where it keeps the sign-in.

| CLI | Version | Sign-in kept under |
| --- | --- | --- |
| Claude Code (`claude`) | 2.1.308 | `CLAUDE_CONFIG_DIR` |
| Codex (`codex`) | 0.164.0 | `CODEX_HOME` |
| Copilot CLI (`copilot`) | 1.0.104 | `COPILOT_HOME` |
| Cursor (`agent`) | 2026.10.22-27dcf5f | `XDG_CONFIG_HOME`/cursor |
| Grok Build (`grok`) | 1.0.70 | `GROK_HOME` |
| Mistral Vibe (`vibe`) | 3.0.3 | `VIBE_HOME` |

## Terminal

`ttyd` 1.7.7 serves it. A link a CLI opens (`BROWSER`, `xdg-open`) shows as plain text in a window of its own: `show-url`.

## Image

`ghcr.io/briq-cloud/agent-home:2026-10-27`, 1335 MB compressed, on `ghcr.io/briq-cloud/sandbox:latest`. The Dockerfile: [Dockerfile](Dockerfile).
