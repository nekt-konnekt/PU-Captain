import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { api, json } from '../_lib/http.js';
import { hashPhone, hashCode } from '../_lib/auth.js';
import { normalizePhone, isNgMobile } from '../_lib/validate.js';
import { sendSms, isMock } from '../_lib/sms.js';

// Always answers the same way for known and unknown numbers (no account enumeration).
export default api(['POST'], async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!isNgMobile(phone)) return json(res, 400, { error: 'bad_phone' });
  const phoneHash = hashPhone(phone);
  const generic = { ok: true };

  const [{ n }] = await sql`SELECT count(*)::int AS n FROM otp_codes WHERE phone_hash = ${phoneHash} AND created_at > now() - interval '1 hour'`;
  if (n >= 5) return json(res, 429, { error: 'too_many_requests' });

  const users = await sql`SELECT id FROM users WHERE phone_hash = ${phoneHash} AND active`;
  // Record the attempt either way so unknown numbers are throttled too.
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await sql`INSERT INTO otp_codes (phone_hash, code_hash, expires_at) VALUES (${phoneHash}, ${hashCode(code, phoneHash)}, now() + interval '5 minutes')`;
  if (!users.length) return json(res, 200, generic);

  const sent = await sendSms(phone, `Your PU Captain code is ${code}. It expires in 5 minutes. Do not share it.`);
  if (!sent) return json(res, 502, { error: 'sms_failed' });
  return json(res, 200, isMock() ? { ...generic, devCode: code } : generic);
}, { auth: false });
