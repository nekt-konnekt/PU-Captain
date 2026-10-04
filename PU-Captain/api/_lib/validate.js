export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PVC = ['has', 'no', 'registered', 'lost'];
export const SENTIMENT = ['support', 'undecided', 'oppose'];
export const ISSUES = ['Security', 'Economy', 'Roads', 'Health', 'Education', 'Water', 'Power', 'Jobs'];
export const INCIDENT_TYPES = ['violence', 'intimidation', 'ballot_issue', 'logistics', 'network_blackout', 'turnout', 'other'];
export const SEVERITY = ['low', 'medium', 'high', 'sos'];

export function normalizePhone(p) {
  let d = String(p ?? '').replace(/\D/g, '');
  if (d.startsWith('234') && d.length === 13) d = '0' + d.slice(3);
  else if (d.length === 10 && !d.startsWith('0')) d = '0' + d;
  return d;
}

export const isNgMobile = (d) => /^0[789][01]\d{8}$/.test(d);

function when(v) {
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const now = Date.now();
  return new Date(Math.min(t, now)).toISOString();
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function validateVoter(v) {
  if (!v || typeof v !== 'object') return { ok: false, error: 'invalid_record' };
  if (!UUID.test(v.id ?? '')) return { ok: false, error: 'bad_id' };
  const full_name = clean(v.full_name, 120);
  if (full_name.length < 2) return { ok: false, error: 'bad_name' };
  if (!PVC.includes(v.pvc_status)) return { ok: false, error: 'bad_pvc' };
  const sentiment = v.sentiment ?? 'undecided';
  if (!SENTIMENT.includes(sentiment)) return { ok: false, error: 'bad_sentiment' };
  if (v.consent_given !== true) return { ok: false, error: 'consent_required' };
  const consent_at = when(v.consent_at);
  const client_created_at = when(v.client_created_at);
  if (!consent_at || !client_created_at) return { ok: false, error: 'bad_date' };
  const issues = Array.isArray(v.issues) ? [...new Set(v.issues.filter((i) => ISSUES.includes(i)))] : [];
  let phone = null;
  let phone_last4 = null;
  if (v.phone) {
    phone = normalizePhone(v.phone);
    if (!isNgMobile(phone)) return { ok: false, error: 'bad_phone' };
    phone_last4 = phone.slice(-4);
  }
  return { ok: true, value: { id: v.id.toLowerCase(), full_name, phone, phone_last4, pvc_status: v.pvc_status, sentiment, issues, consent_at, client_created_at } };
}

export function validateIncident(i) {
  if (!i || typeof i !== 'object') return { ok: false, error: 'invalid_record' };
  if (!UUID.test(i.id ?? '')) return { ok: false, error: 'bad_id' };
  if (!INCIDENT_TYPES.includes(i.type)) return { ok: false, error: 'bad_type' };
  if (!SEVERITY.includes(i.severity)) return { ok: false, error: 'bad_severity' };
  const client_created_at = when(i.client_created_at);
  if (!client_created_at) return { ok: false, error: 'bad_date' };
  const num = (x, lo, hi) => (typeof x === 'number' && x >= lo && x <= hi ? x : null);
  return {
    ok: true,
    value: {
      id: i.id.toLowerCase(),
      type: i.type,
      severity: i.severity,
      description: i.description ? clean(i.description, 1000) : null,
      lat: num(i.lat, -90, 90),
      lng: num(i.lng, -180, 180),
      client_created_at
    }
  };
}
