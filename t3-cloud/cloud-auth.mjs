import { randomBytes, timingSafeEqual } from 'node:crypto';

export const OWNER_COOKIE = 't3_cloud_owner';
const cookieValue = req => (req.headers.cookie ?? '').split(';').map(v => v.trim())
  .find(v => v.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1);
export function equalKey(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function publicOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw Error('A trusted HTTPS public origin is required');
  return url.origin;
}
export function createOwnerAuth({ key, origin, now = Date.now }) {
  if (typeof key !== 'string' || Buffer.byteLength(key) < 32 || /[\s\x00-\x1f\x7f]/.test(key))
    throw Error('A private owner key of at least 32 bytes is required');
  origin = publicOrigin(origin);
  const sessions = new Map();
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  const cookie = (value, age) => `${OWNER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
  const expire = () => { for (const [token, deadline] of sessions) if (deadline <= now()) sessions.delete(token); };
  return {
    origin,
    mutation(req) {
      return req.headers.origin === origin && !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
    },
    authorized(req) {
      expire();
      if (equalKey(req.headers.authorization, `Bearer ${key}`)) return true;
      return sessions.has(cookieValue(req));
    },
    ownerBearer(req) { return equalKey(req.headers.authorization, `Bearer ${key}`); },
    login(value) {
      expire();
      if (!equalKey(value, key)) return null;
      if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, now() + 12 * 60 * 60 * 1000);
      return cookie(token, 12 * 60 * 60);
    },
    logout(req) { sessions.delete(cookieValue(req)); return cookie('', 0); },
  };
}
