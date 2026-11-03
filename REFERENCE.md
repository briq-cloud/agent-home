# What is in the agent home

`x86_64`, Ubuntu 24.04.5 LTS, built 2026-11-03. Printed by `agent-home-versions` inside the image. Everything in the [briq sandbox](https://github.com/briq-cloud/sandbox/blob/main/REFERENCE.md) is here too.

## Agent CLIs

The vendors' own binaries, unmodified, with their self-update off: a newer version comes with the next build. Each one is signed in with the person's own account; the variable sets where it keeps the sign-in.

| CLI | Version | Sign-in kept under |
| --- | --- | --- |
| Claude Code (`claude`) | 2.1.311 | `CLAUDE_CONFIG_DIR` |
| Codex (`codex`) | 0.166.0 | `CODEX_HOME` |
| Copilot CLI (`copilot`) | 1.0.105 | `COPILOT_HOME` |
| Cursor (`agent`) | 2026.10.22-27dcf5f | `XDG_CONFIG_HOME`/cursor |
| Grok Build (`grok`) | 1.0.70 | `GROK_HOME` |
| Mistral Vibe (`vibe`) | 3.0.4 | `VIBE_HOME` |
| Gemini CLI (`gemini`), API key only | 0.66.0 | `GEMINI_CLI_HOME`/.gemini |

DSH preview 0.2.1-rc.5 is installed at `/opt/dsh/node_modules/.bin/dsh`, disabled until explicitly configured ([dsh/README.md](dsh/README.md)).

## Terminal

`ttyd` 1.7.7 serves it. A link a CLI opens (`BROWSER`, `xdg-open`) shows as plain text in a window of its own: `show-url`.

## Coding workspace

T3 Code 0.1.6 is installed at `/opt/t3/t3`. The authenticated home starts it on demand with a local Briq Agent ACP connection.
Briq CLI 0.1.3 is installed with a complete integrity-checked npm lockfile. Its native sign-in uses `BRIQ_CONFIG_DIR` (default `RUNNER_LOGINS/config/briq`).

## Runner

`agent-home-runner` 0.5.1 drives the CLIs over ACP for apps ([runner/README.md](runner/README.md)), with `claude-agent-acp` 0.98.0 and `codex-acp` 2.3.0, on `@agentclientprotocol/sdk` 2.1.0.

## Downloads

Each one checked against its publisher's checksum at build, or recorded where none is published.

| Download | sha256 | Checked against |
| --- | --- | --- |
| Claude Code | `86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada` | its release manifest |
| Codex | `1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254` | the GitHub release digest |
| Copilot CLI | `aba1f06f27bc0447656647f76e0a4cf58b4b2a341c75ff04a750982b6aeb6bd2` | the GitHub release digest |
| Cursor | `85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294` | none published: recorded |
| Grok Build | `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9` | none published: recorded |
| Mistral Vibe | `fa201f53a8f7574435c1b911218a4a537e3678831f9cbd7791e5fb32658de956` | the PyPI digest of its wheel |
| Gemini CLI | `269734d35287fbd8ed2982534258ecf4a95f184b6e06e6732e0d6850c28701d9` | the npm registry integrity |
| T3 Code | `7cf31da90dee41f524dd5b679ebb6d404637ca5d9dc6fd8bc019511d57bb77e6` | the publisher SHA256SUMS |
| ttyd | `8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55` | its SHA256SUMS |

## Image

`ghcr.io/briq-cloud/agent-home:2026-11-03.2`, 1720 MB compressed, digest `sha256:70f39ca27fcc52ecf7839a50b96679a8056c9e312452f2ed7915a003ea85ea8b`, on `ghcr.io/briq-cloud/sandbox@sha256:4a635c082b235773b4174a1942183c70c94e035c773272140e605d76157afa5f`. The Dockerfile: [Dockerfile](Dockerfile). Its provenance: `gh attestation verify oci://ghcr.io/briq-cloud/agent-home:2026-11-03.2 --repo briq-cloud/agent-home`.
