import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OpenRouter } from '@openrouter/sdk';
import { z } from 'zod';
import type { configuration } from './config.ts';
import type { Hub } from '../acp/hub.ts';
import type { Cli } from '../providers/catalog.ts';
import { PROVIDERS, type Keys, type Profile } from '../providers/profiles.ts';
import { ContextStore } from '../context/store.ts';
import { TaskStore } from '../tasks/index.ts';
import { Routing, type Binding } from '../routing/index.ts';
import { Engine, type EngineSubmission } from '../orchestration/engine.ts';
import { Projects } from '../orchestration/projects.ts';
import { Delegation } from '../orchestration/delegation.ts';
import { nextEligible, type OffpeakPolicy } from '../scheduling/offpeak.ts';
import { commandBilling } from '../auth/status.ts';
import { DEFAULT_AUTO_PROFILE } from '../providers/auto-models.ts';
import { validateAcceptance, type Acceptance } from '../verification/index.ts';

const id = z.string().min(1).max(256),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const submission = z
  .object({
    id: id.optional(),
    projectId: id,
    prompt: z.string().min(1).max(128000),
    route: z.object({ mode: z.enum(['auto', 'explicit']), agentId: id.optional(), model: id.optional() }),
    inputRefs: z.array(hash).max(32).optional(),
    parentId: id.optional(),
    dependencyIds: z.array(id).max(32).optional(),
    maxAttempts: z.number().int().min(1).max(3).optional(),
    maxRuntimeMs: z.number().int().min(1000).max(1800000).optional(),
    deadline: z.number().int().positive().optional(),
    notBefore: z.number().int().nonnegative().optional(),
    allowPaidApi: z.boolean().optional(),
    maxEstimatedUsd: z.number().finite().nonnegative().max(100).optional(),
    decisionBudgetUsd: z.number().finite().nonnegative().max(0.05).optional(),
    modeId: id.optional(),
    acceptance: z
      .unknown()
      .transform((value, ctx) => {
        try {
          return validateAcceptance(value as Acceptance);
        } catch (error) {
          ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid acceptance' });
          return z.NEVER;
        }
      })
      .optional(),
    context: z
      .object({
        revision: id,
        paths: z.array(z.string().max(4096)).max(16).optional(),
        memoryQuery: z.string().max(2000).optional(),
      })
      .optional(),
    schedule: z.unknown().optional(),
  })
  .strict();
