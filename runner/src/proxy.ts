import { type IncomingMessage, type ServerResponse, request } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { log } from './log.ts';

/**
 * The terminal (ttyd, on localhost with `--base-path /terminal`) behind the runner's door: a
 * plain HTTP request, and the WebSocket it opens. Paths pass as they are. The runner's own key
 * and cookie never reach it.
 */
export function terminalProxy(upstream: URL) {
  const host = upstream.hostname;
  const port = Number(upstream.port || 80);
  const headers = (req: IncomingMessage) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== 'authorization') out[k] = v;
    out.cookie = withoutRunnerCookie(req.headers.cookie);
    if (!out.cookie) delete out.cookie;
    out.host = `${host}:${port}`;
    return out;
  };

  return {
    http(req: IncomingMessage, res: ServerResponse): void {
      const up = request({ host, port, method: req.method, path: req.url, headers: headers(req) }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', (err) => {
        log.warn('terminal unreachable', { err: err.message });
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('terminal unreachable');
      });
      req.pipe(up);
    },

    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      const up = connect(port, host, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [k, v] of Object.entries(headers(req))) for (const one of [v].flat()) lines.push(`${k}: ${one}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      const close = () => {
        up.destroy();
        socket.destroy();
      };
      up.on('error', close);
      socket.on('error', close);
      up.on('close', close);
      socket.on('close', close);
    },
  };
}

/** The request's cookies without the runner's own. */
function withoutRunnerCookie(cookie: string | undefined): string {
  return (cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${RUNNER_COOKIE}=`))
    .join('; ');
}

/** The cookie the sign-in page and the terminal are opened with. */
export const RUNNER_COOKIE = 'agent_home_runner';
