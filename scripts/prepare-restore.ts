import pg from 'pg';
import { appendFileSync } from 'node:fs';
import { provisionRoles } from './lib/provision-roles';
import { ident } from './lib/privileges';
if (!process.env.DATABASE_URL)
  throw new Error('Local administrative DATABASE_URL required');
const source = new URL(process.env.DATABASE_URL);
const name = process.env.RESTORE_DATABASE_NAME ?? 'catus_homolog_restore_test';
if (
  !['127.0.0.1', 'localhost'].includes(source.hostname) ||
  !/^catus$|^[a-z][a-z0-9_]*_test$/.test(source.pathname.slice(1)) ||
  !/^catus_[a-z0-9_]*_restore_test$/.test(name)
)
  throw new Error('Refusing non-local/disposable restore target');
const target = new URL(source);
target.pathname = '/' + name;
source.pathname = '/postgres';
const c = new pg.Client({ connectionString: source.href });
await c.connect();
try {
  if (
    (await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]))
      .rowCount
  )
    throw new Error('Target already exists; never overwriting or dropping it');
  await c.query(`CREATE DATABASE ${ident(name)}`);
} finally {
  await c.end();
}
const roles = await provisionRoles(target.href, '.local/restore.env');
appendFileSync(
  '.local/restore.env',
  `RESTORE_DATABASE_URL=${roles.MIGRATION_DATABASE_URL}\nRESTORE_RUNTIME_ROLE=${roles.DB_RUNTIME_ROLE}\nRESTORE_MAINTENANCE_ROLE=${roles.DB_MAINTENANCE_ROLE}\n`,
  { mode: 0o600 },
);
console.log(
  'Empty disposable restore database and private .local/restore.env prepared',
);
