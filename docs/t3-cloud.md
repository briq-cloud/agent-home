# T3 Cloud

`ghcr.io/briq-cloud/t3-cloud` is a separate image built with `docker build --target t3-cloud .`.
It packages source-patched T3 Code with pinned native provider CLIs and the official Briq CLI.
The source revision, patch tree and tool versions are recorded in `t3-cloud/t3-source/source.json`.
It contains no Agent Home runner, Briq Agent routing, Fleet, Auto or DSH.
`docker build .` continues to build Agent Home; the workflow checks both images before
publishing their separate tags.

## Startup and sign-in

`t3-cloud-start` initializes private directories and starts the central manager by default.
The public listener serves native T3 at `/` and owner connection management at `/_cloud/`.
Native T3 retains its authenticated pairing flow. Use HTTPS for remote access and expose only
the public listener; native T3 and the terminal bind loopback ports 3773 and 7681.

Central startup requires an exact HTTPS `T3_CLOUD_PUBLIC_ORIGIN`, a private random
`T3_CLOUD_OWNER_KEY` of at least 32 bytes, a distinct private `T3_CLOUD_EDGE_TOKEN` of at least
32 cookie-compatible ASCII characters, a stable `T3_CLOUD_OWNER_ID`, an absolute
`T3_CLOUD_STATE` directory and a digest-pinned `T3_CLOUD_CHILD_IMAGE`. Keep both keys out of
URLs and browser storage. The owner enters only the owner key at `/_cloud/`; the edge token
protects the private sandbox transport. See [connection and runtime details](../t3-cloud/README.md).

Complete managed native Codex, Claude and Briq sign-in through `/_cloud/`. The official CLIs
own their credentials. Codex account operations use the central app server; Claude sign-in
and queries share their central credential owner. The manager does not replace native T3
browser authentication.

| Variable | Default |
| --- | --- |
| `T3_CLOUD_ROLE` | `central` |
| `PORT` | `8080` |
| `T3_HOST` | `0.0.0.0` |
| `T3_CWD` | `/work` |
| `T3_STATE` | `/work/.t3` |
| `T3_HOME` | `/work/.t3/home` |
| `T3_LOGINS` | `/work/.logins` |

Persist the configured state and native login directories. Briq CLI uses `BRIQ_CONFIG_DIR`,
defaulting to `/work/.logins/config/briq`. `T3_CLOUD_ROLE=standalone` is an explicit diagnostic
mode without the central broker or thread allocation.

## Thread resources and qualification

The source integration allocates a Briq sandbox per thread and binds provider workspace
operations to it. Allocation failure does not permit central local execution. Unknown outcomes
remain journalled for reconciliation rather than being replayed.

Managed Briq sign-in enables the central CLI-backed scoped MCP path; it does not require a
separately copied `BRIQ_MCP_TOKEN`. Claude receives an in-process server with packaged Briq
guidance, and Codex receives a separate loopback capability on thread start and resume.
`briq_run` creates recorded descendants from the supported sandbox, postgres and redis recipes;
resource tools exclude the workspace root, central resources and other threads. Unrelated
direct native MCP connections retain their own authorization.

Claude enablement remains closed. Source checks, patch replay and the credential-free offline
image fixture do not establish cloud or subscription qualification. Image CI, composed native
execution and the required acceptance and recovery evidence remain release gates; this
candidate does not establish deployment or production readiness.
