import { asUser } from './_lib/db.js';
import { api, json } from './_lib/http.js';
import { UUID } from './_lib/validate.js';

export default api(['GET', 'PATCH'], async (req, res, user) => {
  if (req.method === 'PATCH') {
    if (user.role === 'captain') return json(res, 403, { error: 'forbidden' });
    const id = String(req.body?.id ?? '');
    if (!UUID.test(id)) return json(res, 400, { error: 'bad_id' });
    await asUser(user, (sql) => [
      sql`UPDATE incidents SET resolved_at = now() WHERE id = ${id}`,
      sql`INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id) VALUES (app_uid(), app_role()::user_role, 'resolve_incident', 'incident', ${id})`
    ]);
    return json(res, 200, { ok: true });
  }
  const [rows] = await asUser(user, (sql) => [
    sql`SELECT i.id, i.type, i.severity, i.description, i.created_at, i.resolved_at, p.code AS pu_code, p.state, p.lga
        FROM incidents i JOIN polling_units p ON p.id = i.pu_id
        ORDER BY (i.resolved_at IS NULL) DESC, i.created_at DESC LIMIT 50`
  ]);
  json(res, 200, { incidents: rows });
}, { roles: ['captain', 'coordinator', 'admin'] });
