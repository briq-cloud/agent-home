import { equalSecret, digest } from './allocations.mjs';

export const EDGE_COOKIE = 'briq_token';
export function edgeToken(value) {
  // RFC 6265 cookie-octet, with a conservative upper bound for request headers.
  if (typeof value !== 'string' || value.length < 32 || value.length > 512 || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(value))
    throw Error('A private edge credential is required');
  return value;
}
export function bridgeAddress(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/_cloud/bridge')
    throw Error('A clean sandbox bridge URL is required');
  return url.href;
}
export function bridgeOptions(env) {
  const token = env.T3_CLOUD_BRIDGE_TOKEN;
  const edge = edgeToken(env.T3_CLOUD_EDGE_TOKEN);
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token) || equalSecret(token, edge)) throw Error('Missing sandbox bridge capability');
  return { url: bridgeAddress(env.T3_CLOUD_BRIDGE_URL), options: {
    headers: { authorization: `Bearer ${token}`, cookie: `${EDGE_COOKIE}=${edge}` },
    maxPayload: 2097152, perMessageDeflate: false, handshakeTimeout: 15000,
  } };
}
export function edgeAuthorized(req, expected) {
  if (typeof req.headers.cookie !== 'string') return false;
  const cookies = req.headers.cookie.split(';').map(value => value.trim()).filter(value => value.startsWith(`${EDGE_COOKIE}=`));
  return cookies.length === 1 && equalSecret(cookies[0].slice(EDGE_COOKIE.length + 1), expected);
}
export function withoutEdgeEnvironment(env) {
  const clean = { ...env };
  delete clean.T3_CLOUD_EDGE_TOKEN;
  return clean;
}
export function requireEdgeBinding(binding, token) {
  if (binding.edgeTokenHash !== digest(token)) throw Error('Edge credential changed; explicit allocation reconciliation required');
}
