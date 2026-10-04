import { asUser } from './_lib/db.js';
import { api, json, HttpError } from './_lib/http.js';
import { validateVoter, validateIncident } from './_lib/validate.js';

const MAX_BATCH = 100;

// Idempotent batch upload from the offline queue. Safe to retry: duplicates are acknowledged, not re-inserted.
// pu_id and captain_id always come from the session, never from the client.
export default api(['POST'], async (req, res, user) => {
  const voters = Array.isArray(req.body?.voters) ? req.body.voters : [];
  const incidents = Array.isArray(req.body?.incidents) ? req.body.incidents : [];
  if (voters.length + incidents.length > MAX_BATCH) throw new HttpError(413, 'batch_too_large');

  const ackedVoters = [];
  const ackedIncidents = [];
  const rejected = [];
  const key = process.env.PHONE_KEY;
  if (!key || key.length < 32) throw new Error('PHONE_KEY missing or too short');

  const okVoters = [];
  for (const raw of voters) {
    const r = validateVoter(raw);
    if (r.ok) okVoters.push(r.value);
    else rejected.push({ id: raw?.id ?? null, kind: 'voter', error: r.error });
  }
  const okIncidents = [];
  for (const raw of incidents) {
    const r = validateIncident(raw);
    if (r.ok) okIncidents.push(r.value);
    else rejected.push({ id: raw?.id ?? null, kind: 'incident', error: r.error });
  }

  if (okVoters.length || okIncidents.length) {
    await asUser(user, (sql) => [
      ...okVoters.map((v) => sql`
        INSERT INTO voters (id, pu_id, captain_id, full_name, phone_enc, phone_last4, pvc_status, sentiment, issues, consent_given, consent_at, client_created_at)
        VALUES (${v.id}, app_pu(), app_uid(), ${v.full_name},
                CASE WHEN ${v.phone}::text IS NULL THEN NULL ELSE pgp_sym_encrypt(${v.phone}::text, ${key}) END,
                ${v.phone_last4}, ${v.pvc_status}::pvc_status, ${v.sentiment}::sentiment, ${v.issues}::text[],
                true, ${v.consent_at}::timestamptz, ${v.client_created_at}::timestamptz)
        ON CONFLICT (id) DO NOTHING`),
      ...okIncidents.map((i) => sql`
        INSERT INTO incidents (id, pu_id, captain_id, type, severity, description, lat, lng, client_created_at)
        VALUES (${i.id}, app_pu(), app_uid(), ${i.type}::incident_type, ${i.severity}::incident_severity,
                ${i.description}, ${i.lat}, ${i.lng}, ${i.client_created_at}::timestamptz)
        ON CONFLICT (id) DO NOTHING`),
      sql`INSERT INTO audit_log (actor_id, actor_role, action, entity, meta)
          VALUES (app_uid(), app_role()::user_role, 'sync', 'batch',
                  ${JSON.stringify({ voters: okVoters.length, incidents: okIncidents.length })}::jsonb)`
    ]);
    ackedVoters.push(...okVoters.map((v) => v.id));
    ackedIncidents.push(...okIncidents.map((i) => i.id));
  }

  json(res, 200, { ackedVoters, ackedIncidents, rejected });
}, { roles: ['captain'] });
