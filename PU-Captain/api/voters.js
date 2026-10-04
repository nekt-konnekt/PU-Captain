import { asUser } from './_lib/db.js';
import { api, json } from './_lib/http.js';
import { UUID, PVC, SENTIMENT } from './_lib/validate.js';

export default api(['GET', 'DELETE'], async (req, res, user) => {
  if (req.method === 'DELETE') {
    // Erasure request: captains can remove voters they logged (soft delete, audited).
    const id = String(req.query.id ?? '');
    if (!UUID.test(id)) return json(res, 400, { error: 'bad_id' });
    await asUser(user, (sql) => [
      sql`UPDATE voters SET deleted_at = now() WHERE id = ${id}`,
      sql`INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id) VALUES (app_uid(), app_role()::user_role, 'erase', 'voter', ${id})`
    ]);
    return json(res, 200, { ok: true });
  }

  const pvc = PVC.includes(req.query.pvc) ? req.query.pvc : null;
  const sentiment = SENTIMENT.includes(req.query.sentiment) ? req.query.sentiment : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const queries = [
    (sql) => sql`SELECT id, pu_id, full_name, phone_last4, pvc_status, sentiment, issues, client_created_at
                 FROM voters
                 WHERE (${pvc}::text IS NULL OR pvc_status = ${pvc}::pvc_status)
                   AND (${sentiment}::text IS NULL OR sentiment = ${sentiment}::sentiment)
                 ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  ];
  if (user.role !== 'captain') {
    queries.push((sql) => sql`INSERT INTO audit_log (actor_id, actor_role, action, entity, meta)
                              VALUES (app_uid(), app_role()::user_role, 'view_voters', 'voter', ${JSON.stringify({ pvc, sentiment, limit, offset })}::jsonb)`);
  }
  const results = await asUser(user, (sql) => queries.map((q) => q(sql)));
  json(res, 200, { voters: results[0], limit, offset });
}, { roles: ['captain', 'coordinator', 'admin'] });
