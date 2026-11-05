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
FROM ${BASE} AS native-clis

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
  && curl --retry 2 --retry-max-time 60 --connect-timeout 15 --max-time 180 -fsSL "https://github.com/github/copilot-cli/releases/download/v${V}/$A" -o "/tmp/$A" \
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

# Briq CLI: the native browser login and cloud commands, with an exact locked dependency closure.
COPY briq-cli /opt/briq-cli
RUN cd /opt/briq-cli && npm ci --ignore-scripts --no-fund --no-audit \
  && ln -s /opt/briq-cli/node_modules/.bin/briq /usr/local/bin/briq \
  && briq --version \
  && npm cache clean --force

# The terminal page: ttyd, one static binary.
RUN V="${TTYD_VERSION:-$(curl -fsSL https://api.github.com/repos/tsl0922/ttyd/releases/latest | jq -r .tag_name)}" \
  && R="https://github.com/tsl0922/ttyd/releases/download/${V}" \
  && curl -fsSL "$R/ttyd.x86_64" -o /usr/local/bin/ttyd \
  && H="$(curl -fsSL "$R/SHA256SUMS" | awk '$2 == "ttyd.x86_64" { print $1 }')" \
  && echo "$H  /usr/local/bin/ttyd" | sha256sum -c - \
  && printf 'ttyd\t%s\tits SHA256SUMS\n' "$H" >> /etc/agent-home/downloads \
  && chmod 755 /usr/local/bin/ttyd

# Shared native CLI tools; neither runtime owns the other runtime's state.
COPY bin/show-url /usr/local/bin/show-url
RUN chmod 755 /usr/local/bin/show-url && ln -s /usr/local/bin/show-url /usr/local/bin/xdg-open

# Compile the pinned MIT-licensed T3 source, including the native cloud RPC and
# creation gate. The lock and patch are verified before executing build tools.
FROM node:26.12.1-bookworm AS t3-source
WORKDIR /src
COPY t3-cloud/t3-source /input
RUN node -e 'const f=require("fs"),c=require("crypto"),m=require("/input/source.json"); if(c.createHash("sha256").update(f.readFileSync("/input/briq-sandbox.patch")).digest("hex")!==m.patchSha256)process.exit(1)'
RUN git init . && git remote add origin https://github.com/pingdotgg/t3code.git \
  && git fetch --depth 1 origin 2359643cffa6ba9ee84d6f2694b935de54a8013e \
  && git checkout --detach FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = 2359643cffa6ba9ee84d6f2694b935de54a8013e \
  && echo 'e799bbbc9cd012f14be1a75a6fcdec81956c4386306fdc3a9285191c67290c13  pnpm-lock.yaml' | sha256sum -c - \
  && git apply --check /input/briq-sandbox.patch && git apply /input/briq-sandbox.patch
RUN npm install --global pnpm@12.14.0 --ignore-scripts --no-fund --no-audit \
  && pnpm install --frozen-lockfile --filter t3... --filter @t3tools/web... --filter @t3tools/monorepo \
  && pnpm exec vp run --filter t3 build \
  && pnpm --filter t3 deploy --prod --legacy /out/t3 \
  && cp /usr/local/bin/node /out/t3/node \
  && cp /input/LICENSE /input/source.json /out/t3/ \
  && printf '#!/bin/sh\nexec /opt/t3/node /opt/t3/dist/bin.mjs "$@"\n' > /out/t3/t3 \
  && chmod 755 /out/t3/t3
# Keep the unmodified, checksum-verified native resource monitor sidecar.
RUN curl -fsSL https://github.com/pingdotgg/t3code/releases/download/v0.1.6/t3-0.1.6-linux-x64.tar.gz -o /tmp/t3.tar.gz \
  && echo '7cf31da90dee41f524dd5b679ebb6d404637ca5d9dc6fd8bc019511d57bb77e6  /tmp/t3.tar.gz' | sha256sum -c - \
  && mkdir /tmp/t3-release && tar --strip-components=1 -xzf /tmp/t3.tar.gz -C /tmp/t3-release \
  && cp -a /tmp/t3-release/resource-monitor /out/t3/

FROM native-clis AS t3-cloud
COPY --from=t3-source /out/t3 /opt/t3
RUN test -x /opt/t3/t3 \
  && printf 'T3 Code source\t2359643cffa6ba9ee84d6f2694b935de54a8013e\tpinned source, lock and local patch\n' >> /etc/agent-home/downloads

COPY t3-cloud /opt/t3-cloud
COPY bin/t3-cloud-start /usr/local/bin/t3-cloud-start
RUN chmod 755 /usr/local/bin/t3-cloud-start
EXPOSE 8080
CMD ["t3-cloud-start"]

# Keep the original default target for existing docker build callers.
FROM native-clis AS agent-home
# Optional DSH ACP harness: exact preview and full dependency closure, registry integrity
# verified by npm ci. Disabled in the runner until RUNNER_DSH=1 and a provider patch is configured.
# No lifecycle scripts or runtime package installation are needed.
COPY dsh /opt/dsh
RUN cd /opt/dsh && npm ci --ignore-scripts --no-fund --no-audit \
  && ./node_modules/.bin/dsh --version \
  && npm cache clean --force

# The runner: drives the CLIs over ACP for apps, and keeps their sessions (runner/README.md). Its
# two adapters are pinned in its lockfile, installed without the copies of the CLIs they bring:
# they run the binaries above.
COPY runner /opt/agent-home-runner
RUN cd /opt/agent-home-runner \
  && npm ci --omit=optional --omit=dev --no-fund --no-audit \
  && npm cache clean --force \
  && printf '#!/bin/sh\nexec node /opt/agent-home-runner/src/main.ts "$@"\n' > /usr/local/bin/agent-home-runner \
  && chmod 755 /usr/local/bin/agent-home-runner \
  && printf '#!/bin/sh\nexec node /opt/agent-home-runner/bin/briq-agent-acp.ts "$@"\n' > /usr/local/bin/briq-agent-acp \
  && chmod 755 /usr/local/bin/briq-agent-acp \
  && node --input-type=module -e "await import('/opt/agent-home-runner/src/providers/catalog.ts')"

# A link a CLI opens (a sign-in page) shows in the terminal instead: `show-url`, as BROWSER and as
# xdg-open (Vibe, Copilot and Cursor call it).
COPY bin/agent-home-versions /usr/local/bin/agent-home-versions
COPY bin/agent-home-start /usr/local/bin/agent-home-start
RUN chmod 755 /usr/local/bin/show-url /usr/local/bin/agent-home-versions \
  && chmod 755 /usr/local/bin/agent-home-start \
  && agent-home-versions > /dev/null

EXPOSE 8090
CMD ["agent-home-start"]
