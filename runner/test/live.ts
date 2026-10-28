import WebSocket from 'ws';

/**
 * Against a running runner and real CLIs (not part of `npm test`): one session per CLI named on
 * the command line, a turn that uses tools (each permission allowed), then a second turn that the
 * client leaves after its first event and follows again with `session/load`.
 *
 *   RUNNER_URL=ws://127.0.0.1:8090 RUNNER_TOKEN=… node test/live.ts claude codex
 */
type Msg = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: any; result?: any; error?: any };

const base = process.env.RUNNER_URL ?? 'ws://127.0.0.1:8090';
const token = process.env.RUNNER_TOKEN ?? '';
const cwd = process.env.LIVE_CWD ?? '/work/runner-live';

class App {
  readonly got: Msg[] = [];
  private readonly ws: WebSocket;
  private next = 1;
  private readonly waiting = new Map<string | number, (m: Msg) => void>();
  private readonly watchers = new Set<() => void>();

  constructor(cli: string) {
    this.ws = new WebSocket(`${base}/acp/${cli}`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as Msg;
      if (m.method === undefined && m.id !== undefined) this.waiting.get(m.id)?.(m);
      else {
        this.got.push(m);
        // Every permission, allowed: the first option that allows.
        if (m.method === 'session/request_permission') {
          const option = m.params.options.find((o: any) => o.kind.startsWith('allow')) ?? m.params.options[0];
          this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } }));
        }
      }
      for (const w of this.watchers) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  request(method: string, params: unknown): Promise<Msg> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  until(match: (m: Msg) => boolean, ms = 240_000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), ms);
      const check = () => {
        const m = this.got.find(match);
        if (m) {
          clearTimeout(timer);
          this.watchers.delete(check);
          resolve(m);
        }
      };
      this.watchers.add(check);
      check();
    });
  }

  kinds(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of this.got) {
      const k = m.method === 'session/update' ? m.params.update.sessionUpdate : (m.method as string);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }

  text(): string {
    return this.got
      .filter((m) => m.params?.update?.sessionUpdate === 'agent_message_chunk')
      .map((m) => m.params.update.content?.text ?? '')
      .join('');
  }

  close(): void {
    this.ws.close();
  }
}

async function live(cli: string): Promise<void> {
  const t0 = Date.now();
  const s = (ms: number) => `${Math.round(ms / 100) / 10}s`;
  const app = new App(cli);
  await app.open();
  const init = await app.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  if (init.error) throw new Error(`${cli} initialize: ${init.error.message}`);
  const created = await app.request('session/new', { cwd, mcpServers: [] });
  if (created.error) throw new Error(`${cli} session/new: ${created.error.message}`);
  const id = created.result.sessionId as string;
  const options = (created.result.configOptions ?? []).map((o: any) => o.id ?? o.name);
  const modes = (created.result.modes?.availableModes ?? []).map((m: any) => m.id);
  const turn1 = await app.request('session/prompt', {
    sessionId: id,
    prompt: [{ type: 'text', text: `Create a file named ${cli}.txt containing the word ${cli}, run 'wc -c ${cli}.txt' in the shell, then reply with the word done.` }],
  });
  console.log(`${cli} turn 1: ${turn1.result?.stopReason ?? turn1.error?.message} in ${s(Date.now() - t0)}`, JSON.stringify(app.kinds()));
  console.log(`${cli} modes ${JSON.stringify(modes)} config ${JSON.stringify(options)}`);

  // A second turn the client leaves after its first event, then follows again.
  const t1 = Date.now();
  void app.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'Count from 1 to 20, one number per line.' }] });
  const running = () => app.got.filter((m) => m.method === '_runner/turn' && m.params.state === 'running').length;
  await app.until(() => running() >= 2);
  app.close();
  const back = new App(cli);
  await back.open();
  await back.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const loaded = await back.request('session/load', { sessionId: id, cwd, mcpServers: [] });
  if (loaded.error) throw new Error(`${cli} session/load: ${loaded.error.message}`);
  const ends = () => back.got.filter((m) => m.method === '_runner/turn' && m.params.state === 'idle').length;
  await back.until(() => ends() >= 2);
  console.log(`${cli} turn 2, followed after a reconnect: ${s(Date.now() - t1)}, replayed and live`, JSON.stringify(back.kinds()));
  console.log(`${cli} turn 2 ends with: ${JSON.stringify(back.text().slice(-40))}`);
  back.close();
}

for (const cli of process.argv.slice(2)) {
  try {
    await live(cli);
  } catch (err) {
    console.log(`${cli} FAILED: ${(err as Error).message}`);
  }
}
process.exit(0);
