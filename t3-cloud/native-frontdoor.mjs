import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { cloudProxy, createNativeTransportFence } from './cloud-proxy.mjs';

export function nativeOrigin(value, primary) {
  let url;
  try { url = new URL(value); } catch { throw Error('Trusted native HTTPS origin required'); }
  if (url.protocol !== 'https:' || url.origin === primary || url.hostname === 'localhost' ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash || value !== url.origin)
    throw Error('Distinct native HTTPS origin required');
  return url.origin;
}
const shell = ['omitIdleSubagents', 'omitOlderSettled'];
const bounded = ['deferWork', 'compactTurnItems', 'dedupeBodies', 'compactIds'];
const history = ['cursor', 'throughEntryId', 'view', 'deferWork', 'compactIds'];
const ws = ['wsTicket', 'dpop', 'orchestrationProtocol', 'clientSurface', 'clientAppVersion', 'clientDeviceType',
  'clientOs', 'clientWebDeployment', 'clientBrowser', 'clientOsMajorVersion', 'clientDeviceModel', 'connectionMethod', 'clientOwner', 'clientDevice'];
const fixed = new Set(['GET /.well-known/t3/environment', 'POST /oauth/token', 'GET /api/auth/session',
  'POST /api/auth/websocket-ticket', 'POST /api/auth/websocket-ticket/rpc', 'POST /api/auth/clients/revoke', 'GET /api/projects']);

function validAuthority(host) {
  if (typeof host !== 'string' || host.length > 259) return false;
  const match = /^(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(host);
  if (!match || match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return false;
  return match[1].startsWith('[') ? isIP(match[1].slice(1, -1)) === 6 :
    match[1].split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}
export function nativeRequestAllowed(req, origin, upgrade = false) {
  const target = req.url;
  if (typeof target !== 'string' || target.length > 16384 || !/^\/(?!\/)/.test(target) ||
      /[\x00-\x20\x7f\\#]/.test(target) || /%(?![a-fA-F0-9]{2})/.test(target)) return false;
  const separator = target.indexOf('?');
  const path = separator === -1 ? target : target.slice(0, separator);
  const query = separator === -1 ? '' : target.slice(separator + 1);
  if (path.includes('//')) return false;
  try {
    for (const segment of path.split('/').slice(1)) {
      const decoded = decodeURIComponent(segment);
      if (!decoded || decoded === '.' || decoded === '..' || /[\/\\\x00-\x1f\x7f]/.test(decoded)) return false;
    }
  } catch { return false; }
  if (req.rawHeaders && req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) return false;
  const external = new URL(origin);
  // Briq preserves Host on HTTP, but its WS edge rewrites it to the delivery address.
  // Neither the upgrade Host nor caller forwarding headers choose an authority.
  if ((!upgrade && req.headers.host !== external.host) || !validAuthority(req.headers.host) || req.headers.origin !== undefined && req.headers.origin !== origin) return false;
  const thread = /^\/api\/orchestration\/threads\/[^/]+(?:\/(transcript|bounded|history))?$/.exec(path);
  let keys;
  if (upgrade) {
    if (req.method !== 'GET' || path !== '/ws') return false;
    keys = ws;
  } else if (fixed.has(`${req.method} ${path}`)) keys = [];
  else if (req.method === 'GET' && path === '/api/orchestration/shell') keys = shell;
  else if (req.method === 'GET' && thread)
    keys = thread[1] === 'bounded' ? bounded : thread[1] === 'history' ? history : [];
  else if (req.method === 'GET' && /^\/api\/assets\/[^/]+\/[^/]+$/.test(path) ||
           req.method === 'POST' && /^\/api\/attachments\/upload\/[^/]+$/.test(path)) keys = [];
  else return false;
  const params = new URLSearchParams(query ?? '');
  const seen = new Set();
  for (const key of params.keys()) {
    if (!keys.includes(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
const privateHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
export function createNativeFrontdoor({ publicOrigin, primaryOrigin, ready = () => true, target = 'http://127.0.0.1:3773', ownerBearer = () => false }) {
  const origin = nativeOrigin(publicOrigin, primaryOrigin);
  const transportFence = createNativeTransportFence();
  const proxy = cloudProxy({ target, publicOrigin: origin, ownerBearer, nativeOnly: true, transportFence });
  const server = createServer(async (req, res) => {
    const generation = transportFence.generationFor(req.socket);
    if (!nativeRequestAllowed(req, origin)) { res.writeHead(404, privateHeaders); return res.end(); }
    if (!ready()) { res.writeHead(503, privateHeaders); return res.end(); }
    if (req.method === 'POST' && !req.url.startsWith('/api/attachments/upload/')) {
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) { res.writeHead(413, privateHeaders); return res.end(); } chunks.push(chunk); }
        return proxy.http(req, res, Buffer.concat(chunks), generation);
      } catch { if (!res.headersSent) res.writeHead(400, privateHeaders); return res.end(); }
    }
    proxy.http(req, res, undefined, generation);
  });
  server.on('connection', socket => transportFence.track(socket));
  server.invalidateConnections = () => transportFence.invalidate();
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.on('upgrade', (req, socket, head) => {
    if (!ready() || !nativeRequestAllowed(req, origin, true)) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    proxy.upgrade(req, socket, head, transportFence.generationFor(socket));
  });
  return server;
}
