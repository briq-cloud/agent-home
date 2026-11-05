import { request } from 'node:http';
import { OWNER_COOKIE } from './cloud-auth.mjs';

export function cloudProxy({ target, publicOrigin, ownerBearer, terminal = false }) {
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('Upstream must be a loopback HTTP origin');
  const port = Number(url.port || 80);
  const external = new URL(publicOrigin);
  function headers(req) {
    const out = { ...req.headers };
    if (terminal || ownerBearer(req)) delete out.authorization;
    const value = (req.headers.cookie ?? '').split(';').map(v => v.trim())
      .filter(v => v && !v.startsWith(`${OWNER_COOKIE}=`)).join('; ');
    if (value) out.cookie = value; else delete out.cookie;
    // Never derive native origin checks from client-controlled proxy headers.
    out.host = external.host;
    for (const key of Object.keys(out)) if (key === 'forwarded' || key.startsWith('x-forwarded-')) delete out[key];
    return out;
  }
  return {
    http(req, res) {
      const upstream = request({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers: headers(req) }, reply => {
        const out = { ...reply.headers };
        // An upstream cannot mint or replace the manager's owner session.
        if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].filter(v => !v.trim().startsWith(`${OWNER_COOKIE}=`));
        if (terminal) Object.assign(out, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
        res.writeHead(reply.statusCode ?? 502, out); reply.pipe(res);
      });
      upstream.setTimeout(30000, () => upstream.destroy());
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Native service unavailable'); });
      req.pipe(upstream);
    },
    upgrade(req, socket, head) {
      const pending = request({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers: headers(req) });
      pending.setTimeout(10000, () => pending.destroy());
      pending.once('upgrade', (reply, upstream, upstreamHead) => {
        const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`];
        for (const [name, value] of Object.entries(reply.headers)) {
          if (value === undefined) continue;
          for (const item of [value].flat()) {
            if (name === 'set-cookie' && item.trim().startsWith(`${OWNER_COOKIE}=`)) continue;
            lines.push(`${name}: ${item}`);
          }
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
        const close = () => { upstream.destroy(); socket.destroy(); };
        upstream.once('error', close); socket.once('error', close);
        upstream.once('close', close); socket.once('close', close);
      });
      pending.once('response', reply => { reply.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
      pending.once('error', () => socket.destroy());
      socket.once('close', () => pending.destroy());
      pending.end();
    },
  };
}
