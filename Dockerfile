# The briq agent home: what `briq_run({ recipe: "agent-home" })` runs on briq.cloud. One person's
# computer, where they sign in to each vendor's agent CLI with the vendor's own flow and their
# agents run on their own plans.
#
# The briq sandbox image (github.com/briq-cloud/sandbox: Ubuntu, Python, Node, git, the tools), plus
# the vendors' agent CLIs and a terminal page. Each CLI is the vendor's binary as published, at the
# version this build resolved (a date tag never moves), with its self-update off: a newer CLI comes
# with next week's build, never from inside a running home. Pass a version as a build arg to pin it;
# empty means the vendor's current stable release. What is inside, with versions: REFERENCE.md.
#
# Every download is checked against the checksum its publisher gives (Claude Code's manifest, the
# GitHub release's asset digest, ttyd's SHA256SUMS, PyPI's, the npm registry's integrity), and
# fails the build on a mismatch.
# Cursor and Grok publish none, as their own installers check none: their hashes are recorded.
# Each one's sha256 is in /etc/agent-home/downloads and REFERENCE.md. The build passes BASE pinned
# by digest; its provenance is attested on GitHub (`gh attestation verify`).
ARG BASE=ghcr.io/briq-cloud/sandbox:latest
FROM ${BASE}

ARG CLAUDE_VERSION=
ARG CODEX_VERSION=
ARG COPILOT_VERSION=
ARG CURSOR_VERSION=
ARG GROK_VERSION=
ARG VIBE_VERSION=
ARG GEMINI_VERSION=
ARG TTYD_VERSION=

# One line per download: what, its sha256, how it was checked.
RUN mkdir -p /etc/agent-home && : > /etc/agent-home/downloads

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
  && H="$(curl -fsSL "$B/$V/manifest.json" | jq -r '.platforms["linux-x64"].checksum')" \
  && echo "$H  /usr/local/bin/claude" | sha256sum -c - \
  && printf 'Claude Code\t%s\tits release manifest\n' "$H" >> /etc/agent-home/downloads \
  && chmod 755 /usr/local/bin/claude \
  && mkdir -p /etc/claude-code \
  && echo '{"env":{"DISABLE_AUTOUPDATER":"1","DISABLE_UPDATES":"1"}}' > /etc/claude-code/managed-settings.json

# A GitHub release asset's sha256, as GitHub computed it at upload: `gh-digest owner/repo tag name`.
# The build passes each one in (resolved with its token); a local build asks the API.
COPY bin/gh-digest /usr/local/bin/gh-digest

# Codex: its release package, as published (the binary, the code-mode host that runs its tools,
# its bwrap and rg), under /opt/codex; the sign-in in a file under CODEX_HOME.
ARG CODEX_SHA256=
RUN V="${CODEX_VERSION:-$(curl -fsSL https://api.github.com/repos/openai/codex/releases/latest | jq -r .tag_name | sed 's/^rust-v//')}" \
  && A=codex-package-x86_64-unknown-linux-musl.tar.gz \
  && H="${CODEX_SHA256:-$(gh-digest openai/codex "rust-v${V}" "$A")}" \
  && curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${V}/$A" -o "/tmp/$A" \
  && echo "$H  /tmp/$A" | sha256sum -c - \
  && printf 'Codex\t%s\tthe GitHub release digest\n' "$H" >> /etc/agent-home/downloads \
  && mkdir -p /opt/codex && tar -xzf "/tmp/$A" -C /opt/codex && rm "/tmp/$A" \
  && ln -s /opt/codex/bin/codex /usr/local/bin/codex \
  && mkdir -p /etc/codex \
  && printf 'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n' > /etc/codex/config.toml

# Copilot CLI: the single binary from its GitHub release.
ARG COPILOT_SHA256=
RUN V="${COPILOT_VERSION:-$(curl -fsSL https://api.github.com/repos/github/copilot-cli/releases/latest | jq -r .tag_name | sed 's/^v//')}" \
  && A=copilot-linux-x64.tar.gz \
  && H="${COPILOT_SHA256:-$(gh-digest github/copilot-cli "v${V}" "$A")}" \
  && curl -fsSL "https://github.com/github/copilot-cli/releases/download/v${V}/$A" -o "/tmp/$A" \
  && echo "$H  /tmp/$A" | sha256sum -c - \
  && printf 'Copilot CLI\t%s\tthe GitHub release digest\n' "$H" >> /etc/agent-home/downloads \
  && tar -xzf "/tmp/$A" -C /usr/local/bin && rm "/tmp/$A" \
  && chmod 755 /usr/local/bin/copilot

# Cursor's `agent`: the package its installer downloads, under /opt; `agent` and `cursor-agent`.
RUN V="${CURSOR_VERSION:-$(curl -fsSL https://cursor.com/install | grep -oE 'lab/[0-9.]+-[0-9a-f]+' | head -n 1 | cut -d/ -f2)}" \
  && mkdir -p /opt/cursor-agent \
  && curl -fsSL "https://downloads.cursor.com/lab/${V}/linux/x64/agent-cli-package.tar.gz" -o /tmp/cursor.tar.gz \
  && printf 'Cursor\t%s\tnone published: recorded\n' "$(sha256sum /tmp/cursor.tar.gz | cut -d' ' -f1)" >> /etc/agent-home/downloads \
  && tar --strip-components=1 -xzf /tmp/cursor.tar.gz -C /opt/cursor-agent && rm /tmp/cursor.tar.gz \
  && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent \
  && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/agent \
  && echo "$V" > /opt/cursor-agent/VERSION

