import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { api, json } from '../_lib/http.js';
import { hashPhone, hashCode, issueToken } from '../_lib/auth.js';
import { normalizePhone, isNgMobile } from '../_lib/validate.js';

export default api(['POST'], async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code ?? '');
  if (!isNgMobile(phone) || !/^\d{6}$/.test(code)) return json(res, 400, { error: 'bad_request' });
  const phoneHash = hashPhone(phone);

  const rows = await sql`
    SELECT id, code_hash FROM otp_codes
    WHERE phone_hash = ${phoneHash} AND NOT used AND expires_at > now() AND attempts < 5
    ORDER BY created_at DESC LIMIT 1`;
  const otp = rows[0];
  if (!otp) return json(res, 401, { error: 'invalid_code' });

  await sql`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ${otp.id}`;
  const a = Buffer.from(otp.code_hash);
  const b = Buffer.from(hashCode(code, phoneHash));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 401, { error: 'invalid_code' });

  await sql`UPDATE otp_codes SET used = true WHERE id = ${otp.id}`;
  const users = await sql`SELECT u.id, u.full_name, u.role, u.pu_id, p.code AS pu_code
                          FROM users u LEFT JOIN polling_units p ON p.id = u.pu_id
                          WHERE u.phone_hash = ${phoneHash} AND u.active`;
  const user = users[0];
  if (!user) return json(res, 401, { error: 'invalid_code' });

  await sql`INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id) VALUES (${user.id}, ${user.role}, 'login', 'user', ${user.id})`;
  json(res, 200, { token: issueToken(user), user: { id: user.id, name: user.full_name, role: user.role, pu: user.pu_code } });
}, { auth: false });
