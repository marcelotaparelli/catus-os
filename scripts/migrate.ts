import pg from 'pg';
import { readdir } from 'node:fs/promises';
import { applyGrants } from './lib/privileges';
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error(
    'MIGRATION_DATABASE_URL required; runtime must never migrate',
  );
const pool = new pg.Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(74612001)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const name of (await readdir('db/migrations'))
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    if (
      (
        await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [
          name,
        ])
      ).rowCount
    )
      continue;
    await client.query(await Bun.file(`db/migrations/${name}`).text());
    await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [
      name,
    ]);
    console.log(`Applied ${name}`);
  }
  if (process.env.DB_RUNTIME_ROLE && process.env.DB_MAINTENANCE_ROLE)
    await applyGrants(
      client,
      process.env.DB_RUNTIME_ROLE,
      process.env.DB_MAINTENANCE_ROLE,
    );
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}
