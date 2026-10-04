import { asUser } from './_lib/db.js';
import { api, json } from './_lib/http.js';

// Aggregates only. No names or phone numbers leave this endpoint. Scope is enforced by row-level security.
export default api(['GET'], async (req, res, user) => {
  const [totals, units, issues, open] = await asUser(user, (sql) => [
    sql`SELECT count(*)::int AS logged,
               count(*) FILTER (WHERE pvc_status = 'has')::int AS has_pvc,
               count(*) FILTER (WHERE pvc_status <> 'has')::int AS no_pvc,
               count(*) FILTER (WHERE sentiment = 'support')::int AS support,
               count(*) FILTER (WHERE sentiment = 'undecided')::int AS undecided,
               count(*) FILTER (WHERE sentiment = 'oppose')::int AS oppose
        FROM voters`,
    sql`SELECT p.code, p.lga, p.lat, p.lng, count(v.id)::int AS logged,
               count(*) FILTER (WHERE v.sentiment = 'support')::int AS support,
               count(*) FILTER (WHERE v.sentiment = 'oppose')::int AS oppose,
               count(*) FILTER (WHERE v.sentiment = 'undecided')::int AS undecided
        FROM polling_units p LEFT JOIN voters v ON v.pu_id = p.id
        GROUP BY p.id ORDER BY p.code`,
    sql`SELECT i AS issue, count(*)::int AS n FROM voters, unnest(issues) AS i GROUP BY i ORDER BY n DESC LIMIT 10`,
    sql`SELECT i.id, i.type, i.severity, i.description, i.created_at, p.code AS pu_code, p.lga
        FROM incidents i JOIN polling_units p ON p.id = i.pu_id
        WHERE i.resolved_at IS NULL ORDER BY i.created_at DESC LIMIT 20`
  ]);
  const t = totals[0];
  const classify = (u) => {
    if (!u.logged) return 'no_data';
    const s = u.support / u.logged;
    const o = u.oppose / u.logged;
    if (s >= 0.6) return 'strong_support';
    if (s >= 0.45 && s > o) return 'lean_support';
    if (o >= 0.5) return 'opposition';
    return 'swing';
  };
  json(res, 200, {
    totals: { ...t, pvcRate: t.logged ? Math.round((t.has_pvc / t.logged) * 100) : 0, supportRate: t.logged ? Math.round((t.support / t.logged) * 100) : 0 },
    units: units.map((u) => ({ ...u, status: classify(u) })),
    topIssues: issues,
    openIncidents: open
  });
}, { roles: ['coordinator', 'admin'] });
