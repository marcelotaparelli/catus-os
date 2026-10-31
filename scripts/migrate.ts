import { pool } from '../src/server/db';
import { readdir } from 'node:fs/promises';
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(74612001)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
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
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}
