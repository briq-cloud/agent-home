import { digest, equalSecret } from './allocations.mjs';
import { createServer, request } from 'node:http';

// One public endpoint: native T3 keeps its auth, executor keeps its capability auth.
export function childFrontdoor({ publicOrigin, execTokenHash }) {
  const external = new URL(publicOrigin);
  if (external.protocol !== 'https:' || external.hostname === 'localhost' || external.username || external.password || external.search || external.hash || external.pathname !== '/') throw Error('Trusted child public origin required');
  const sockets = new Set();
  const headers = req => ({ ...Object.fromEntries(Object.entries(req.headers).filter(([key]) => key !== 'forwarded' && !key.startsWith('x-forwarded-'))), host: external.host });
  const server = createServer((req, res) => {
    if (req.url.startsWith('/_cloud/')) { res.writeHead(404); return res.end(); }
    const pending = request({ hostname: '127.0.0.1', port: 3773, method: req.method, path: req.url, headers: headers(req) }, reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res);
    });
    pending.setTimeout(30000, () => pending.destroy());
    pending.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => pending.destroy()); res.on('close', () => pending.destroy()); req.pipe(pending);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    const executor = req.url === '/_cloud/exec';
    if (req.url.startsWith('/_cloud/') && !executor || executor && req.headers.origin !== undefined) return socket.destroy();
    if (executor && (typeof req.headers.authorization !== 'string' || !/^Bearer [a-zA-Z0-9_-]{43}$/.test(req.headers.authorization) || !equalSecret(digest(req.headers.authorization.slice(7)), execTokenHash))) return socket.destroy();
    const upstreamHeaders = headers(req); if (executor) delete upstreamHeaders.cookie;
    const pending = request({ hostname: '127.0.0.1', port: executor ? 3774 : 3773, method: req.method,
      path: executor ? '/' : req.url, headers: upstreamHeaders });
    pending.setTimeout(10000, () => pending.destroy());
    pending.once('upgrade', (reply, upstream, upstreamHead) => {
      pending.setTimeout(0); upstream.setTimeout(0); socket.setTimeout(0);
      const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`];
      for (const [name, value] of Object.entries(reply.headers)) for (const item of [value].flat()) if (item !== undefined) lines.push(`${name}: ${item}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead); if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
      const close = () => { socket.destroy(); upstream.destroy(); };
      socket.once('error', close); socket.once('close', close); upstream.once('error', close); upstream.once('close', close);
    });
    pending.once('response', reply => { reply.resume(); socket.destroy(); });
    pending.once('error', () => socket.destroy()); socket.once('close', () => pending.destroy()); pending.end();
  });
  return { server, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
