import { type Id, type Rpc, RpcFailure } from './agent.ts';
import { GLOBAL_CAPABILITIES, type Hub, type Peer } from './hub.ts';
import { log } from './log.ts';

/**
 * One ACP connection from an app. The runner is its agent: requests go to the hub, which
 * answers `initialize` for the CLI, follows sessions and passes everything else to the CLI as
 * it is. Requests from the CLI (a permission) come back through `ask`.
 *
 * With no CLI (`/acp`), the runner is one agent for all of them: each new session goes to the
 * CLI asked for (`_meta.agentHome.cli`) or to the hub's pick, and every later call to the CLI
 * that holds the session.
 */
export class ClientConn implements Peer {
  private readonly hub: Hub;
  private readonly cli: string | null;
  private writer: WritableStreamDefaultWriter<unknown> | undefined;
  private next = 1;
  private readonly asked = new Map<Id, { resolve(msg: Rpc): void; reject(e: Error): void }>();
  private closed = false;

  constructor(hub: Hub, cli: string | null) {
    this.hub = hub;
    this.cli = cli;
  }

  /** Runs the connection until the app closes it. */
  async run(stream: { readable: ReadableStream<unknown>; writable: WritableStream<unknown> }): Promise<void> {
    this.writer = stream.writable.getWriter();
    try {
      for await (const wire of stream.readable) for (const msg of Array.isArray(wire) ? wire : [wire]) this.receive(msg as Rpc);
    } catch (err) {
      log.info('client stream ended', { cli: this.cli, err: String(err) });
    } finally {
      this.close();
    }
  }

  send(msg: Rpc): void {
    if (this.closed) return;
    this.writer?.write(msg).catch(() => this.close());
  }

  ask(method: string, params: unknown): Promise<Rpc> {
    if (this.closed) return Promise.reject(new Error('closed'));
    const id = `runner-${this.next++}`;
    return new Promise((resolve, reject) => {
      this.asked.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private receive(msg: Rpc): void {
    const isCall = typeof msg.method === 'string';
    const hasId = msg.id !== undefined && msg.id !== null;
    if (!isCall && hasId) {
      const a = this.asked.get(msg.id as Id);
      if (a) {
        this.asked.delete(msg.id as Id);
        a.resolve(msg);
      }
    } else if (isCall && hasId) {
      const id = msg.id as Id;
      this.call(msg.method as string, msg.params).then(
        (result) => this.send({ jsonrpc: '2.0', id, result: result ?? null }),
        (err: unknown) =>
          this.send({
            jsonrpc: '2.0',
            id,
            error: err instanceof RpcFailure ? err.error : { code: -32603, message: String(err) },
          }),
      );
    } else if (isCall) {
      try {
        this.hub.notify(this.cli ?? this.hub.cliOf(msg.params?.sessionId), msg.method as string, msg.params);
      } catch {}
    }
  }

  private async call(method: string, params: Rpc['params']): Promise<unknown> {
    if (this.cli === null) return this.callAny(method, params);
    switch (method) {
      case 'initialize':
        return this.hub.initialize(this.cli);
      case 'session/new':
        return this.hub.newSession(this.cli, params, this);
      case 'session/load':
        return this.hub.loadSession(this.cli, params, this);
      case 'session/prompt':
        return this.hub.prompt(this.cli, params, this);
      default:
        return this.hub.forward(this.cli, method, params);
    }
  }

  /** `/acp`: the runner speaks for every CLI, and routes each session to one. */
  private async callAny(method: string, params: Rpc['params']): Promise<unknown> {
    if (method === 'initialize')
      return {
        protocolVersion: 1,
        agentInfo: { name: 'agent-home', title: 'Agent home', version: '0.1.0' },
        agentCapabilities: GLOBAL_CAPABILITIES,
        authMethods: [],
      };
    if (method === 'session/new') {
      const { agentHome, ...meta } = (params?._meta ?? {}) as { agentHome?: { cli?: unknown } };
      const cli = await this.hub.pick(agentHome?.cli);
      const forwarded = { ...params, ...(Object.keys(meta).length ? { _meta: meta } : { _meta: undefined }) };
      const r = (await this.hub.newSession(cli, forwarded, this)) as Record<string, unknown>;
      const own = (r._meta ?? {}) as Record<string, unknown>;
      return { ...r, _meta: { ...own, agentHome: { cli, agentCapabilities: await this.hub.capabilitiesOf(cli) } } };
    }
    if (params?.sessionId === undefined)
      throw new RpcFailure({ code: -32601, message: `${method} needs a CLI: use /acp/<cli>` });
    const cli = this.hub.cliOf(params.sessionId);
    switch (method) {
      case 'session/load':
        return this.hub.loadSession(cli, params, this);
      case 'session/prompt':
        return this.hub.prompt(cli, params, this);
      default:
        return this.hub.forward(cli, method, params);
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.detach(this);
    for (const a of this.asked.values()) a.reject(new Error('closed'));
    this.asked.clear();
    this.writer?.close().catch(() => {});
  }
}
