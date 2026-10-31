import pg from 'pg';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname } from 'node:path';
import { ident, tables, applyGrants } from './privileges';
export interface DatabaseRoles {
  AI_WORKER_DATABASE_URL: string;
  DB_AI_WORKER_ROLE: string;
  RUNTIME_DATABASE_URL: string;
  MIGRATION_DATABASE_URL: string;
  MAINTENANCE_DATABASE_URL: string;
  DB_RUNTIME_ROLE: string;
  DB_MAINTENANCE_ROLE: string;
}
export async function provisionRoles(
  adminUrl: string,
  file: string,
): Promise<DatabaseRoles> {
  const url = new URL(adminUrl);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^catus$|^[a-z][a-z0-9_]{0,35}_test$/.test(dbName)
  )
    throw new Error(
      'Provisioning only allowed for local Catus/disposable test databases',
    );
  const existing = existsSync(file)
    ? parseEnv(readFileSync(file, 'utf8'))
    : undefined;
  const names = {
    runtime: dbName + '_runtime',
    migration: dbName + '_migrator',
    maintenance: dbName + '_maintenance',
    worker: dbName + '_aiworker',
  };
  const credentials: Record<string, string> = {};
  for (const [kind, name] of Object.entries(names)) {
    const key =
      kind === 'runtime'
        ? 'RUNTIME_DATABASE_URL'
        : kind === 'migration'
          ? 'MIGRATION_DATABASE_URL'
          : kind === 'worker'
            ? 'AI_WORKER_DATABASE_URL'
            : 'MAINTENANCE_DATABASE_URL';
    if (existing?.[key]) {
      const saved = new URL(existing[key]!);
      if (
        saved.username !== name ||
        saved.hostname !== url.hostname ||
        (saved.port || '5432') !== (url.port || '5432') ||
        saved.pathname !== url.pathname
      )
        throw new Error('Existing role file does not match target');
      credentials[key] = saved.href;
    } else {
      const connection = new URL(url);
      connection.username = name;
      connection.password = randomBytes(32).toString('hex');
      credentials[key] = connection.href;
    }
  }
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [kind, name] of Object.entries(names)) {
      const row = (
        await c.query(
          'SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',
          [name],
        )
      ).rows[0];
      if (
        row &&
        !(
          existing &&
          Object.values(existing).some((v) => {
            try {
              return new URL(v ?? '').username === name;
            } catch {
              return false;
            }
          })
        )
      )
        throw new Error(
          'Roles already exist but credential file is absent; recover credentials rather than reset passwords',
        );
      if (row && Object.values(row).some(Boolean))
        throw new Error('Existing role is overprivileged');
      if (!row) {
        const key =
          kind === 'runtime'
            ? 'RUNTIME_DATABASE_URL'
            : kind === 'migration'
              ? 'MIGRATION_DATABASE_URL'
              : kind === 'worker'
                ? 'AI_WORKER_DATABASE_URL'
                : 'MAINTENANCE_DATABASE_URL';
        const password = new URL(credentials[key]!).password;
        if (!/^[a-f0-9]{64}$/.test(password))
          throw new Error('Unexpected stored password format');
        await c.query(
          `CREATE ROLE ${ident(name)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
        );
      }
    }
    const relations = (
      await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")
    ).rows;
    if (relations.some((r) => !tables.includes(r.tablename)))
      throw new Error('Unknown public tables; refusing ownership transfer');
    await c.query(
      `ALTER DATABASE ${ident(dbName)} OWNER TO ${ident(names.migration)}`,
    );
    await c.query(`REVOKE ALL ON DATABASE ${ident(dbName)} FROM PUBLIC`);
    await c.query(
      `GRANT CONNECT ON DATABASE ${ident(dbName)} TO ${ident(names.runtime)},${ident(names.migration)},${ident(names.maintenance)},${ident(names.worker)}`,
    );
    await c.query(`ALTER SCHEMA public OWNER TO ${ident(names.migration)}`);
    await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await c.query(
      `GRANT USAGE ON SCHEMA public TO ${ident(names.runtime)},${ident(names.maintenance)},${ident(names.worker)}`,
    );
    for (const r of relations)
      await c.query(
        `ALTER TABLE ${ident(r.tablename)} OWNER TO ${ident(names.migration)}`,
      );
    await applyGrants(c, names.runtime, names.maintenance, names.worker);
    await c.query('COMMIT');
    if (!existing) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(
        file,
        Object.entries({
          ...credentials,
          DB_RUNTIME_ROLE: names.runtime,
          DB_MAINTENANCE_ROLE: names.maintenance,
          DB_AI_WORKER_ROLE: names.worker,
        })
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    }
    if (existing && !existing.AI_WORKER_DATABASE_URL)
      writeFileSync(
        file,
        `\nAI_WORKER_DATABASE_URL=${credentials.AI_WORKER_DATABASE_URL}\nDB_AI_WORKER_ROLE=${names.worker}\n`,
        { flag: 'a', mode: 0o600 },
      );
    chmodSync(file, 0o600);
    return {
      AI_WORKER_DATABASE_URL: credentials.AI_WORKER_DATABASE_URL!,
      DB_AI_WORKER_ROLE: names.worker,
      RUNTIME_DATABASE_URL: credentials.RUNTIME_DATABASE_URL!,
      MIGRATION_DATABASE_URL: credentials.MIGRATION_DATABASE_URL!,
      MAINTENANCE_DATABASE_URL: credentials.MAINTENANCE_DATABASE_URL!,
      DB_RUNTIME_ROLE: names.runtime,
      DB_MAINTENANCE_ROLE: names.maintenance,
    };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
