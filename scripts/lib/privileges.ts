import type { PoolClient, Pool, Client } from 'pg';
export const ident = (name: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name))
    throw new Error('Unsafe SQL identifier');
  return '"' + name + '"';
};
const grants: Record<string, string> = {
  organizations: 'SELECT',
  users: 'SELECT,INSERT',
  memberships: 'SELECT,INSERT,UPDATE',
  clients: 'SELECT,INSERT',
  projects: 'SELECT,INSERT',
  interactions: 'SELECT,INSERT',
  requests: 'SELECT,INSERT',
  audit_events: 'SELECT,INSERT',
  sessions: 'SELECT,INSERT',
  oidc_transactions: 'SELECT,INSERT,DELETE',
  rate_limits: 'SELECT,INSERT,UPDATE',
  idempotency_keys: 'SELECT,INSERT,UPDATE',
};
export const tables = [...Object.keys(grants), 'schema_migrations'];
export async function applyGrants(
  c: PoolClient | Client,
  runtime: string,
  maintenance: string,
) {
  for (const [name, access] of Object.entries(grants)) {
    if (
      !(await c.query('SELECT to_regclass($1) present', ['public.' + name]))
        .rows[0].present
    )
      continue;
    await c.query(
      `REVOKE ALL ON ${ident(name)} FROM ${ident(runtime)},${ident(maintenance)},PUBLIC`,
    );
    await c.query(`GRANT ${access} ON ${ident(name)} TO ${ident(runtime)}`);
  }
  for (const [name, columns] of Object.entries({
    users: 'subject',
    requests: 'status,owner_user_id,next_action,version,updated_at',
    sessions: 'last_seen_at,revoked_at',
  })) {
    if (
      (await c.query('SELECT to_regclass($1) present', ['public.' + name]))
        .rows[0].present
    )
      await c.query(
        `GRANT UPDATE(${columns}) ON ${ident(name)} TO ${ident(runtime)}`,
      );
  }
  for (const name of [
    'sessions',
    'oidc_transactions',
    'rate_limits',
    'idempotency_keys',
  ])
    if (
      (await c.query('SELECT to_regclass($1) present', ['public.' + name]))
        .rows[0].present
    )
      await c.query(
        `GRANT SELECT,DELETE ON ${ident(name)} TO ${ident(maintenance)}`,
      );
  if (
    (await c.query("SELECT to_regclass('public.audit_events_id_seq') present"))
      .rows[0].present
  )
    await c.query(
      `GRANT USAGE ON SEQUENCE audit_events_id_seq TO ${ident(runtime)}`,
    );
}
export async function assertRuntimePrivileges(db: Pool) {
  const c = await db.connect();
  try {
    const r = (
      await c.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolreplication,
   EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) has_memberships,
   has_database_privilege(current_user,current_database(),'CREATE') db_create,
   has_schema_privilege(current_user,'public','CREATE') can_ddl,
   pg_has_role(current_user,d.datdba,'MEMBER') owns_db,
   has_table_privilege(current_user,'audit_events','DELETE') audit_delete,
   has_table_privilege(current_user,'audit_events','UPDATE') audit_update
   FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)
    ).rows[0];
    if (!r || Object.values(r).some(Boolean))
      throw new Error(
        'Runtime PostgreSQL role has excessive privileges; run db:roles and use RUNTIME_DATABASE_URL',
      );
  } finally {
    c.release();
  }
}
