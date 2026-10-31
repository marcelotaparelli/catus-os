import pg from 'pg';
// Tests are deliberately constrained to a separate loopback database, never the app DB.
const target = new URL(
  process.env.TEST_DATABASE_URL ??
    'postgres://catus:catus_local_only@127.0.0.1:5432/catus_test',
);
if (
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(target.pathname)
)
  throw new Error('Test database must be loopback and end in _test');
if (
  process.env.DATABASE_URL &&
  new URL(process.env.DATABASE_URL).pathname === target.pathname
)
  throw new Error('Test DB must differ from app DB');
const admin = new URL(target);
admin.pathname = '/postgres';
const db = new pg.Client({ connectionString: admin.href });
await db.connect();
try {
  const name = target.pathname.slice(1);
  if (
    !(await db.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]))
      .rowCount
  )
    await db.query(`CREATE DATABASE "${name}"`);
} finally {
  await db.end();
}
const child = Bun.spawn(['node_modules/.bin/bun', 'scripts/migrate.ts'], {
  env: {
    ...process.env,
    DATABASE_URL: target.href,
    MIGRATION_DATABASE_URL: target.href,
    DB_RUNTIME_ROLE: undefined,
    DB_MAINTENANCE_ROLE: undefined,
  },
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
