import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RpcFailure, type Id, type Rpc } from './agent.ts';
import type { Hub, Peer } from './hub.ts';
import type { Engine, EngineSubmission, PendingPermission } from '../orchestration/engine.ts';
import type { ContextStore } from '../context/store.ts';
import type { Task, TaskStore } from '../tasks/index.ts';
import { validateAcceptance, type Acceptance } from '../verification/index.ts';

type Backend = { cli: string; id: string; cwd: string; model?: string };
type Session = {
  version: 1;
  id: string;
  projectId: string;
  lastTaskId: string | null;
  backend?: Backend;
  requestedCli?: string;
  modeId?: string;
  allowPaidApi: boolean;
  maxEstimatedUsd?: number;
  decisionBudgetUsd?: number;
  context?: EngineSubmission['context'];
  acceptance?: Acceptance;
};
export type AutoOptions = {
  engine: Pick<Engine, 'submit' | 'subscribe' | 'wait' | 'cancel' | 'pendingPermissions' | 'answerPermission'>;
  tasks: Pick<TaskStore, 'getTask'>;
  context: Pick<ContextStore, 'readArtifact'>;
  hub: Pick<Hub, 'loadSession' | 'detach'>;
  stateDir: string;
  defaultProject?: string;
};
// Connections share a home process; durable files remain the source of truth.
const observers = new Map<string, Set<(session: Session) => void>>();
type Permission = { sessionId: string; projectId: string; taskId: string; requestId: string };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const active = (task: Task): boolean => task.status === 'queued' || task.status === 'running';
function invalid(message: string): never {
  throw new RpcFailure({ code: -32602, message });
}
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > max)
    invalid(`Invalid ${name}`);
  return value;
}
function money(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`Invalid ${name}`);
  return value;
}
function acceptance(value: unknown): Acceptance | undefined {
  if (value === undefined) return undefined;
  try {
    return validateAcceptance(value as Acceptance);
  } catch (error) {
    invalid(`Invalid acceptance: ${error instanceof Error ? error.message : 'malformed checks'}`);
  }
}

/**
 * Durable virtual ACP sessions over Engine tasks. Disconnecting only drops observers;
 * explicit session/cancel stops the task. The client never supplies an execution cwd.
 * Session files contain routing/context opt-ins and checkpoint references, never keys.
 */
