import crypto from 'node:crypto';

const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function sign(payload, secret, ttlSeconds = 12 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  return `${head}.${body}.${mac(`${head}.${body}`, secret)}`;
}

export function verify(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = mac(`${head}.${body}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString());
    if (header.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
