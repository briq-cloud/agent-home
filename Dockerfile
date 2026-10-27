# The briq agent home: what `briq_run({ recipe: "agent-home" })` runs on briq.cloud. One person's
# computer, where they sign in to each vendor's agent CLI with the vendor's own flow and their
# agents run on their own plans.
#
# The briq sandbox image (github.com/briq-cloud/sandbox: Ubuntu, Python, Node, git, the tools), plus
# the vendors' agent CLIs and a terminal page. Each CLI is the vendor's binary as published, at the
# version this build resolved (a date tag never moves), with its self-update off: a newer CLI comes
# with next week's build, never from inside a running home. Pass a version as a build arg to pin it;
# empty means the vendor's current stable release. What is inside, with versions: REFERENCE.md.
ARG BASE=ghcr.io/briq-cloud/sandbox:latest
FROM ${BASE}

ARG CLAUDE_VERSION=
ARG CODEX_VERSION=
ARG COPILOT_VERSION=
ARG CURSOR_VERSION=
ARG GROK_VERSION=
ARG VIBE_VERSION=
ARG TTYD_VERSION=

# Updates off, for every process: the variables each CLI reads, and the system-wide config files
# they read before the person's own (which live on the briq's volume, empty at build).
# BROWSER, and xdg-open below: there is no browser here, so a CLI that opens a link shows it instead.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    COPILOT_AUTO_UPDATE=false \
    GROK_DISABLE_AUTOUPDATER=1 \
    BROWSER=/usr/local/bin/show-url

# Claude Code: the native binary and its checksum, from the bucket its installer reads.
RUN B=https://downloads.claude.ai/claude-code-releases \
  && V="${CLAUDE_VERSION:-$(curl -fsSL "$B/stable")}" \
  && curl -fsSL "$B/$V/linux-x64/claude" -o /usr/local/bin/claude \
  && echo "$(curl -fsSL "$B/$V/manifest.json" | jq -r '.platforms["linux-x64"].checksum')  /usr/local/bin/claude" | sha256sum -c - \
  && chmod 755 /usr/local/bin/claude \
  && mkdir -p /etc/claude-code \
  && echo '{"env":{"DISABLE_AUTOUPDATER":"1","DISABLE_UPDATES":"1"}}' > /etc/claude-code/managed-settings.json

# Codex: its release package, as published (the binary, the code-mode host that runs its tools,
# its bwrap and rg), under /opt/codex; the sign-in in a file under CODEX_HOME.
RUN V="${CODEX_VERSION:-$(curl -fsSL https://api.github.com/repos/openai/codex/releases/latest | jq -r .tag_name | sed 's/^rust-v//')}" \
  && mkdir -p /opt/codex \
  && curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${V}/codex-package-x86_64-unknown-linux-musl.tar.gz" | tar -xz -C /opt/codex \
  && ln -s /opt/codex/bin/codex /usr/local/bin/codex \
  && mkdir -p /etc/codex \
  && printf 'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n' > /etc/codex/config.toml

# Copilot CLI: the single binary from its GitHub release.
RUN V="${COPILOT_VERSION:-$(curl -fsSL https://api.github.com/repos/github/copilot-cli/releases/latest | jq -r .tag_name | sed 's/^v//')}" \
  && curl -fsSL "https://github.com/github/copilot-cli/releases/download/v${V}/copilot-linux-x64.tar.gz" | tar -xz -C /usr/local/bin \
  && chmod 755 /usr/local/bin/copilot

# Cursor's `agent`: the package its installer downloads, under /opt; `agent` and `cursor-agent`.
RUN V="${CURSOR_VERSION:-$(curl -fsSL https://cursor.com/install | grep -oE 'lab/[0-9.]+-[0-9a-f]+' | head -n 1 | cut -d/ -f2)}" \
  && mkdir -p /opt/cursor-agent \
  && curl -fsSL "https://downloads.cursor.com/lab/${V}/linux/x64/agent-cli-package.tar.gz" | tar --strip-components=1 -xz -C /opt/cursor-agent \
  && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent \
  && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/agent \
  && echo "$V" > /opt/cursor-agent/VERSION

# Grok Build: the binary its installer downloads, as `grok` only (its installer also takes `agent`).
RUN V="${GROK_VERSION:-$(curl -fsSL https://x.ai/cli/stable)}" \
  && curl -fsSL "https://x.ai/cli/grok-${V}-linux-x86_64" -o /usr/local/bin/grok \
  && chmod 755 /usr/local/bin/grok \
  && mkdir -p /etc/grok && printf '[cli]\nauto_update = false\n' > /etc/grok/managed_config.toml

# Mistral Vibe: from PyPI, an exact version, as a uv tool.
RUN V="${VIBE_VERSION:-$(curl -fsSL https://pypi.org/pypi/mistral-vibe/json | jq -r .info.version)}" \
  && uv tool install "mistral-vibe==${V}" \
  && uv cache clean

# The terminal page: ttyd, one static binary.
RUN V="${TTYD_VERSION:-$(curl -fsSL https://api.github.com/repos/tsl0922/ttyd/releases/latest | jq -r .tag_name)}" \
  && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${V}/ttyd.x86_64" -o /usr/local/bin/ttyd \
  && chmod 755 /usr/local/bin/ttyd

# A link a CLI opens (a sign-in page) shows in the terminal instead: `show-url`, as BROWSER and as
# xdg-open (Vibe, Copilot and Cursor call it).
COPY bin/show-url /usr/local/bin/show-url
COPY bin/agent-home-versions /usr/local/bin/agent-home-versions
RUN chmod 755 /usr/local/bin/show-url /usr/local/bin/agent-home-versions \
  && ln -s /usr/local/bin/show-url /usr/local/bin/xdg-open \
  && agent-home-versions > /dev/null
