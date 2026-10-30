# What is in the agent home

`x86_64`, Ubuntu 24.04.5 LTS, built 2026-10-30. Printed by `agent-home-versions` inside the image. Everything in the [briq sandbox](https://github.com/briq-cloud/sandbox/blob/main/REFERENCE.md) is here too.

## Agent CLIs

The vendors' own binaries, unmodified, with their self-update off: a newer version comes with the next build. Each one is signed in with the person's own account; the variable sets where it keeps the sign-in.

| CLI | Version | Sign-in kept under |
| --- | --- | --- |
| Claude Code (`claude`) | 2.1.308 | `CLAUDE_CONFIG_DIR` |
| Codex (`codex`) | 0.166.0 | `CODEX_HOME` |
| Copilot CLI (`copilot`) | 1.0.105 | `COPILOT_HOME` |
| Cursor (`agent`) | 2026.10.22-27dcf5f | `XDG_CONFIG_HOME`/cursor |
| Grok Build (`grok`) | 1.0.70 | `GROK_HOME` |
| Mistral Vibe (`vibe`) | 3.0.4 | `VIBE_HOME` |
| Gemini CLI (`gemini`), API key only | 0.66.0 | `GEMINI_CLI_HOME`/.gemini |

## Terminal

`ttyd` 1.7.7 serves it. A link a CLI opens (`BROWSER`, `xdg-open`) shows as plain text in a window of its own: `show-url`.

## Runner

`agent-home-runner` 0.4.0 drives the CLIs over ACP for apps ([runner/README.md](runner/README.md)), with `claude-agent-acp` 0.98.0 and `codex-acp` 2.3.0, on `@agentclientprotocol/sdk` 2.1.0.

## Downloads

Each one checked against its publisher's checksum at build, or recorded where none is published.

| Download | sha256 | Checked against |
| --- | --- | --- |
| Claude Code | `356733f185fa988e6bf3aa9a555269fdd167982a2e2a80d3c8a78037bb92ad58` | its release manifest |
| Codex | `1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254` | the GitHub release digest |
| Copilot CLI | `aba1f06f27bc0447656647f76e0a4cf58b4b2a341c75ff04a750982b6aeb6bd2` | the GitHub release digest |
| Cursor | `85296944e4600a83c4b764f578d1502bf9c416db200d33a593e8f3ecabfdc294` | none published: recorded |
| Grok Build | `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9` | none published: recorded |
| Mistral Vibe | `fa201f53a8f7574435c1b911218a4a537e3678831f9cbd7791e5fb32658de956` | the PyPI digest of its wheel |
| Gemini CLI | `269734d35287fbd8ed2982534258ecf4a95f184b6e06e6732e0d6850c28701d9` | the npm registry integrity |
| ttyd | `8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55` | its SHA256SUMS |

## Image

`ghcr.io/briq-cloud/agent-home:2026-10-30.8`, 1435 MB compressed, digest `sha256:94f9a28f3bcf408a8bf8859219c81d2bbe4690f84c676dc76f6f3d3c3de331d8`, on `ghcr.io/briq-cloud/sandbox@sha256:b3de0c6a50bdceea0c95d346c6b3cbc996c74741748bd9d28ec5bd13e8eecdd9`. The Dockerfile: [Dockerfile](Dockerfile). Its provenance: `gh attestation verify oci://ghcr.io/briq-cloud/agent-home:2026-10-30.8 --repo briq-cloud/agent-home`.
