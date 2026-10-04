import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

// Owner connection: used ONLY for login/session lookups. All data access goes through asUser().
export const sql = neon(process.env.DATABASE_URL);

/**
 * Runs queries in one transaction as the restricted pu_app role with the
 * caller's identity set, so Postgres row-level security decides what is visible.
 * `build` receives sql and returns an array of queries.
 */
export async function asUser(user, build) {
  const queries = [
    sql`SET LOCAL ROLE pu_app`,
    sql`SELECT set_config('app.user_id', ${user.id}, true), set_config('app.role', ${user.role}, true)`,
    ...build(sql)
  ];
  const results = await sql.transaction(queries);
  return results.slice(2);
}
