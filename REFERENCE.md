# What is in the agent home

`x86_64`, Ubuntu 24.04.5 LTS, built 2026-10-28. Printed by `agent-home-versions` inside the image. Everything in the [briq sandbox](https://github.com/briq-cloud/sandbox/blob/main/REFERENCE.md) is here too.

## Agent CLIs

The vendors' own binaries, unmodified, with their self-update off: a newer version comes with the next build. Each one is signed in with the person's own account; the variable sets where it keeps the sign-in.

| CLI | Version | Sign-in kept under |
| --- | --- | --- |
| Claude Code (`claude`) | 2.1.308 | `CLAUDE_CONFIG_DIR` |
| Codex (`codex`) | 0.165.0 | `CODEX_HOME` |
| Copilot CLI (`copilot`) | 1.0.105 | `COPILOT_HOME` |
| Cursor (`agent`) | 2026.10.22-27dcf5f | `XDG_CONFIG_HOME`/cursor |
| Grok Build (`grok`) | 1.0.70 | `GROK_HOME` |
| Mistral Vibe (`vibe`) | 3.0.3 | `VIBE_HOME` |

## Terminal

`ttyd` 1.7.7 serves it. A link a CLI opens (`BROWSER`, `xdg-open`) shows as plain text in a window of its own: `show-url`.

## Runner

`agent-home-runner` 0.1.0 drives the CLIs over ACP for apps ([runner/README.md](runner/README.md)), with `claude-agent-acp` 0.98.0 and `codex-acp` 2.3.0, on `@agentclientprotocol/sdk` 2.1.0.

## Downloads

Each one checked against its publisher's checksum at build, or recorded where none is published.

| Download | sha256 | Checked against |
| --- | --- | --- |
| Claude Code | `356733f185fa988e6bf3aa9a555269fdd167982a2e2a80d3c8a78037bb92ad58` | its release manifest |
| Codex | `e97c4463d7f146692a955d7b0e1c8cf48f97cd4d616cd45c5dcab2e8d9743316` | the GitHub release digest |
| Copilot CLI | `aba1f06f27bc0447656647f76e0a4cf58b4b2a341c75ff04a750982b6aeb6bd2` | the GitHub release digest |
| Cursor | `85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294` | none published: recorded |
| Grok Build | `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9` | none published: recorded |
| Mistral Vibe | `28a2b1f6ae8580853492f2d1aca883901fc4dc062ce484a6057acc0a0bf38521` | the PyPI digest of its wheel |
| ttyd | `8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55` | its SHA256SUMS |

## Image

`ghcr.io/briq-cloud/agent-home:2026-10-28.7`, 1346 MB compressed, digest `sha256:7c5d703f6de8c64b56b45e44e60b9a6cd57214617b203b57db1a9d8ce2a0f5c7`, on `ghcr.io/briq-cloud/sandbox@sha256:b3de0c6a50bdceea0c95d346c6b3cbc996c74741748bd9d28ec5bd13e8eecdd9`. The Dockerfile: [Dockerfile](Dockerfile). Its provenance: `gh attestation verify oci://ghcr.io/briq-cloud/agent-home:2026-10-28.7 --repo briq-cloud/agent-home`.
