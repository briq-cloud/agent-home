import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  statSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@agentclientprotocol/sdk';
export type { McpServer } from '@agentclientprotocol/sdk';

const name = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,95}$/);
const bounded = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'));
const url = bounded.refine((value) => {
  try {
    const u = new URL(value);
    return (
      ['https:', 'http:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      (u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
    );
  } catch {
    return false;
  }
}, 'URL must be HTTPS or loopback HTTP without credentials, query or fragment');
const headerRef = z.union([
  envName,
  z
    .object({
      env: envName,
      prefix: z
        .string()
        .max(64)
        .refine((value) => !/[\r\n\0]/.test(value)),
    })
    .strict(),
]);
const refEnv = (ref: string | { env: string; prefix: string }) => (typeof ref === 'string' ? ref : ref.env);
const common = { name, enabled: z.boolean().default(true), required: z.boolean().default(false) };
const serverSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...common,
      transport: z.literal('stdio'),
      command: bounded.refine(isAbsolute),
      args: z.array(bounded).max(64).default([]),
      envRefs: z
        .record(envName, envName)
        .refine((value) => Object.keys(value).length <= 32)
        .default({}),
    })
    .strict(),
  z
    .object({
      ...common,
      transport: z.enum(['http', 'sse']),
      url,
      headerEnvRefs: z
        .record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/), headerRef)
        .refine((value) => Object.keys(value).length <= 16)
        .default({}),
    })
    .strict(),
]);
const skillSchema = z
  .object({
    name: name.refine((value) => value.startsWith('home-')),
    description: z.string().min(1).max(1024),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const registrySchema = z
  .object({ version: z.literal(1), servers: z.array(serverSchema).max(32), skills: z.array(skillSchema).max(64) })
  .strict();
export type ServerDefinition = z.input<typeof serverSchema>;
export type InstalledSkill = z.infer<typeof skillSchema>;
type RegistryData = z.infer<typeof registrySchema>;
export type DeploymentContext = { platform: 'briq'; apiUrl: string; homeId: string; stackId: string };
export type ExtensionStatus = {
  name: string;
  status: 'ready' | 'disabled' | 'auth_required' | 'unsupported' | 'unverified';
  reason?: string;
};
export type AgentCapabilities = {
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: { systemPrompt?: unknown };
};
export type ExtensionPlan = {
  registryRevision: string;
  statuses: ExtensionStatus[];
  blocked: boolean /** Dispatch only: may contain resolved credentials. Never persist or log. */;
  servers: McpServer[];
};
// Match the pinned ACP v1 wire shape. Caller configuration is not owner registry input.
// Preserve metadata/extension fields and delegate URL/command handling to the chosen agent.
const wirePair = z.object({ name: z.string(), value: z.string() }).passthrough();
const incomingSchema = z.union([
  z.object({ name: z.string(), command: z.string(), args: z.array(z.string()), env: z.array(wirePair) }).passthrough(),
  z
    .object({ name: z.string(), type: z.enum(['http', 'sse']), url: z.string(), headers: z.array(wirePair) })
    .passthrough(),
]);
const linksSchema = z
  .object({
    version: z.literal(1),
    links: z
      .array(
        z
          .object({
            name,
            path: bounded.refine(isAbsolute),
            target: bounded.refine(isAbsolute),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            previous: z
              .object({ target: bounded.refine(isAbsolute), hash: z.string().regex(/^[a-f0-9]{64}$/) })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
type OwnedLink = z.infer<typeof linksSchema>['links'][number];
export type SkillLinkResult = {
  name: string;
  path: string;
  status: 'installed' | 'present' | 'updated' | 'removed' | 'conflict';
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function unique(values: Array<{ name: string }>): void {
  if (new Set(values.map((value) => value.name)).size !== values.length) throw Error('Duplicate extension name');
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function privateWrite(path: string, content: string): void {
  const temp = path + '.' + randomUUID() + '.tmp';
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    chmodSync(path, 0o600);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export function validateDeploymentContext(value: DeploymentContext): DeploymentContext {
  if (value.platform !== 'briq') throw Error('Unsupported deployment context');
  url.parse(value.apiUrl);
  for (const id of [value.homeId, value.stackId])
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id))
      throw Error('Invalid deployment identity');
  return { platform: 'briq', apiUrl: value.apiUrl.replace(/\/$/, ''), homeId: value.homeId, stackId: value.stackId };
}

/** Owner-controlled definitions only. This module never executes programs or contacts services. */
export class ExtensionRegistry {
  readonly created: boolean;
  private readonly dir: string;
  private readonly file: string;
  private readonly deployment?: DeploymentContext;
  constructor(options: { stateDir: string; deployment?: DeploymentContext }) {
    this.dir = join(resolve(options.stateDir), 'extensions');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (lstatSync(this.dir).isSymbolicLink()) throw Error('Extension state directory must not be a symlink');
    chmodSync(this.dir, 0o700);
    this.file = join(this.dir, 'registry.json');
    this.deployment = options.deployment && validateDeploymentContext(options.deployment);
    this.created = !existsSync(this.file);
    if (this.created) this.save({ version: 1, servers: [], skills: [] });
    this.read();
    chmodSync(this.file, 0o600);
  }
  private read(): RegistryData {
    if (lstatSync(this.file).isSymbolicLink() || lstatSync(this.file).size > 256_000)
      throw Error('Invalid extension registry file');
    const data = registrySchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    unique(data.servers);
    unique(data.skills);
    return data;
  }
  private save(data: RegistryData): void {
    const parsed = registrySchema.parse(data);
    unique(parsed.servers);
    unique(parsed.skills);
    const content = JSON.stringify(parsed, null, 2) + '\n';
    if (Buffer.byteLength(content) > 256_000) throw Error('Extension registry exceeds 256000 byte limit');
    privateWrite(this.file, content);
  }
  list(): RegistryData & { revision: string } {
    const data = { ...this.read(), servers: this.definitions() };
    return { ...data, revision: digest(JSON.stringify(data)) };
  }
  putServer(input: ServerDefinition): void {
    const server = serverSchema.parse(input);
    if (server.name === 'briq' && this.deployment) throw Error('briq is reserved by deployment context');
    if (server.transport === 'stdio') {
      try {
        accessSync(server.command, constants.X_OK);
        if (!statSync(server.command).isFile()) throw Error();
      } catch {
        throw Error('MCP command must be an installed executable');
      }
    }
    const data = this.read();
    data.servers = data.servers.filter((value) => value.name !== server.name);
    data.servers.push(server);
    data.servers.sort((a, b) => a.name.localeCompare(b.name));
    this.save(data);
  }
  removeServer(serverName: string): void {
    name.parse(serverName);
    if (serverName === 'briq' && this.deployment) throw Error('briq is reserved by deployment context');
    const data = this.read();
    data.servers = data.servers.filter((value) => value.name !== serverName);
    this.save(data);
  }
  putSkill(input: { name: string; description: string; body: string }): InstalledSkill {
    name.refine((value) => value.startsWith('home-')).parse(input.name);
    if (
      typeof input.description !== 'string' ||
      !input.description.trim() ||
      input.description.length > 1024 ||
      /[\r\n\0]/.test(input.description)
    )
      throw Error('Invalid skill description');
    if (
      typeof input.body !== 'string' ||
      !input.body.trim() ||
      Buffer.byteLength(input.body) > 64_000 ||
      input.body.includes('\0')
    )
      throw Error('Invalid skill body');
    const content = `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.body.trim()}\n`;
    const skill = { name: input.name, description: input.description, hash: digest(content) };
    let dir = this.dir;
    for (const component of ['skills', skill.name, skill.hash]) {
      dir = join(dir, component);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (lstatSync(dir).isSymbolicLink()) throw Error('Canonical skill directory must not be a symlink');
    }
    const path = join(dir, 'SKILL.md');
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink() || digest(readFileSync(path, 'utf8')) !== skill.hash)
        throw Error('Skill content integrity conflict');
    } else privateWrite(path, content);
    const data = this.read();
    data.skills = data.skills.filter((value) => value.name !== skill.name);
    data.skills.push(skill);
    data.skills.sort((a, b) => a.name.localeCompare(b.name));
    this.save(data);
    return skill;
  }
  /** Unlink only verifiably owned discovery entries; active sessions may retain loaded instructions. */
  removeSkill(skillName: string): SkillLinkResult[] {
    name.refine((value) => value.startsWith('home-')).parse(skillName);
    const data = this.read();
    data.skills = data.skills.filter((value) => value.name !== skillName);
    this.save(data);
    return this.reconcileRemovedLinks();
  }
  private readLinks(): OwnedLink[] {
    const file = join(this.dir, 'links.json');
    if (!existsSync(file)) return [];
    if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 256_000)
      throw Error('Invalid managed skill ownership file');
    const links = linksSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).links;
    if (new Set(links.map((link) => link.path)).size !== links.length) throw Error('Duplicate managed skill path');
    for (const link of links)
      if (
        link.target !== join(this.dir, 'skills', link.name, link.hash) ||
        !link.name.startsWith('home-') ||
        !link.path.endsWith('/' + link.name) ||
        (link.previous && link.previous.target !== join(this.dir, 'skills', link.name, link.previous.hash))
      )
        throw Error('Invalid managed skill ownership');
    return links;
  }
  private saveLinks(links: OwnedLink[]): void {
    const data = linksSchema.parse({ version: 1, links });
    const content = JSON.stringify(data) + '\n';
    if (Buffer.byteLength(content) > 256_000) throw Error('Skill ownership exceeds byte limit');
    privateWrite(join(this.dir, 'links.json'), content);
  }
  private matchesOwned(link: OwnedLink): boolean {
    try {
      if (!lstatSync(link.path).isSymbolicLink()) return false;
      const actual = resolve(dirname(link.path), readlinkSync(link.path));
      return [link, link.previous].some(
        (value) =>
          value &&
          actual === value.target &&
          digest(readFileSync(join(value.target, 'SKILL.md'), 'utf8')) === value.hash,
      );
    } catch {
      return false;
    }
  }
  private reconcileRemovedLinks(): SkillLinkResult[] {
    const names = new Set(this.read().skills.map((skill) => skill.name)),
      links = this.readLinks(),
      kept: OwnedLink[] = [],
      results: SkillLinkResult[] = [];
    for (const link of links) {
      if (names.has(link.name)) {
        kept.push(link);
        continue;
      }
      try {
        lstatSync(link.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (this.matchesOwned(link)) {
        unlinkSync(link.path);
        syncDirectory(dirname(link.path));
        results.push({ name: link.name, path: link.path, status: 'removed' });
      } else {
        kept.push(link);
        results.push({ name: link.name, path: link.path, status: 'conflict' });
      }
    }
    this.saveLinks(kept);
    return results;
  }
  installBuiltins(): InstalledSkill[] {
    return ['home-agent-home', 'home-briq'].map((skillName) => {
      const content = readFileSync(
        fileURLToPath(new URL(`../../skills/${skillName}/SKILL.md`, import.meta.url)),
        'utf8',
      );
      const match = content.match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n([\s\S]*)$/);
      if (!match) throw Error('Invalid builtin skill');
      const data = this.read(),
        existing = data.skills.find((value) => value.name === skillName);
      return existing ?? this.putSkill({ name: match[1]!, description: match[2]!, body: match[3]! });
    });
  }
  /** Caller supplies verified native home locations. Only recorded, still-matching links can change. */
  syncSkills(options: { agentsHome?: string; claudeConfigDir?: string }): SkillLinkResult[] {
    const roots = [
      options.agentsHome && join(resolve(options.agentsHome), 'skills'),
      options.claudeConfigDir && join(resolve(options.claudeConfigDir), 'skills'),
    ].filter((value): value is string => !!value);
    const results = this.reconcileRemovedLinks(),
      owned = this.readLinks();
    for (const root of new Set(roots)) {
      const skills = this.read().skills;
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
        results.push(
          ...skills.map((skill) => ({ name: skill.name, path: join(root, skill.name), status: 'conflict' as const })),
        );
        continue;
      }
      for (const skill of skills) {
        const target = join(this.dir, 'skills', skill.name, skill.hash),
          path = join(root, skill.name),
          previous = owned.find((link) => link.path === path);
        if (digest(readFileSync(join(target, 'SKILL.md'), 'utf8')) !== skill.hash)
          throw Error('Skill content integrity conflict');
        let exists = true;
        try {
          lstatSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          exists = false;
        }
        const next = { name: skill.name, path, target, hash: skill.hash };
        if (exists) {
          if (!previous || !this.matchesOwned(previous)) {
            results.push({ name: skill.name, path, status: 'conflict' });
            continue;
          }
          if (resolve(root, readlinkSync(path)) === target) {
            if (previous.previous) {
              owned.splice(owned.indexOf(previous), 1, next);
              this.saveLinks(owned);
            }
            results.push({ name: skill.name, path, status: 'present' });
            continue;
          }
          const actual = resolve(root, readlinkSync(path)),
            old = actual === previous.target ? previous : previous.previous!;
          const pending = { ...next, previous: { target: old.target, hash: old.hash } };
          // Durable recovery evidence precedes the atomic link switch. Either exact
          // recorded content target remains recognizable after an interrupted update.
          owned.splice(owned.indexOf(previous), 1, pending);
          this.saveLinks(owned);
          const temp = path + '.' + randomUUID() + '.tmp';
          try {
            symlinkSync(target, temp, 'dir');
            if (!this.matchesOwned(pending)) throw Error('Managed skill link changed during update');
            renameSync(temp, path);
            syncDirectory(root);
          } finally {
            if (existsSync(temp)) unlinkSync(temp);
          }
          owned.splice(owned.indexOf(pending), 1, next);
          this.saveLinks(owned);
          results.push({ name: skill.name, path, status: 'updated' });
        } else {
          if (owned.length >= 256 && !previous) throw Error('Managed skill link limit reached');
          // Record the exact creation intent first so a process interruption
          // cannot leave an undiscoverable, permanently unmanaged skill link.
          if (previous) owned.splice(owned.indexOf(previous), 1, next);
          else owned.push(next);
          this.saveLinks(owned);
          symlinkSync(target, path, 'dir');
          syncDirectory(root);
          results.push({ name: skill.name, path, status: 'installed' });
        }
      }
    }
    return results;
  }
  private definitions(): RegistryData['servers'] {
    const data = this.read().servers;
    if (!this.deployment) return data;
    if (data.some((server) => server.name === 'briq')) throw Error('Deployment briq server conflicts with registry');
    return [
      ...data,
      serverSchema.parse({
        name: 'briq',
        transport: 'http',
        url: this.deployment.apiUrl + '/mcp',
        headerEnvRefs: { Authorization: { env: 'BRIQ_MCP_TOKEN', prefix: 'Bearer ' } },
      }),
    ];
  }
  /** Pure status: presence names only, never reads credential values. */
  status(input: {
    cli: string;
    capabilities: AgentCapabilities;
    availableEnvNames: Iterable<string>;
  }): ExtensionStatus[] {
    const available = new Set(input.availableEnvNames);
    return this.definitions().map((server) => {
      if (!server.enabled) return { name: server.name, status: 'disabled' };
      const refs = Object.values(server.transport === 'stdio' ? server.envRefs : server.headerEnvRefs);
      if (refs.some((ref) => !available.has(refEnv(ref)))) return { name: server.name, status: 'auth_required' };
      if (['cursor', 'grok'].includes(input.cli))
        return {
          name: server.name,
          status: 'unverified',
          reason: 'Session MCP injection is not verified for this CLI',
        };
      if (!['claude', 'codex', 'copilot', 'vibe', 'gemini'].includes(input.cli))
        return { name: server.name, status: 'unverified', reason: 'Unknown CLI compatibility' };
      if (server.transport !== 'stdio' && !input.capabilities.mcpCapabilities?.[server.transport])
        return { name: server.name, status: 'unsupported', reason: 'MCP transport is not advertised' };
      return { name: server.name, status: 'ready' };
    });
  }
  plan(input: {
    cli: string;
    capabilities: AgentCapabilities;
    incomingServers?: McpServer[];
    env?: Record<string, string | undefined>;
  }): ExtensionPlan {
    const env = input.env ?? {},
      incoming = z
        .array(incomingSchema)
        .max(32)
        .parse(input.incomingServers ?? []);
    if (incoming.length > 32) throw Error('Too many incoming MCP servers');
    unique(incoming);
    const definitions = this.definitions();
    if (definitions.some((server) => incoming.some((value) => value.name === server.name)))
      throw Error('Shared and incoming MCP server names conflict');
    const statuses = this.status({ ...input, availableEnvNames: Object.keys(env).filter((key) => !!env[key]) });
    const servers: McpServer[] = [...incoming] as McpServer[];
    for (const server of definitions) {
      if (statuses.find((value) => value.name === server.name)?.status !== 'ready') continue;
      const get = (ref: string) => {
        const value = env[ref];
        if (!value || value.length > 8192 || /[\r\n\0]/.test(value)) throw Error('Invalid extension credential value');
        return value;
      };
      if (server.transport === 'stdio')
        servers.push({
          name: server.name,
          command: server.command,
          args: [...server.args],
          env: Object.entries(server.envRefs).map(([name, ref]) => ({ name, value: get(ref) })),
        });
      else
        servers.push({
          name: server.name,
          type: server.transport,
          url: server.url,
          headers: Object.entries(server.headerEnvRefs).map(([name, ref]) => ({
            name,
            value: (typeof ref === 'string' ? '' : ref.prefix) + get(refEnv(ref)),
          })),
        });
    }
    if (servers.length > 32) throw Error('Too many composed MCP servers');
    return {
      registryRevision: digest(JSON.stringify([this.list().revision, this.deployment ?? null])),
      statuses,
      blocked: definitions.some(
        (server) =>
          server.enabled && server.required && statuses.find((value) => value.name === server.name)?.status !== 'ready',
      ),
      servers,
    };
  }
}

/** Supplemental context only. Native adapters decide its actual instruction tier. */
export function homeInstructions(input: {
  workspace: string;
  availableTools: string[];
  deployment?: DeploymentContext;
}): string {
  if (!isAbsolute(input.workspace) || input.workspace.length > 4096 || /[\r\n\0]/.test(input.workspace))
    throw Error('Invalid workspace');
  if (input.availableTools.length > 64 || input.availableTools.some((value) => !/^[-a-zA-Z0-9_.:]{1,128}$/.test(value)))
    throw Error('Invalid available tools');
  const deployment = input.deployment && validateDeploymentContext(input.deployment);
  return [
    'Agent Home provides durable task state and project-scoped coordination.',
    `Registered workspace: ${input.workspace}.`,
    `Configured shared MCP connections: ${[...new Set(input.availableTools)].sort().join(', ') || 'none'}.`,
    'Native tool discovery and remote authorization still determine which tools are actually available.',
    'Use only tools actually available in this session. User and project instructions still apply; this context grants no extra permissions.',
    'CLI execution cost may be unknown. Admission estimates do not cap provider charges. A recorded cancellation may precede vendor shutdown.',
    deployment
      ? `Briq deployment: home ${deployment.homeId}; stack ${deployment.stackId}; API ${deployment.apiUrl}. A configured endpoint alone does not establish authentication.`
      : 'No Briq deployment context is configured.',
  ].join('\n');
}
