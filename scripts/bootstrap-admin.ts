import { parseArgs } from 'node:util';
import pg from 'pg';
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error('MIGRATION_DATABASE_URL required for offline bootstrap');
const pool = new pg.Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
import { loadConfig } from '../src/server/config';
import { text, uuid } from '../src/shared/domain';
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    organization: {
      type: 'string',
      default: '00000000-0000-4000-8000-000000000001',
    },
  },
});
const config = loadConfig();
if (!config.oidc) throw new Error('Configure OIDC before provisioning');
const email = text(values.email, 'Email', 254).toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');
const name = text(values.name, 'Nome');
const organization = uuid(values.organization);
const c = await pool.connect();
try {
  await c.query('BEGIN');
  if (
    !(
      await c.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [
        organization,
      ])
    ).rowCount
  )
    throw new Error('Organization does not exist');
  if (
    (
      await c.query(
        "SELECT 1 FROM memberships WHERE organization_id=$1 AND role='administrator' AND active",
        [organization],
      )
    ).rowCount
  )
    throw new Error(
      'Administrator already exists; use an authenticated administrator to manage members',
    );
  const candidate = crypto.randomUUID();
  const user = (
    await c.query(
      'INSERT INTO users(id,issuer,email,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(issuer,email) DO UPDATE SET email=excluded.email RETURNING id',
      [candidate, config.oidc.issuer, email, name],
    )
  ).rows[0];
  await c.query(
    "INSERT INTO memberships(user_id,organization_id,role) VALUES($1,$2,'administrator') ON CONFLICT(user_id,organization_id) DO UPDATE SET role='administrator',active=true",
    [user.id, organization],
  );
  await c.query(
    "INSERT INTO audit_events(organization_id,actor,entity_type,entity_id,action) VALUES($1,'offline-bootstrap','membership',$2,'first-administrator-provisioned')",
    [organization, user.id],
  );
  await c.query('COMMIT');
  console.log(
    'First administrator provisioned; OIDC verification is still required to log in',
  );
} catch (e) {
  await c.query('ROLLBACK');
  throw e;
} finally {
  c.release();
  await pool.end();
}
