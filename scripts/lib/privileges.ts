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
  economic_records: 'SELECT,INSERT',
  economic_decisions: 'SELECT,INSERT',
  time_entries: 'SELECT,INSERT',
  time_events: 'SELECT,INSERT',
  economic_reports: 'SELECT,INSERT',
  economic_events: 'SELECT,INSERT',
  contracts: 'SELECT,INSERT,UPDATE',
  commercial_policies: 'SELECT,INSERT,UPDATE',
  scope_versions: 'SELECT,INSERT,UPDATE',
  scope_items: 'SELECT,INSERT,DELETE',
  scope_contributors: 'SELECT,INSERT',
  change_requests: 'SELECT,INSERT,UPDATE',
  scope_decisions: 'SELECT,INSERT',
  commercial_events: 'SELECT,INSERT',
  ai_policies: 'SELECT,INSERT,UPDATE',
  ai_budget_days: 'SELECT,INSERT,UPDATE',
  extraction_jobs: 'SELECT,INSERT',
  ai_proposals: 'SELECT,UPDATE',
  proposal_reviews: 'SELECT,INSERT',
};
export const tables = [...Object.keys(grants), 'schema_migrations'];
export async function applyGrants(
  c: PoolClient | Client,
  runtime: string,
  maintenance: string,
  worker?: string,
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
    requests:
      'status,owner_user_id,next_action,version,updated_at,origin_proposal_id,suggested_acceptance_criteria,scope_item_id',
    sessions: 'last_seen_at,revoked_at',
  })) {
    if (
      (await c.query('SELECT to_regclass($1) present', ['public.' + name]))
        .rows[0].present
    )
      await c.query(
        `GRANT UPDATE(${(await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=ANY($2::text[])", [name, columns.split(',')])).rows.map((r) => ident(r.column_name)).join(',')}) ON ${ident(name)} TO ${ident(runtime)}`,
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
  if (worker) {
    const access: Record<string, string> = {
      extraction_jobs: 'SELECT,UPDATE',
      ai_budget_days: 'SELECT,UPDATE',
      ai_policies: 'SELECT',
      ai_proposals: 'SELECT',
      memberships: 'SELECT',
      users: 'SELECT',
      requests: 'SELECT',
      interactions: 'SELECT',
      audit_events: 'INSERT',
    };
    for (const name of Object.keys(grants))
      if (
        (await c.query('SELECT to_regclass($1) present', ['public.' + name]))
          .rows[0].present
      ) {
        await c.query(`REVOKE ALL ON ${ident(name)} FROM ${ident(worker)}`);
        if (access[name])
          await c.query(
            `GRANT ${access[name]} ON ${ident(name)} TO ${ident(worker)}`,
          );
      }
    if (
      (await c.query("SELECT to_regclass('public.ai_proposals') present"))
        .rows[0].present
    )
      await c.query(
        `GRANT INSERT(id,organization_id,extraction_id,title,description,evidence,acceptance_criteria,duplicates) ON ai_proposals TO ${ident(worker)}`,
      );
    if (
      (
        await c.query(
          "SELECT to_regclass('public.audit_events_id_seq') present",
        )
      ).rows[0].present
    )
      await c.query(
        `GRANT USAGE ON SEQUENCE audit_events_id_seq TO ${ident(worker)}`,
      );
  }
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
