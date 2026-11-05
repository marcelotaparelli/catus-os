import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { applyClickupGrants, ident } from './privileges';
/** Least-privilege account of the ClickUp worker. Same local-only guard as provisionRoles. */
export async function provisionClickupRole(adminUrl: string, file: string) {
  const url = new URL(adminUrl);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^catus$|^[a-z][a-z0-9_]{0,35}_test$/.test(dbName)
  )
    throw new Error(
      'Provisioning only allowed for local Catus/disposable test databases',
    );
  const name = dbName + '_clickup';
  const saved = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const row = (
      await c.query(
        'SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',
        [name],
      )
    ).rows[0];
    if (row && Object.values(row).some(Boolean))
      throw new Error('Existing role is overprivileged');
    if (row && !saved.CLICKUP_WORKER_DATABASE_URL)
      throw new Error(
        'Role already exists but credential file is absent; recover credentials rather than reset passwords',
      );
    let connection = saved.CLICKUP_WORKER_DATABASE_URL;
    if (!row) {
      const password = randomBytes(32).toString('hex');
      await c.query(
        `CREATE ROLE ${ident(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
      );
      const target = new URL(url);
      target.username = name;
      target.password = password;
      connection = target.href;
    }
    await c.query(
      `GRANT CONNECT ON DATABASE ${ident(dbName)} TO ${ident(name)}`,
    );
    await c.query(`GRANT USAGE ON SCHEMA public TO ${ident(name)}`);
    await applyClickupGrants(c, name);
    await c.query('COMMIT');
    if (!saved.CLICKUP_WORKER_DATABASE_URL) {
      appendFileSync(
        file,
        `\nCLICKUP_WORKER_DATABASE_URL=${connection}\nDB_CLICKUP_WORKER_ROLE=${name}\n`,
        { mode: 0o600 },
      );
      chmodSync(file, 0o600);
    }
    return { CLICKUP_WORKER_DATABASE_URL: connection!, role: name };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
