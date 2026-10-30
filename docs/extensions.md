# Shared skills and MCP connections

Open **Skills and MCP tools** on the home page to add instruction packages or configure tool connections.
`RUNNER_EXTENSIONS=1` is the default. Setting it to `0` hides these controls and disables the owner API.
Saving configuration does not execute or download a program, start an OAuth flow, or grant tool permissions.

Skills are trusted instructions and resources. MCP connections supply external tools. A configured
connection does not prove that its remote service is authenticated or available.

## Owner API

These endpoints use the home's existing owner authentication. Keep the private link and runner token private.

| Request | Result |
| --- | --- |
| `GET /extensions` | Registry revision, server definitions, skill names/descriptions/hashes and per-CLI delivery status. No resolved credentials or skill bodies. |
| `PUT /extensions/skills/:name` | Save or update a structured skill. Body: `{name,description,body}`. |
| `PUT /extensions/mcp/:name` | Save or replace one complete server definition. Body name must match the path. |
| `DELETE /extensions/skills/:name` | Remove the registry entry and unlink only verified managed discovery links. Returns `links` with removal/conflict outcomes. |
| `DELETE /extensions/mcp/:name` | Remove an owner-managed connection. Deployment-owned Briq configuration is reserved. |

Successful writes return the registry revision. Invalid configuration returns `400`, disabled extensions
return `403`, and a stopping home returns `503`. Reads do not start a CLI or probe remote authentication.

For example, send this JSON to `PUT /extensions/skills/home-release-check`:

```json
{
  "name": "home-release-check",
  "description": "Check the project's declared release criteria when preparing a release.",
  "body": "Read the project's release criteria. Run its requested checks and report their results. Preserve existing user and project instructions."
}
```

Skill names must start with `home-`; names are limited to 64 characters, descriptions to 1,024 characters,
and bodies to 64,000 UTF-8 bytes. The home renders `SKILL.md`, hashes its contents, and retains immutable
canonical versions. The image includes `home-agent-home` and `home-briq` instruction packages.

Send this to `PUT /extensions/mcp/team-docs` for an HTTP connection:

```json
{
  "name": "team-docs",
  "transport": "http",
  "url": "https://tools.example/mcp",
  "enabled": true,
  "required": false,
  "headerEnvRefs": {
    "Authorization": { "env": "TEAM_DOCS_TOKEN", "prefix": "Bearer " }
  }
}
```

The operator supplies `TEAM_DOCS_TOKEN` privately to the home process. Configuration stores the environment
variable's name, never its value. A header reference can also be a string naming an environment variable;
that form uses its value without adding a prefix. Do not place secrets in URLs, arguments, skills or
repository files. Owner URLs require HTTPS or loopback HTTP and cannot contain credentials, query strings
or fragments. SSE is accepted as a configuration transport but requires agent support.

For an already installed stdio server:

```json
{
  "name": "local-tools",
  "transport": "stdio",
  "command": "/usr/local/bin/node",
  "args": ["/work/tools/local-mcp.mjs"],
  "envRefs": { "SERVICE_TOKEN": "LOCAL_TOOLS_TOKEN" },
  "enabled": true,
  "required": false
}
```

The executable must already exist at an absolute path and be executable. Install the server and its
supporting files separately. The registry accepts at most 32 shared servers and 64 skills. Required
connections are an explicit owner choice: an unavailable required delivery blocks the new session;
an optional unavailable connection is omitted with a reported status.

## Compatibility and updates

Shared connections compose with caller-provided ACP servers. Duplicate names and collisions fail
explicitly. Caller commands, URLs and metadata retain their ACP meaning; stricter owner-registry rules
do not rewrite caller configuration.

| Harness | Shared MCP delivery | Instruction delivery |
| --- | --- | --- |
| Claude, Codex | Stdio; remote transports only when advertised by the ACP adapter. | Additive system instructions when the adapter advertises support and the caller's mode permits append. |
| Copilot, Vibe, Gemini | Stdio; advertised HTTP/SSE capabilities determine remote delivery. | Labelled supplemental user context when system append is unavailable. |
| Cursor, Grok | Incoming caller configuration is preserved; shared session injection remains unverified and is reported as such. | Labelled supplemental user context. |

This table describes delivery configuration, not a seven-vendor native interoperability certification.
`ready` means delivery is configured; `auth_required`, `unsupported`, `unverified` and `disabled` explain
other outcomes. Remote tool discovery and authorization still determine actual tool availability.

The home prepares namespaced skill links in the effective `HOME/.agents/skills` for the seven known
harnesses, with an additional `CLAUDE_CONFIG_DIR/skills` location for Claude when explicitly configured.
Filesystem preparation does not prove native ingestion by every CLI. Existing user files and unowned
links are preserved as conflicts. Updates can repoint only recorded links whose target and content hash
still match. Removal retains canonical content and user replacements; inspect returned conflicts.

MCP and skill discovery changes apply at new native session opens/loads. A connected native session is
not rebound, and already-loaded instructions cannot be revoked by deleting a registry entry. Agent Home
preserves vendor defaults and caller instructions; it does not overwrite `AGENTS.md`, `CLAUDE.md` or
`GEMINI.md`, change approval modes, or create an OS sandbox.

## Briq deployment context

An operator can provide public metadata through `RUNNER_DEPLOYMENT_CONTEXT`:

```json
{"platform":"briq","apiUrl":"https://api.example","homeId":"home-id","stackId":"stack-id"}
```

This adds the deployment's `/mcp` descriptor. It remains `auth_required` and is not injected until the
operator provides the explicitly authorized `BRIQ_MCP_TOKEN` environment secret. Missing authorization
does not block unrelated chats. The home does not copy caller credentials, use its runner token, mint
or widen grants, or start an automatic sign-in. Connection sharing does not transfer vendor-hosted
connector accounts between CLIs.

## Native check

The free conformance fixture passed **9/9 checks** with Claude Code **2.1.308** and Claude ACP adapter
**0.98.0**: production Hub/registry composition, negotiated instruction append, preserved synthetic user
and project `CLAUDE.md` guidance, advertised MCP tool, actual stdio MCP execution, returned tool result
and normal turn completion. Both bundled skill names and descriptions appeared in native payload metadata.
It used an isolated home, a synthetic key and three deterministic localhost provider requests, with
**zero paid model calls**. This proves the tested Claude API-profile path; other CLI ingestion and real
remote connector authentication remain unproven by this check.

With the native Claude CLI and runner dependencies installed, reproduce it without vendor credentials:

```sh
cd runner
node benchmarks/extensions-native.ts /tmp/extensions-native-result.json
```