export class AutoConn {
  private readonly options: AutoOptions;
  private readonly directory: string;
  private writer?: WritableStreamDefaultWriter<unknown>;
  private closed = false;
  private nextPermission = 1;
  private readonly following = new Map<string, () => void>();
  private readonly watching = new Map<string, () => void>();
  private readonly permissions = new Map<Id, Permission>();
  private readonly permissionIds = new Map<string, Id>();
  constructor(options: AutoOptions) {
    this.options = options;
    this.directory = join(options.stateDir, 'auto');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  async run(stream: { readable: ReadableStream<unknown>; writable: WritableStream<unknown> }): Promise<void> {
    this.writer = stream.writable.getWriter();
    try {
      for await (const wire of stream.readable) {
        if (Array.isArray(wire)) {
          if (!wire.length || wire.length > 100)
            this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request batch' } });
          else for (const value of wire) this.receive(value);
        } else this.receive(wire);
      }
    } catch {
      /* Transport closure does not cancel durable execution. */
    } finally {
      this.close();
    }
  }
  private send(rpc: Rpc): void {
    if (!this.closed) this.writer?.write(rpc).catch(() => this.close());
  }
  private receive(value: unknown): void {
    const msg = object(value),
      hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
    if (msg.jsonrpc !== '2.0') {
      this.send({
        jsonrpc: '2.0',
        id: hasId ? (msg.id as Id) : null,
        error: { code: -32600, message: 'Invalid JSON-RPC request' },
      });
      return;
    }
    if (typeof msg.method !== 'string') {
      if (hasId) this.answer(msg.id as Id, msg.result);
      return;
    }
    const call = this.call(msg.method, msg.params);
    if (hasId)
      call.then(
        (result) => this.send({ jsonrpc: '2.0', id: msg.id as Id, result }),
        (error) =>
          this.send({
            jsonrpc: '2.0',
            id: msg.id as Id,
            error:
              error instanceof RpcFailure
                ? error.error
                : { code: -32603, message: error instanceof Error ? error.message : 'Auto request failed' },
          }),
      );
    else call.catch(() => {});
  }
  private path(id: string): string {
    if (!/^auto-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      invalid('Unknown Auto session');
    return join(this.directory, `${id}.json`);
  }
  private read(id: unknown): Session {
    const sessionId = text(id, 'sessionId');
    try {
      const value = object(JSON.parse(readFileSync(this.path(sessionId), 'utf8')));
      if (
        value.version !== 1 ||
        value.id !== sessionId ||
        typeof value.projectId !== 'string' ||
        (value.lastTaskId !== null && typeof value.lastTaskId !== 'string') ||
        typeof value.allowPaidApi !== 'boolean'
      )
        throw Error('invalid session file');
      if (value.requestedCli !== undefined) text(value.requestedCli, 'requested CLI');
      if (value.modeId !== undefined) text(value.modeId, 'modeId');
      if (value.acceptance !== undefined) value.acceptance = acceptance(value.acceptance);
      return value as Session;
    } catch (error) {
      if (error instanceof RpcFailure) throw error;
      throw new RpcFailure({ code: -32602, message: 'Unknown or invalid Auto session' });
    }
  }
  private save(session: Session): void {
    const path = this.path(session.id),
      temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  private task(session: Session): Task | undefined {
    if (!session.lastTaskId) return undefined;
    const task = this.options.tasks.getTask(session.lastTaskId);
    if (!task || task.projectId !== session.projectId)
      throw new RpcFailure({ code: -32001, message: 'Auto task is unavailable in its project' });
    return task;
  }
  private artifact(project: string, id: string): Record<string, unknown> {
    const value = this.options.context.readArtifact({ project, id, maxBytes: 128_000 });
    if (!value) throw new RpcFailure({ code: -32001, message: 'Auto checkpoint artifact is unavailable' });
    return object(JSON.parse(value.content.toString('utf8')));
  }
  private backend(session: Session, task?: Task): Backend | undefined {
    if (!task?.sessionRef) return session.backend;
    const ref = this.artifact(session.projectId, task.sessionRef),
      route = object(ref.route);
    return {
      cli: text(ref.cli, 'checkpoint CLI'),
      id: text(ref.id, 'checkpoint session'),
      cwd: text(ref.cwd, 'checkpoint cwd', 4096),
      ...(typeof route.model === 'string' ? { model: route.model } : {}),
    };
  }
  private remap(rpc: Rpc, id: string): Rpc {
    if (!rpc.params || typeof rpc.params !== 'object' || Array.isArray(rpc.params)) return rpc;
    return { ...rpc, params: { ...rpc.params, ...(rpc.params.sessionId !== undefined ? { sessionId: id } : {}) } };
  }
  private emitTask(session: Session, task: Task): void {
    this.send({ jsonrpc: '2.0', method: '_runner/task', params: { ...task, sessionId: session.id } });
  }
  private forward(session: Session, taskId: string, rpc: Rpc): void {
    if (rpc.method === 'session/request_permission' && rpc.id !== undefined && rpc.id !== null) {
      this.permission(session, {
        projectId: session.projectId,
        taskId,
        requestId: String(rpc.id),
        method: 'session/request_permission',
        params: rpc.params,
        createdAt: Date.now(),
      });
    } else if (rpc.method)
      this.send(
        rpc.method === '_runner/task'
          ? { ...rpc, params: { ...object(rpc.params), sessionId: session.id } }
          : this.remap(rpc, session.id),
      );
  }
  private permission(session: Session, pending: PendingPermission): void {
    if (this.closed || pending.projectId !== session.projectId || pending.taskId !== session.lastTaskId) return;
    const key = `${session.id}:${pending.taskId}:${pending.requestId}`;
    if (this.permissionIds.has(key)) return;
    const id = `auto-permission-${this.nextPermission++}`;
    this.permissionIds.set(key, id);
    this.permissions.set(id, {
      sessionId: session.id,
      projectId: session.projectId,
      taskId: pending.taskId,
      requestId: pending.requestId,
    });
    this.send(
      this.remap({ jsonrpc: '2.0', id, method: 'session/request_permission', params: pending.params }, session.id),
    );
  }
  private answer(id: Id, result: unknown): void {
    const permission = this.permissions.get(id);
    if (!permission) return;
    const outcome = object(object(result).outcome);
    if (outcome.outcome === 'cancelled') {
      // ACP cancellation is an explicit denial. Stop conservatively rather than
      // leave a CLI permission unresolved or invent an option selection.
      this.clearPermission(id, permission);
      this.options.engine.cancel(permission.taskId);
      return;
    }
    if (outcome.outcome !== 'selected' || typeof outcome.optionId !== 'string') {
      // Malformed input is not authority to grant or cancel anything.
      this.clearPermission(id, permission);
      return;
    }
    const accepted = this.options.engine.answerPermission(
      permission.projectId,
      permission.taskId,
      permission.requestId,
      outcome.optionId,
    );
    this.clearPermission(id, permission);
    if (!accepted)
      this.send({
        jsonrpc: '2.0',
        method: '_runner/permission_rejected',
        params: {
          sessionId: permission.sessionId,
          taskId: permission.taskId,
          requestId: permission.requestId,
          reason: 'Permission is stale or option is invalid',
        },
      });
  }
  private clearPermission(id: Id, permission: Permission): void {
    this.permissions.delete(id);
    this.permissionIds.delete(`${permission.sessionId}:${permission.taskId}:${permission.requestId}`);
  }
  private follow(session: Session): void {
    if (!this.closed && !this.watching.has(session.id)) {
      const key = join(this.directory, session.id);
      let set = observers.get(key);
      if (!set) observers.set(key, (set = new Set()));
      const refresh = (updated: Session) => this.attach(updated);
      set.add(refresh);
      this.watching.set(session.id, () => {
        set!.delete(refresh);
        if (!set!.size) observers.delete(key);
      });
    }
    this.attach(session);
  }
  private publish(session: Session): void {
    for (const refresh of [...(observers.get(join(this.directory, session.id)) ?? [])]) refresh(session);
  }
  private attach(session: Session): void {
    this.following.get(session.id)?.();
    this.following.delete(session.id);
    for (const [id, p] of this.permissions) if (p.sessionId === session.id) this.clearPermission(id, p);
    if (this.closed || !session.lastTaskId) return;
    this.following.set(
      session.id,
      this.options.engine.subscribe(session.lastTaskId, (rpc) => this.forward(session, session.lastTaskId!, rpc)),
    );
    for (const p of this.options.engine.pendingPermissions(session.projectId, session.lastTaskId))
      this.permission(session, p);
  }
  private async call(method: string, raw: unknown): Promise<unknown> {
    const params = object(raw);
    if (method === 'initialize')
      return {
        protocolVersion: 1,
        agentInfo: { name: 'agent-home-auto', title: 'Agent home Auto', version: '0.1.0' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [],
      };
    if (method === 'session/new') {
      const opts = object(object(params._meta).agentHome);
      if (opts.allowPaidApi !== undefined && typeof opts.allowPaidApi !== 'boolean') invalid('Invalid allowPaidApi');
      let context: EngineSubmission['context'];
      if (opts.context !== undefined) {
        const input = object(opts.context);
        const revision = text(input.revision, 'context revision');
        if (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.length > 32))
          invalid('Invalid context paths');
        const paths =
          input.paths === undefined ? undefined : (input.paths as unknown[]).map((p) => text(p, 'context path', 4096));
        context = {
          revision,
          paths,
          ...(input.memoryQuery === undefined ? {} : { memoryQuery: text(input.memoryQuery, 'memory query', 2048) }),
        };
      }
      const session: Session = {
        version: 1,
        id: `auto-${randomUUID()}`,
        projectId: text(opts.projectId ?? this.options.defaultProject ?? 'home', 'projectId'),
        lastTaskId: null,
        requestedCli: opts.cli === undefined ? undefined : text(opts.cli, 'requested CLI'),
        modeId: opts.modeId === undefined ? undefined : text(opts.modeId, 'modeId'),
        allowPaidApi: opts.allowPaidApi === true,
        maxEstimatedUsd: money(opts.maxEstimatedUsd, 'maxEstimatedUsd'),
        decisionBudgetUsd: money(opts.decisionBudgetUsd, 'decisionBudgetUsd'),
        context,
        acceptance: acceptance(opts.acceptance),
      };
      // No route, CLI process, model call or client cwd is consumed at creation.
      this.save(session);
      return {
        sessionId: session.id,
        _meta: { agentHome: { projectId: session.projectId, durable: true, allowPaidApi: session.allowPaidApi } },
      };
    }
    if (!['session/load', 'session/prompt', 'session/cancel'].includes(method))
      throw new RpcFailure({ code: -32601, message: `Auto does not support ${method}` });
    const session = this.read(params.sessionId),
      task = this.task(session);
    if (method === 'session/cancel') {
      if (task && active(task)) this.options.engine.cancel(task.id);
      return {};
    }
    if (method === 'session/load') {
      const backend = this.backend(session, task);
      if (backend) {
        const peer: Peer = {
          send: (rpc) => {
            if (rpc.method) this.send(this.remap(rpc, session.id));
          },
          ask: async () => {
            throw new Error('Auto history replay cannot answer backend requests');
          },
        };
        try {
          await this.options.hub.loadSession(
            backend.cli,
            { sessionId: backend.id, cwd: backend.cwd, mcpServers: [] },
            peer,
          );
          // Attach live before detaching replay: there is no asynchronous observation gap.
          this.follow(this.read(session.id));
        } finally {
          this.options.hub.detach(peer);
        }
      } else this.follow(this.read(session.id));
      const currentSession = this.read(session.id),
        current = this.task(currentSession);
      if (current) this.emitTask(currentSession, current);
      return {
        _meta: {
          agentHome: {
            projectId: session.projectId,
            taskId: currentSession.lastTaskId,
            durable: true,
            allowPaidApi: session.allowPaidApi,
          },
        },
      };
    }
    if (task && active(task))
      throw new RpcFailure({ code: -32000, message: 'Auto session already has an active task' });
    if (!Array.isArray(params.prompt) || !params.prompt.length || params.prompt.length > 128)
      invalid('Auto requires a nonempty text prompt');
    const prompt = params.prompt
      .map((item) => {
        const content = object(item);
        if (content.type !== 'text') invalid('Auto supports text prompts only');
        if (typeof content.text !== 'string') invalid('Invalid prompt text');
        return content.text;
      })
      .join('\n');
    text(prompt, 'prompt', 128_000);
    const backend = this.backend(session, task);
    const next: Session = { ...session, backend, lastTaskId: `auto-task-${randomUUID()}` };
    // Reserve synchronously before Engine work or any await; all connections see it.
    // A missing reserved task after a crash fails closed rather than double-dispatching.
    this.save(next);
    let submitted: Task;
    try {
      submitted = this.options.engine.submit({
        id: next.lastTaskId!,
        projectId: session.projectId,
        prompt,
        route: backend
          ? { mode: 'explicit', agentId: backend.cli, model: backend.model }
          : session.requestedCli
            ? { mode: 'explicit', agentId: session.requestedCli }
            : { mode: 'auto' },
        ...(backend ? { session: { cli: backend.cli, id: backend.id, cwd: backend.cwd } } : {}),
        context: session.context,
        modeId: session.modeId,
        allowPaidApi: session.allowPaidApi,
        maxEstimatedUsd: session.maxEstimatedUsd,
        decisionBudgetUsd: session.decisionBudgetUsd,
        acceptance: session.acceptance,
      });
    } catch (error) {
      this.save(session);
      throw error;
    }
    this.follow(next);
    this.publish(next);
    this.emitTask(next, submitted);
    const terminal = await this.options.engine.wait(submitted.id);
    const stored = this.read(next.id);
    if (stored.lastTaskId === submitted.id) this.save({ ...stored, backend: this.backend(stored, terminal) });
    if (terminal.status === 'succeeded') {
      const output = terminal.outputRef ? this.artifact(session.projectId, terminal.outputRef) : {};
      return {
        stopReason: typeof output.stopReason === 'string' ? output.stopReason : 'end_turn',
        _meta: { agentHome: { taskId: terminal.id, status: terminal.status } },
      };
    }
    if (terminal.status === 'cancelled')
      return { stopReason: 'cancelled', _meta: { agentHome: { taskId: terminal.id, status: terminal.status } } };
    throw new RpcFailure({
      code: -32001,
      message: `Auto task ${terminal.status}`,
      data: { taskId: terminal.id, status: terminal.status },
    });
  }
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.following.values()) unsubscribe();
    this.following.clear();
    for (const unwatch of this.watching.values()) unwatch();
    this.watching.clear();
    this.permissions.clear();
    this.permissionIds.clear();
    this.writer?.close().catch(() => {});
  }
}
