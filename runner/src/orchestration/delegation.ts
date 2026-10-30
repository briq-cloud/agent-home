import { randomBytes, randomUUID } from 'node:crypto';
import type { Task, TaskStore } from '../tasks/index.ts';
import type { ContextStore } from '../context/store.ts';
import type { Engine } from './engine.ts';

interface Capability {
  taskId: string;
  projectId: string;
  rootId: string;
  expiresAt: number;
  leaseToken: number;
  workerId: string | null;
}
interface Options {
  tasks: TaskStore;
  context: ContextStore;
  engine: () => Engine;
  url: () => string;
  enabled: boolean;
  memoryEnabled?: boolean;
}
/** Task-scoped MCP credentials. They expire with the attempt and never grant runner administration. */
export class Delegation {
  private caps = new Map<string, Capability>();
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  server(task: Task): Record<string, unknown> | undefined {
    if (!this.options.enabled) return;
    const key = randomBytes(32).toString('base64url');
    this.caps.set(key, {
      taskId: task.id,
      projectId: task.projectId,
      rootId: task.parentId ?? task.id,
      expiresAt: Math.min(task.deadline ?? Infinity, Date.now() + Math.min(task.maxRuntimeMs ?? 1_800_000, 1_800_000)),
      leaseToken: task.leaseToken,
      workerId: task.workerId,
    });
    for (const [token, cap] of this.caps) if (cap.expiresAt < Date.now()) this.caps.delete(token);
    return {
      name: 'agent-home',
      command: process.execPath,
      args: [new URL('../../bin/task-tools.ts', import.meta.url).pathname],
      env: [
        { name: 'AGENT_HOME_TASK_URL', value: this.options.url() + '/delegate' },
        { name: 'AGENT_HOME_TASK_CAP', value: key },
      ],
    };
  }
  private capability(token: string): Capability {
    const cap = this.caps.get(token),
      task = cap && this.options.tasks.getTask(cap.taskId);
    if (
      !cap ||
      cap.expiresAt <= Date.now() ||
      task?.status !== 'running' ||
      task.leaseToken !== cap.leaseToken ||
      task.workerId !== cap.workerId
    )
      throw Error('task capability expired');
    return cap;
  }
  disconnect(token: string): void {
    try {
      const cap = this.capability(token);
      this.options.engine().cancel(cap.taskId);
      this.caps.delete(token);
    } catch {}
  }
  private team(cap: Capability, id: string): Task {
    const task = this.options.tasks.getTask(id);
    if (!task || task.projectId !== cap.projectId || (task.id !== cap.rootId && task.parentId !== cap.rootId))
      throw Error('task outside delegation scope');
    return task;
  }
  async call(token: string, action: string, input: Record<string, unknown>): Promise<unknown> {
    const cap = this.capability(token),
      engine = this.options.engine(),
      tasks = this.options.tasks;
    const own = tasks.getTask(cap.taskId)!;
    if (action === 'spawn') {
      if (own.parentId) throw Error('nested delegation is disabled');
      if (tasks.countChildren(cap.projectId, own.id) >= 8) throw Error('project coordinator child limit reached');
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 64_000)
        throw Error('prompt required (max 64000 characters)');
      const deps = Array.isArray(input.dependencyIds) ? input.dependencyIds : [];
      for (const id of deps) {
        if (typeof id !== 'string') throw Error('invalid dependency');
        this.team(cap, id);
      }
      const saved = this.options.context.readArtifact({ project: cap.projectId, id: own.promptRef });
      const config = saved
        ? (JSON.parse(saved.content.toString('utf8')) as { submission: Record<string, unknown> }).submission
        : {};
      return engine.submit({
        projectId: cap.projectId,
        parentId: own.id,
        prompt: input.prompt,
        dependencyIds: deps as string[],
        route: typeof input.agentId === 'string' ? { mode: 'explicit', agentId: input.agentId } : { mode: 'auto' },
        allowPaidApi: config.allowPaidApi === true && own.maxCostMicros === null,
        maxEstimatedUsd: typeof config.maxEstimatedUsd === 'number' ? config.maxEstimatedUsd : undefined,
        decisionBudgetUsd: typeof config.decisionBudgetUsd === 'number' ? config.decisionBudgetUsd : undefined,
        maxRuntimeMs: Math.min(300_000, Math.max(1000, (own.deadline ?? Date.now() + 300_000) - Date.now())),
        deadline: own.deadline ?? undefined,
      });
    }
    if (action === 'wait') {
      if (own.parentId) throw Error('only coordinator can yield to child tasks');
      const ids = Array.isArray(input.taskIds) ? input.taskIds : [];
      if (!ids.length || ids.length > 8) throw Error('taskIds required (max 8)');
      const children = ids.map((id) => {
        if (typeof id !== 'string') throw Error('invalid task id');
        const child = this.team(cap, id);
        if (child.parentId !== own.id) throw Error('only direct children can be awaited');
        return child;
      });
      const results: Task[] = [];
      for (const child of children) results.push(await engine.wait(child.id, { parentTaskId: own.id }));
      return results;
    }
    if (action === 'status') {
      const id = typeof input.taskId === 'string' ? input.taskId : own.id;
      return this.team(cap, id);
    }
    if (action === 'result') {
      if (typeof input.taskId !== 'string') throw Error('taskId required');
      const task = this.team(cap, input.taskId);
      if (!task.outputRef) return { status: task.status, output: null };
      const out = this.options.context.readArtifact({ project: cap.projectId, id: task.outputRef, maxBytes: 64_000 });
      return { status: task.status, output: out?.content.toString('utf8'), source: task.outputRef, trust: 'untrusted' };
    }
    if (action === 'send') {
      if (typeof input.taskId !== 'string' || typeof input.text !== 'string' || input.text.length > 8192)
        throw Error('taskId and bounded text required');
      const task = this.team(cap, input.taskId);
      return tasks.sendMessage({
        projectId: cap.projectId,
        taskId: task.id,
        sender: own.id,
        recipient: task.id,
        text: input.text,
        idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : randomUUID(),
      });
    }
    if (action === 'inbox')
      return tasks.listMessages({ projectId: cap.projectId, recipient: own.id, unacknowledgedOnly: true, limit: 20 });
    if (action === 'ack') {
      if (typeof input.messageId !== 'string') throw Error('messageId required');
      return tasks.acknowledgeMessage(input.messageId, own.id);
    }
    if (action === 'recall') {
      if (this.options.memoryEnabled === false) throw Error('memory disabled');
      if (typeof input.query !== 'string' || input.query.length > 2000) throw Error('query required');
      return {
        trust: 'untrusted',
        memories: this.options.context.searchMemories({ project: cap.projectId, query: input.query, limit: 5 }),
      };
    }
    throw Error('unknown delegation action');
  }
}
