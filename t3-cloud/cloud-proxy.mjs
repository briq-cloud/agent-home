import { EDGE_COOKIE } from './edge-auth.mjs';
import { request, STATUS_CODES } from 'node:http';
import { OWNER_COOKIE } from './cloud-auth.mjs';

export function createNativeTransportFence() {
  let generation = 0;
  const resources = new Set(), generations = new WeakMap();
  return {
    current: value => value === generation,
    generationFor: resource => generations.get(resource),
    track(resource, value = generation) {
      if (value !== generation) { resource.destroy(); return false; }
      if (!resources.has(resource)) {
        resources.add(resource); generations.set(resource, value);
        resource.once('close', () => resources.delete(resource));
      }
      return true;
    },
    invalidate() {
      generation++;
      for (const resource of resources) resource.destroy();
      resources.clear();
    },
  };
}

export function cloudProxy({ target, publicOrigin, ownerBearer, terminal = false, nativeOnly = false, transportFence, requestUpstream = request }) {
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('Upstream must be a loopback HTTP origin');
  const port = Number(url.port || 80);
  const external = new URL(publicOrigin);
  function headers(req) {
    const out = nativeOnly ? Object.fromEntries(Object.entries(req.headers).filter(([key]) =>
      ['authorization', 'dpop', 'x-t3-orchestration-protocol', 'accept', 'content-type', 'content-length', 'origin', 'connection', 'upgrade',
        'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'].includes(key))) : { ...req.headers };
    if (terminal || ownerBearer(req)) delete out.authorization;
    const value = (req.headers.cookie ?? '').split(';').map(v => v.trim())
      .filter(v => v && !v.startsWith(`${OWNER_COOKIE}=`) && !v.startsWith(`${EDGE_COOKIE}=`)).join('; ');
    if (value && !nativeOnly) out.cookie = value; else delete out.cookie;
    // Never derive native origin checks from client-controlled proxy headers.
    out.host = external.host;
    for (const key of Object.keys(out)) if (key === 'forwarded' || key.startsWith('x-forwarded-')) delete out[key];
    if (nativeOnly) out['x-forwarded-proto'] = 'https';
    return out;
  }
  return {
    http(req, res, body, generation = transportFence?.generationFor(req.socket)) {
      if (transportFence && !transportFence.current(generation)) return req.socket.destroy();
      const upstream = requestUpstream({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers: headers(req) }, reply => {
        if (transportFence && !transportFence.current(generation)) { reply.destroy(); req.socket.destroy(); return; }
        const out = { ...reply.headers };
        if (nativeOnly) { delete out['set-cookie']; Object.assign(out, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }); }
        // An upstream cannot mint or replace the manager's owner session.
        if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].filter(v => !v.trim().startsWith(`${OWNER_COOKIE}=`) && !v.trim().startsWith(`${EDGE_COOKIE}=`));
        if (terminal) Object.assign(out, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
        res.writeHead(reply.statusCode ?? 502, out); reply.pipe(res);
      });
      transportFence?.track(upstream, generation);
      upstream.once('socket', socket => transportFence?.track(socket, generation));
      upstream.setTimeout(30000, () => upstream.destroy());
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      upstream.on('error', () => { if (transportFence && !transportFence.current(generation)) return res.destroy(); if (!res.headersSent) res.writeHead(502); res.end('Native service unavailable'); });
      if (body !== undefined) upstream.end(body); else req.pipe(upstream);
    },
    upgrade(req, socket, head, generation = transportFence?.generationFor(socket)) {
      if (transportFence && !transportFence.current(generation)) return socket.destroy();
      const pending = requestUpstream({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers: headers(req) });
      transportFence?.track(pending, generation);
      pending.once('socket', upstream => transportFence?.track(upstream, generation));
      pending.setTimeout(10000, () => pending.destroy());
      pending.once('upgrade', (reply, upstream, upstreamHead) => {
        if (transportFence && (!transportFence.current(generation) || !transportFence.track(upstream, generation))) {
          upstream.destroy(); socket.destroy(); pending.destroy(); return;
        }
        pending.setTimeout(0); upstream.setTimeout(0); socket.setTimeout(0);
        const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`];
        for (const [name, value] of Object.entries(reply.headers)) {
          if (value === undefined) continue;
          for (const item of [value].flat()) {
            if (name === 'set-cookie' && (nativeOnly || item.trim().startsWith(`${OWNER_COOKIE}=`) || item.trim().startsWith(`${EDGE_COOKIE}=`))) continue;
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
      pending.once('response', reply => {
        reply.resume();
        if (transportFence && !transportFence.current(generation)) return socket.destroy();
        const status = nativeOnly && Number.isInteger(reply.statusCode) && reply.statusCode >= 400 && reply.statusCode <= 599 ? reply.statusCode : 502;
        const hardening = nativeOnly ? 'Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n' : '';
        socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Rejected'}\r\n${hardening}Connection: close\r\nContent-Length: 0\r\n\r\n`);
      });
      pending.once('error', () => socket.destroy());
      socket.once('close', () => pending.destroy());
      pending.end();
    },
  };
}
