import { providerInstanceId, digest, canonicalJson, isThreadIdentifier, projectSource, launchProject } from './allocations.mjs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createOwnerAuth, equalKey } from './cloud-auth.mjs';
import { cloudProxy } from './cloud-proxy.mjs';
import { managerPage } from './manager-ui.mjs';
import { CLAUDE_CLOUD_ENABLED } from './claude-runtime.mjs';

const privateHeaders = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
};
function json(res, status, body, extra = {}) {
  res.writeHead(status, { ...privateHeaders, 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}
async function body(req) {
  if (!(req.headers['content-type'] ?? '').split(';')[0].trim().match(/^application\/json$/i)) throw Error('Invalid request');
  let size = 0, text = '';
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw Error('Invalid request'); text += chunk; }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid request');
  return value;
}
const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const denySocket = socket => { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); };

/** Central connection management only. Native T3 retains its own authentication and paths. */
export function createCloudManager({ role, publicOrigin, ownerKey, ownerId, allocator, broker,
  connections, allocatorToken, admittedProviders = ['codex'], t3Target = 'http://127.0.0.1:3773', terminalTarget = 'http://127.0.0.1:7681', bridgeUpgrade, briqMcpRequest, ready = () => true }) {
  if (!['central', 'standalone'].includes(role)) throw Error('Manager requires central or standalone role');
  if (role === 'central' && (!id(ownerId) || typeof allocator?.allocate !== 'function' || typeof broker?.ownerRequest !== 'function'))
    throw Error('Central sandbox runtime is required');
  if (!connections) throw Error('Native connection adapters are required');
  const auth = createOwnerAuth({ key: ownerKey, origin: publicOrigin });
  const native = cloudProxy({ target: t3Target, publicOrigin: auth.origin, ownerBearer: req => auth.ownerBearer(req) });
  const terminal = cloudProxy({ target: terminalTarget, publicOrigin: auth.origin, ownerBearer: req => auth.ownerBearer(req), terminal: true });
  const ownerGeneration = digest(canonicalJson(['managed-owner-generation', ownerId, ownerKey]));
  let allocating = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, auth.origin);
      if (url.pathname === '/_cloud/briq/mcp') {
        if (role !== 'central' || !briqMcpRequest) return json(res, 404, { error: 'Unavailable' });
        return await briqMcpRequest(req, res);
      }
      if (!ready()) return json(res, 503, { error: 'Central runtime is restoring' });
      if (!url.pathname.startsWith('/_cloud/') && url.pathname !== '/_cloud') return native.http(req, res);
      // Only a non-secret capability is public; native source uses this to refuse a local fallback.
      if (url.pathname === '/_cloud/capabilities' && req.method === 'GET') return json(res, 200, { role });
      const privateBridgePath = ['/_cloud/providers/status', '/_cloud/threads/managed', '/_cloud/threads/bridge-session', '/_cloud/threads/bridge-lease', '/_cloud/projects/source', '/_cloud/projects/source-revoke', '/_cloud/projects/preparation-session', '/_cloud/projects/preparation-lease', '/_cloud/projects/preparation-revoke', '/_cloud/threads/preparation-session', '/_cloud/threads/preparation-lease', '/_cloud/threads/preparation-revoke'].includes(url.pathname);
      if (privateBridgePath) {
        const admitted = role === 'central' && req.method === 'POST' && req.socket.remoteAddress === '127.0.0.1' &&
          req.headers.origin === undefined && req.headers.cookie === undefined && !url.search &&
          typeof allocatorToken === 'string' && allocatorToken.length >= 32 && equalKey(req.headers.authorization, `Bearer ${allocatorToken}`);
        if (!admitted) return json(res, 401, { error: 'Private managed bridge unavailable' });
        const input = await body(req);
        if (url.pathname === '/_cloud/providers/status') {
          if (!only(input, ['providerInstanceId']) || !['codex', 'claudeAgent'].includes(input.providerInstanceId))
            return json(res, 400, { error: 'Invalid provider identity' });
          const provider = input.providerInstanceId;
          const available = admittedProviders.includes(provider) &&
            (provider === 'codex' || CLAUDE_CLOUD_ENABLED === true);
          let authStatus = 'unknown';
          if (available) {
            try {
              if (provider === 'codex') {
                const account = await broker.ownerRequest('account/read', { refreshToken: false });
                authStatus = account?.account ? 'authenticated' : account?.requiresOpenaiAuth === true ? 'unauthenticated' : 'unknown';
              } else {
                const authenticated = (await connections.status())?.claude?.authenticated;
                authStatus = authenticated === true ? 'authenticated' : authenticated === false ? 'unauthenticated' : 'unknown';
              }
            } catch { /* Credential lifetime and unreachable status remain unknown. */ }
          }
          return json(res, 200, { providerInstanceId: provider, available, ready: available && authStatus === 'authenticated', authStatus });
        }
        if (url.pathname === '/_cloud/projects/source-revoke') {
          if (!only(input, ['sourceId', 'allocationId']) || !id(input.sourceId) || !id(input.allocationId)) return json(res, 400, { error: 'Invalid source identity' });
          await allocator.revokeSource(ownerId, input.sourceId, input.allocationId, ownerGeneration);
          return json(res, 200, { revoked: true });
        }
        if (url.pathname === '/_cloud/projects/source') {
          if (!only(input, ['projectSource'])) return json(res, 400, { error: 'Invalid source allocation' });
          const source = projectSource(input.projectSource);
          if (allocating >= 8) return json(res, 429, { error: 'Sandbox allocation is busy' });
          allocating++;
          try { return json(res, 200, await allocator.allocateSource(ownerId, source, ownerGeneration)); } finally { allocating--; }
        }
        if (url.pathname.includes('/preparation-')) {
          const purpose = url.pathname.startsWith('/_cloud/projects/') ? 'project-source' : 'thread';
          const key = purpose === 'project-source' ? 'sourceId' : 'threadId';
          if (!only(input, [key, 'allocationId', 'sourceDigest', 'projectId', 'workspaceRoot']) || !(purpose === 'project-source' ? id(input[key]) : isThreadIdentifier(input[key])) || !id(input.allocationId) || !id(input.projectId) || typeof input.sourceDigest !== 'string' || typeof input.workspaceRoot !== 'string') return json(res, 400, { error: 'Invalid preparation identity' });
          const identity = { sourceDigest: input.sourceDigest, projectId: input.projectId, workspaceRoot: input.workspaceRoot };
          if (url.pathname.endsWith('/preparation-session')) return json(res, 200, await allocator.managedPreparationSession(ownerId, input[key], input.allocationId, ownerGeneration, purpose, identity));
          if (url.pathname.endsWith('/preparation-revoke')) {
            await allocator.revokePreparationSession(ownerId, input[key], input.allocationId, ownerGeneration, purpose, identity);
            return json(res, 200, { revoked: true });
          }
          const unregister = await allocator.openPreparationLease(ownerId, input[key], input.allocationId, ownerGeneration, purpose, identity, () => res.destroy());
          res.once('close', unregister);
          res.writeHead(200, { ...privateHeaders, 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
          res.write('event: ready\ndata: {}\n\n');
          return;
        }
        if (url.pathname === '/_cloud/threads/managed') {
          if (!only(input, ['threadId', 'providerInstanceId', 'project']) || !isThreadIdentifier(input.threadId) ||
              !['codex', 'claudeAgent'].includes(input.providerInstanceId)) return json(res, 400, { error: 'Invalid managed identity' });
          if (allocating >= 8) return json(res, 429, { error: 'Sandbox allocation is busy' });
          allocating++;
          try { return json(res, 200, await allocator.allocate(ownerId, input.threadId, input.providerInstanceId, { ownerGeneration }, ...(input.project === undefined ? [] : [launchProject(input.project)]))); }
          finally { allocating--; }
        }
        if (!only(input, ['threadId', 'allocationId']) || !isThreadIdentifier(input.threadId) || !id(input.allocationId))
          return json(res, 400, { error: 'Invalid managed identity' });
        if (url.pathname === '/_cloud/threads/bridge-session') {
          if (!allocator.managedBridgeSession) return json(res, 409, { error: 'Managed bridge unavailable' });
          return json(res, 200, await allocator.managedBridgeSession(ownerId, input.threadId, input.allocationId, ownerGeneration));
        }
        if (!allocator.openBridgeLease) return json(res, 409, { error: 'Managed bridge unavailable' });
        const unregister = await allocator.openBridgeLease(ownerId, input.threadId, input.allocationId, ownerGeneration, () => res.destroy());
        res.once('close', unregister);
        res.writeHead(200, { ...privateHeaders, 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
        res.write('event: ready\ndata: {}\n\n');
        return;
      }
      const localAllocator = role === 'central' && url.pathname === '/_cloud/threads' && req.method === 'POST' &&
        req.socket.remoteAddress === '127.0.0.1' && typeof allocatorToken === 'string' && allocatorToken.length >= 32 &&
        equalKey(req.headers.authorization, `Bearer ${allocatorToken}`);
      if (req.method === 'OPTIONS') return json(res, 403, { error: 'Cross-origin management is unavailable' });
      if (!['GET', 'HEAD'].includes(req.method) && !localAllocator && !auth.mutation(req)) return json(res, 403, { error: 'Same-origin request required' });
      if (url.pathname === '/_cloud/login' && req.method === 'POST') {
        const input = await body(req);
        if (!only(input, ['key']) || typeof input.key !== 'string') return json(res, 400, { error: 'Invalid sign-in request' });
        const cookie = auth.login(input.key);
        return cookie ? json(res, 200, { authenticated: true }, { 'set-cookie': cookie }) : json(res, 401, { error: 'Owner key not accepted' });
      }
      const authorized = localAllocator || auth.authorized(req);
      if (['/_cloud', '/_cloud/'].includes(url.pathname) && req.method === 'GET') {
        const nonce = randomBytes(18).toString('base64');
        res.writeHead(200, { ...privateHeaders, 'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` });
        return res.end(managerPage({ nonce, authorized, role }));
      }
      if (!authorized) return json(res, 401, { error: 'Open /_cloud/ and sign in with your owner key' });
      if (url.pathname === '/_cloud/logout' && req.method === 'POST') return json(res, 200, { authenticated: false }, { 'set-cookie': auth.logout(req) });
      if (url.pathname.startsWith('/_cloud/terminal/') && req.method === 'GET') return terminal.http(req, res);
      if (url.pathname === '/_cloud/connections' && req.method === 'GET') {
        let codex = { unavailable: true };
        if (role === 'central') {
          try { codex = await broker.ownerRequest('account/read', { refreshToken: false }); } catch { /* Sign-in and other owner recovery stay available. */ }
        }
        const restorations = role === 'central' && allocator.restorationIssues ? (await allocator.restorationIssues()).map(value => ({
          threadId: value.threadId, allocationId: value.allocationId, state: value.state === 'deferred' ? 'deferred' : 'reconciliation-required',
        })) : [];
        const revocations = role === 'central' && allocator.revocationIssues ? (await allocator.revocationIssues()).map(value => ({
          threadId: value.threadId, allocationId: value.allocationId, state: 'reconciliation-required',
        })) : [];
        return json(res, 200, { role, codex, ...(await connections.status()), ...(revocations.length ? { revocations } : {}), ...(restorations.length ? { restorations } : {}) });
      }
      if (url.pathname === '/_cloud/phone/children' && req.method === 'GET') {
        if (role !== 'central' || !allocator.phoneChildren) return json(res, 409, { error: 'Child phone pairing unavailable' });
        return json(res, 200, { children: await allocator.phoneChildren(ownerId) });
      }
      if (url.pathname === '/_cloud/phone/pair' && req.method === 'POST') {
        if (role !== 'central' || !allocator.pairChild) return json(res, 409, { error: 'Child phone pairing unavailable' });
        const input = await body(req);
        if (!only(input, ['threadId', 'allocationId']) || !isThreadIdentifier(input.threadId) || !id(input.allocationId))
          return json(res, 400, { error: 'Choose an existing child workspace' });
        return json(res, 200, await allocator.pairChild(ownerId, input.threadId, input.allocationId));
      }
      if (url.pathname === '/_cloud/threads' && req.method === 'POST') {
        if (role !== 'central') return json(res, 409, { error: 'Thread sandbox allocation requires a central runtime' });
        const input = await body(req);
        if (!only(input, ['threadId', 'providerInstanceId']) || !isThreadIdentifier(input.threadId) ||
          input.providerInstanceId !== undefined && !['codex', 'claudeAgent'].includes(input.providerInstanceId)) return json(res, 400, { error: 'Invalid thread identity' });
        if (allocating >= 8) return json(res, 429, { error: 'Sandbox allocation is busy' });
        allocating++;
        try { return json(res, 200, await allocator.allocate(ownerId, input.threadId, providerInstanceId(input.providerInstanceId))); }
        finally { allocating--; }
      }
      if (req.method === 'POST' && url.pathname.startsWith('/_cloud/codex/')) {
        if (role !== 'central') return json(res, 409, { error: 'Central Codex connection unavailable' });
        const input = await body(req);
        switch (url.pathname) {
          case '/_cloud/codex/login':
            if (!only(input, [])) break;
            { const result = await broker.ownerRequest('account/login/start', { type: 'chatgptDeviceCode' });
              // Only native login metadata can leave this owner endpoint.
              return json(res, 200, { type: result.type, loginId: result.loginId, verificationUrl: result.verificationUrl, userCode: result.userCode }); }
          case '/_cloud/codex/cancel':
            if (!only(input, ['loginId']) || typeof input.loginId !== 'string' || input.loginId.length > 256) break;
            await broker.ownerRequest('account/login/cancel', { loginId: input.loginId });
            return json(res, 200, { cancelled: true });
          case '/_cloud/codex/logout':
            if (!only(input, [])) break;
            await broker.ownerRequest('account/logout', {});
            return json(res, 200, { disconnected: true });
        }
        return json(res, 400, { error: 'Invalid connection operation' });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/_cloud/claude/')) {
        const input = await body(req);
        if (url.pathname === '/_cloud/claude/login' && only(input, [])) return json(res, 200, await connections.claudeLogin());
        if (url.pathname === '/_cloud/claude/input' && only(input, ['code']) && typeof input.code === 'string' && connections.claudeInput(input.code))
          return json(res, 200, { accepted: true });
        if (url.pathname === '/_cloud/claude/cancel' && only(input, [])) { connections.claudeCancel(); return json(res, 200, { cancelled: true }); }
        return json(res, 400, { error: 'Invalid connection operation' });
      }
      if (url.pathname === '/_cloud/briq/login' && req.method === 'POST') {
        const input = await body(req);
        if (!only(input, [])) return json(res, 400, { error: 'Invalid connection operation' });
        return json(res, 200, await connections.briqLogin());
      }
      if (url.pathname === '/_cloud/pair' && req.method === 'POST') {
        const input = await body(req);
        if (!only(input, [])) return json(res, 400, { error: 'Invalid pairing operation' });
        return json(res, 200, await connections.pair(auth.origin));
      }
      return json(res, 404, { error: 'Unknown management operation' });
    } catch {
      if (!res.headersSent) json(res, 503, { error: 'Connection operation unavailable; inspect the configured runtime' });
      else res.end();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.on('upgrade', (req, socket, head) => {
    let path; try { path = new URL(req.url, auth.origin).pathname; } catch { return denySocket(socket); }
    if (!ready()) return denySocket(socket);
    if (path === '/_cloud/bridge' && role === 'central' && bridgeUpgrade) return bridgeUpgrade(req, socket, head);
    if (path.startsWith('/_cloud/')) {
      if (path.startsWith('/_cloud/terminal/') && auth.authorized(req) && auth.mutation(req)) return terminal.upgrade(req, socket, head);
      return denySocket(socket);
    }
    native.upgrade(req, socket, head);
  });
  return server;
}
