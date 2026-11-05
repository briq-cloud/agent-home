# T3 Cloud

`ghcr.io/briq-cloud/t3-cloud` is a separate image built with `docker build --target t3-cloud .`.
It runs unmodified T3 Code 0.1.6, verified against the publisher's release checksum, with the
same pinned native provider CLIs and Briq CLI as Agent Home. It contains no Agent Home runner,
Briq Agent routing, Fleet, Auto, or DSH. Native T3 Settings → Providers owns provider connections
and sign-in; no second application starts or refreshes those accounts.

`docker build .` continues to build Agent Home. Agent Home contains the orchestration runner
and does not install T3 Code. The workflow checks both images before publishing separate tags.

## Startup

The command is `t3-cloud-start`. It initializes private directories, installs the Briq skill
for native Codex and Claude, seeds absent Briq MCP definitions with the providers' native
configuration commands, and executes `t3 serve`. Existing Briq definitions and skills are
preserved; unknown configuration failures stop startup. The native readiness endpoint is
`/.well-known/t3/environment`.

| Variable | Default |
| --- | --- |
| `PORT` | `8080` |
| `T3_HOST` | `0.0.0.0` |
| `T3_CWD` | `/work` |
| `T3_STATE` | `/work/.t3` |
| `T3_HOME` | `/work/.t3/home` |
| `T3_LOGINS` | `/work/.logins` |
| `BRIQ_MCP_URL` | `https://api.briq.cloud/mcp` (or `/mcp` at `BRIQ_API_URL`) |

Persist `/work` for T3 state, workspaces, and native provider logins. Provider variables
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and the other native CLI directories may override their
subdirectories under `T3_LOGINS`. Briq CLI uses `BRIQ_CONFIG_DIR`, defaulting to
`/work/.logins/config/briq`. Connect browsers through T3's native authenticated pairing flow;
serve behind HTTPS when accessed remotely. The image does not disable native T3 authentication.

Briq MCP config references `BRIQ_MCP_TOKEN` at runtime; it never embeds the token. Without an
owner-authorized MCP credential, the endpoint is configured but disconnected. `briq login`
authenticates the native CLI separately. Native provider sign-in is likewise completed by the
owner through T3 or the provider's terminal command.

The installed skill describes authorized Briq operations. It does not change the location of
native provider tools: unmodified T3 runs them in its server environment. A new T3 thread does
not by itself provision another sandbox.