type Options = {
  config: ReturnType<typeof configuration>;
  hub: Hub;
  keys: Keys;
  table: () => Cli[];
  signedIn: (cli: string) => Promise<boolean | null>;
  authEnv: Record<string, string>;
  providerSnapshot?: () => Promise<{ profiles: Profile[]; table: Cli[] }>;
};
export class Application {
  readonly tasks: TaskStore;
  readonly context: ContextStore;
  readonly projects: Projects;
  readonly routing: Routing;
  readonly engine: Engine;
  readonly delegation: Delegation;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    const { config, keys, hub } = options;
    if (config.delegation && config.maxTurns < 2) throw Error('RUNNER_DELEGATION needs RUNNER_MAX_TURNS >= 2');
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    this.tasks = new TaskStore(join(config.stateDir, 'tasks.sqlite'));
    this.context = new ContextStore({ dbPath: join(config.stateDir, 'context.sqlite') });
    this.projects = new Projects(join(config.stateDir, 'projects.json'), config.cwd);
    if (!this.projects.list().some((p) => p.id === 'home'))
      this.projects.put({ id: 'home', root: config.cwd, revision: 'unversioned' });
    for (const p of this.projects.list()) this.context.setProjectRevision(p.id, p.revision);
    this.routing = new Routing({
      stateDir: config.stateDir,
      dynamic: config.dynamicRouting,
      defaultRouteId: config.defaultRoute ?? DEFAULT_AUTO_PROFILE,
      autoFallback: config.defaultRoute === undefined,
      openRouterKey: () => keys.key('openrouter'),
      decisionClient: (key) => new OpenRouter({ apiKey: key, retryConfig: { strategy: 'none' } }),
      availability: async () => {
        const snapshot = await options.providerSnapshot?.();
        return { checkedAt: new Date().toISOString(), bindings: await this.bindings(snapshot) };
      },
    });
    this.delegation = new Delegation({
      tasks: this.tasks,
      context: this.context,
      engine: () => this.engine,
      enabled: config.delegation,
      memoryEnabled: config.memory,
      url: () => `http://127.0.0.1:${config.port}`,
    });
    this.engine = new Engine({
      tasks: this.tasks,
      context: this.context,
      hub,
      routing: this.routing,
      projectRoot: (id) => this.projects.get(id).root,
      delegateServer: (task) => this.delegation.server(task),
      memoryEnabled: config.memory,
      modelIsConfigured: (cli, model) => options.table().some((c) => c.name === cli && c.profile?.model === model),
      beforeDispatch: (task, input, route) => {
        if (input.schedule === undefined) return;
        if (!config.deferred) throw Error('deferred scheduling disabled before dispatch');
        const policy = input.schedule as OffpeakPolicy,
          c = options.table().find((c) => c.name === route.cli);
        if (
          policy.pricingSchedule &&
          (policy.target?.provider !== c?.profile?.provider || policy.target?.model !== route.model)
        )
          throw Error('pricing quote does not match selected route');
        const check = nextEligible({ now: Date.now(), deadline: task.deadline, enabled: config.deferred, policy });
        if (check.status === 'blocked' || Date.parse(check.notBefore) > Date.now() + 1000)
          throw Error('scheduling window missed; reschedule the task');
        if (policy.pricingSchedule && check.discount.status !== 'known')
          throw Error('pricing evidence expired before dispatch');
      },
    });
    if (config.orchestrator) this.engine.start();
  }
  private async bindings(snapshot?: { profiles: Profile[]; table: Cli[] }): Promise<Binding[]> {
    const profiles = snapshot?.profiles ?? this.options.keys.profiles();
    return Promise.all(
      (snapshot?.table ?? this.options.table()).map(async (c) => {
        const p = profiles.find((p) => p.name === c.name),
          provider = p && PROVIDERS.find((q) => q.id === p.provider);
        const apiNames: Record<string, string[]> = {
          claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
          codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
          cursor: ['CURSOR_API_KEY'],
          grok: ['XAI_API_KEY'],
          vibe: ['MISTRAL_API_KEY'],
          gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
        };
        const hasApiKey = (apiNames[c.name] ?? c.apiKeys ?? []).some((n) =>
          Boolean(c.env && n in c.env ? c.env[n] : this.options.authEnv[n]),
        );
        const billing = p
          ? provider?.billing === 'plan'
            ? 'subscription'
            : 'use'
          : hasApiKey || c.apiKeys
            ? 'use'
            : ['claude', 'codex'].includes(c.name)
              ? c.status && (await commandBilling(c.status, this.options.authEnv)) === 'subscription'
                ? 'subscription'
                : 'use'
              : 'subscription';
        return {
          id: c.name,
          cli: c.name,
          harness: p?.harness ?? c.name,
          provider: p?.provider ?? c.name,
          billing,
          signedIn: await this.options.signedIn(c.name),
          compatibility: 'verified',
          model: p?.model,
          canonical: p?.autoEligible ? p.canonical : undefined,
          quotaBlocked: Boolean(this.options.hub.limits()[c.name]),
          tools: true,
          modalities: ['text'],
        } satisfies Binding;
      }),
    );
  }
  private submit(raw: unknown): { task: ReturnType<Engine['submit']>; schedule?: unknown } {
    const value = submission.parse(raw),
      { schedule, ...input } = value;
    this.projects.get(input.projectId);
    if (input.context && !this.options.config.memory && input.context.memoryQuery)
      throw Error('memory recall disabled');
    let admission;
    if (schedule !== undefined) {
      if (!this.options.config.deferred) throw Error('deferred scheduling disabled');
      admission = nextEligible({
        now: Date.now(),
        deadline: input.deadline ?? null,
        enabled: this.options.config.deferred,
        policy: schedule as OffpeakPolicy,
      });
      if (admission.status === 'blocked') throw Error(admission.reason);
      input.notBefore = Math.max(input.notBefore ?? 0, Date.parse(admission.notBefore));
    }
    return {
      task: this.engine.submit({ ...input, ...(schedule !== undefined ? { schedule } : {}) } as EngineSubmission),
      schedule: admission,
    };
  }
  async http(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: () => Promise<Record<string, unknown>>,
  ): Promise<boolean> {
    const parts = url.pathname.split('/').filter(Boolean),
      method = req.method;
    if (!['projects', 'tasks', 'artifacts', 'context', 'memories', 'messages', 'features'].includes(parts[0] ?? ''))
      return false;
    const reply = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
      return true;
    };
    try {
      if (url.pathname === '/features' && method === 'GET')
        return reply(200, {
          orchestrator: true,
          dynamicRouting: this.options.config.dynamicRouting,
          delegation: this.options.config.delegation,
          memory: this.options.config.memory,
          concurrency: { coordinators: 1, children: 1, maxDepth: 1 },
          costs: 'CLI execution cost is unknown; estimates are admission guards, not hard caps',
        });
      if (url.pathname === '/projects' && method === 'GET') return reply(200, { projects: this.projects.list() });
      if (parts[0] === 'projects' && parts.length === 2 && method === 'PUT') {
        const b = z
          .object({ root: z.string(), revision: id })
          .strict()
          .parse(await body());
        if (
          ['queued', 'running'].some(
            (status) =>
              this.tasks.listTasks({ projectId: parts[1], status: status as 'queued' | 'running', limit: 1 }).length,
          )
        )
          throw Error('project revision is busy');
        const p = this.projects.put({ id: parts[1]!, ...b });
        this.context.setProjectRevision(p.id, p.revision);
        return reply(200, p);
      }
      if (url.pathname === '/tasks' && method === 'POST') return reply(202, this.submit(await body()));
      if (url.pathname === '/tasks/batch' && method === 'POST') {
        const b = z
          .object({
            tasks: z
              .array(submission.omit({ schedule: true }))
              .min(1)
              .max(100),
          })
          .strict()
          .parse(await body());
        for (const t of b.tasks) {
          this.projects.get(t.projectId);
          if (t.context?.memoryQuery && !this.options.config.memory) throw Error('memory recall disabled');
        }
        return reply(202, { tasks: this.engine.submitBatch(b.tasks as EngineSubmission[]) });
      }
      if (url.pathname === '/tasks' && method === 'GET')
        return reply(200, {
          tasks: this.tasks.listTasks({ projectId: url.searchParams.get('projectId') ?? undefined, limit: 100 }),
        });
      if (parts[0] === 'tasks' && parts[1]) {
        const task = this.tasks.getTask(parts[1]);
        if (!task) return reply(404, { error: 'unknown task' });
        if (parts.length === 2 && method === 'GET') return reply(200, task);
        if (parts[2] === 'cancel' && method === 'POST') return reply(200, this.engine.cancel(task.id));
        if (parts[2] === 'retry' && method === 'POST') {
          const retried = this.tasks.retryTask(task.id);
          return reply(retried ? 202 : 409, retried ?? { error: 'task cannot retry' });
        }
        if (parts[2] === 'permissions' && parts.length === 3 && method === 'GET')
          return reply(200, { permissions: this.engine.pendingPermissions(task.projectId, task.id) });
        if (parts[2] === 'permissions' && parts[3] && method === 'POST') {
          const b = z
            .object({ optionId: id })
            .strict()
            .parse(await body());
          return reply(this.engine.answerPermission(task.projectId, task.id, parts[3], b.optionId) ? 200 : 409, {
            taskId: task.id,
          });
        }
      }
      if (parts[0] === 'artifacts' && parts.length === 3 && method === 'GET') {
        this.projects.get(parts[1]!);
        hash.parse(parts[2]);
        const a = this.context.readArtifact({ project: parts[1]!, id: parts[2]! });
        return reply(
          a ? 200 : 404,
          a ? { ...a, content: a.content.toString('utf8'), trust: 'untrusted' } : { error: 'artifact not found' },
        );
      }
      if (parts[0] === 'artifacts' && parts.length === 2 && method === 'POST') {
        this.projects.get(parts[1]!);
        const b = z
          .object({ content: z.string().max(128000) })
          .strict()
          .parse(await body());
        return reply(201, this.context.putArtifact({ project: parts[1]!, content: b.content }));
      }
      if (url.pathname === '/context/source' && method === 'PUT') {
        const b = z
          .object({ project: id, revision: id, path: z.string().max(4096), content: z.string().max(128000) })
          .strict()
          .parse(await body());
        this.projects.get(b.project);
        return reply(200, this.context.putSource(b));
      }
      if (url.pathname === '/memories' && method === 'PUT') {
        if (!this.options.config.memory) throw Error('memory disabled');
        const b = z
          .object({
            project: id,
            key: id,
            text: z.string().max(4096),
            source: z.object({ path: z.string(), hash, revision: id }),
            expiresAt: z.number().positive().optional(),
          })
          .strict()
          .parse(await body());
        this.projects.get(b.project);
        return reply(200, this.context.putMemory(b));
      }
      if (url.pathname === '/memories' && method === 'GET') {
        if (!this.options.config.memory) throw Error('memory disabled');
        const project = id.parse(url.searchParams.get('projectId')),
          query = z
            .string()
            .max(2000)
            .parse(url.searchParams.get('query') ?? '');
        this.projects.get(project);
        return reply(200, { memories: this.context.searchMemories({ project, query }) });
      }
      if (parts[0] === 'memories' && parts.length === 3 && method === 'DELETE') {
        if (!this.options.config.memory) throw Error('memory disabled');
        this.projects.get(parts[1]!);
        return reply(200, { deleted: this.context.deleteMemory({ project: parts[1]!, key: parts[2]! }) });
      }
      if (url.pathname === '/messages' && method === 'POST') {
        const b = z
          .object({
            projectId: id,
            taskId: id.optional(),
            recipient: id,
            text: z.string().max(8192),
            idempotencyKey: id,
          })
          .strict()
          .parse(await body());
        this.projects.get(b.projectId);
        return reply(201, this.tasks.sendMessage({ ...b, sender: 'user' }));
      }
      if (url.pathname === '/messages' && method === 'GET') {
        const projectId = id.parse(url.searchParams.get('projectId'));
        this.projects.get(projectId);
        return reply(200, {
          messages: this.tasks.listMessages({
            projectId,
            recipient: url.searchParams.get('recipient') ?? undefined,
            limit: 100,
          }),
        });
      }
      return reply(404, { error: 'unknown application route' });
    } catch (error) {
      return reply(400, {
        error:
          error instanceof z.ZodError ? 'invalid request' : error instanceof Error ? error.message : 'invalid request',
      });
    }
  }
  async stop(): Promise<void> {
    await this.engine.stop();
    this.tasks.close();
    this.context.close();
  }
}
