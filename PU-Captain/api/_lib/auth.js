import crypto from 'node:crypto';
import { sql } from './db.js';
import { sign, verify } from './jwt.js';
import { normalizePhone } from './validate.js';

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET missing or too short');
  return s;
};

export const hashPhone = (phone) => crypto.createHash('sha256').update(normalizePhone(phone)).digest('hex');
export const hashCode = (code, phoneHash) => crypto.createHmac('sha256', secret()).update(`${phoneHash}:${code}`).digest('hex');
export const issueToken = (user) => sign({ sub: user.id }, secret());

/** Verifies the bearer token, then re-checks the user in the database so deactivation and role changes apply immediately. */
export async function requireUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const claims = verify(token, secret());
  if (!claims?.sub) return null;
  const rows = await sql`SELECT id, role, active FROM users WHERE id = ${claims.sub}`;
  const u = rows[0];
  if (!u || !u.active) return null;
  return { id: u.id, role: u.role };
}
