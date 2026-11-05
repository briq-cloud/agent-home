import { createServer } from 'node:http';
import { digest, equalSecret } from './allocations.mjs';
import { cloudProxy } from './cloud-proxy.mjs';

// One public endpoint: native T3 keeps its auth, executor keeps its capability auth.
export function childFrontdoor({ publicOrigin, execTokenHash }) {
  const external = new URL(publicOrigin);
  if (external.protocol !== 'https:' || external.hostname === 'localhost' || external.username || external.password || external.search || external.hash || external.pathname !== '/') throw Error('Trusted child public origin required');
  const native = cloudProxy({ target: 'http://127.0.0.1:3773', publicOrigin, ownerBearer: () => false });
  const executor = cloudProxy({ target: 'http://127.0.0.1:3774', publicOrigin, ownerBearer: () => false });
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url.startsWith('/_cloud/')) { res.writeHead(404); return res.end(); }
    native.http(req, res);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/_cloud/exec') {
      if (req.headers.origin !== undefined || typeof req.headers.authorization !== 'string' ||
        !/^Bearer [a-zA-Z0-9_-]{43}$/.test(req.headers.authorization) || !equalSecret(digest(req.headers.authorization.slice(7)), execTokenHash)) return socket.destroy();
      req.url = '/'; delete req.headers.cookie;
      return executor.upgrade(req, socket, head);
    }
    if (req.url.startsWith('/_cloud/')) return socket.destroy();
    native.upgrade(req, socket, head);
  });
  return { server, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