# Grok Build: the binary its installer downloads, as `grok` only (its installer also takes `agent`).
RUN V="${GROK_VERSION:-$(curl -fsSL https://x.ai/cli/stable)}" \
  && curl -fsSL "https://x.ai/cli/grok-${V}-linux-x86_64" -o /usr/local/bin/grok \
  && printf 'Grok Build\t%s\tnone published: recorded\n' "$(sha256sum /usr/local/bin/grok | cut -d' ' -f1)" >> /etc/agent-home/downloads \
  && chmod 755 /usr/local/bin/grok \
  && mkdir -p /etc/grok && printf '[cli]\nauto_update = false\n' > /etc/grok/managed_config.toml

# Mistral Vibe: its Linux x86_64 wheel from PyPI, an exact version, checked against PyPI's sha256, as a uv tool.
RUN V="${VIBE_VERSION:-$(curl -fsSL https://pypi.org/pypi/mistral-vibe/json | jq -r .info.version)}" \
  && W="$(curl -fsSL "https://pypi.org/pypi/mistral-vibe/${V}/json" | jq -c '[.urls[] | select(.filename | test("manylinux.*_x86_64\\.whl$"))][0]')" \
  && F="/tmp/$(echo "$W" | jq -r .filename)" H="$(echo "$W" | jq -r .digests.sha256)" \
  && curl -fsSL "$(echo "$W" | jq -r .url)" -o "$F" \
  && echo "$H  $F" | sha256sum -c - \
  && printf 'Mistral Vibe\t%s\tthe PyPI digest of its wheel\n' "$H" >> /etc/agent-home/downloads \
  && uv tool install "$F" \
  && rm "$F" && uv cache clean

# An npm package at an exact version, its tarball checked against the registry's integrity before
# it is installed: `npm-verified <package> <version> <integrity>` prints the tarball's path.
COPY bin/npm-verified /usr/local/bin/npm-verified

# Gemini CLI: from npm. API keys only (it serves no consumer plan since 2026-06-18), updates and
# usage statistics off, in its system settings, which win over the person's own.
ARG GEMINI_INTEGRITY=
RUN V="${GEMINI_VERSION:-$(npm view @google/gemini-cli version)}" \
  && F="$(npm-verified @google/gemini-cli "$V" "$GEMINI_INTEGRITY")" \
  && printf 'Gemini CLI\t%s\tthe npm registry integrity\n' "$(sha256sum "$F" | cut -d' ' -f1)" >> /etc/agent-home/downloads \
  && npm install -g --no-fund --no-audit "$F" && rm "$F" \
  && mkdir -p /etc/gemini-cli \
  && echo '{"security":{"auth":{"selectedType":"gemini-api-key","enforcedType":"gemini-api-key"}},"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false},"privacy":{"usageStatisticsEnabled":false}}' > /etc/gemini-cli/settings.json

# The terminal page: ttyd, one static binary.
RUN V="${TTYD_VERSION:-$(curl -fsSL https://api.github.com/repos/tsl0922/ttyd/releases/latest | jq -r .tag_name)}" \
  && R="https://github.com/tsl0922/ttyd/releases/download/${V}" \
  && curl -fsSL "$R/ttyd.x86_64" -o /usr/local/bin/ttyd \
  && H="$(curl -fsSL "$R/SHA256SUMS" | awk '$2 == "ttyd.x86_64" { print $1 }')" \
  && echo "$H  /usr/local/bin/ttyd" | sha256sum -c - \
  && printf 'ttyd\t%s\tits SHA256SUMS\n' "$H" >> /etc/agent-home/downloads \
  && chmod 755 /usr/local/bin/ttyd

# The runner: drives the CLIs over ACP for apps, and keeps their sessions (runner/README.md). Its
# two adapters are pinned in its lockfile, installed without the copies of the CLIs they bring:
# they run the binaries above.
COPY runner /opt/agent-home-runner
RUN cd /opt/agent-home-runner \
  && npm ci --omit=optional --omit=dev --no-fund --no-audit \
  && npm cache clean --force \
  && printf '#!/bin/sh\nexec node /opt/agent-home-runner/src/main.ts "$@"\n' > /usr/local/bin/agent-home-runner \
  && chmod 755 /usr/local/bin/agent-home-runner \
  && node --input-type=module -e "await import('/opt/agent-home-runner/src/clis.ts')"

# A link a CLI opens (a sign-in page) shows in the terminal instead: `show-url`, as BROWSER and as
# xdg-open (Vibe, Copilot and Cursor call it).
COPY bin/show-url /usr/local/bin/show-url
COPY bin/agent-home-versions /usr/local/bin/agent-home-versions
RUN chmod 755 /usr/local/bin/show-url /usr/local/bin/agent-home-versions \
  && ln -s /usr/local/bin/show-url /usr/local/bin/xdg-open \
  && agent-home-versions > /dev/null
