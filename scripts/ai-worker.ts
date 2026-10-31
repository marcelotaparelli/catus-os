import pg from 'pg';
import { configuredProvider } from '../src/server/ai/provider';
import { processOne } from '../src/server/ai/worker';
if (!process.env.AI_WORKER_DATABASE_URL)
  throw new Error('AI_WORKER_DATABASE_URL required; prepare db:roles');
const db = new pg.Pool({
  connectionString: process.env.AI_WORKER_DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});
db.on('error', () => console.error('AI worker database connection failure'));
if (
  process.env.DATABASE_URL ||
  process.env.RUNTIME_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.MAINTENANCE_DATABASE_URL
)
  throw new Error('Use isolated AI worker launcher');
const role = (
  await db.query(
    "SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,has_table_privilege(current_user,'requests','INSERT') can_create,has_table_privilege(current_user,'ai_proposals','UPDATE') can_approve FROM pg_roles r WHERE rolname=current_user",
  )
).rows[0];
if (!role || Object.values(role).some(Boolean))
  throw new Error('AI worker database role is overprivileged');
const provider = configuredProvider();
if (!provider)
  console.log(
    'LLM unavailable: no external inference; only interrupted-job recovery is active',
  );
let stop = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stop = true;
  });
try {
  do {
    try {
      const worked = await processOne(db, provider);
      if (!worked && !process.argv.includes('--once')) await Bun.sleep(1000);
    } catch {
      console.error(
        'AI worker cycle failed; no provider payload or secret logged',
      );
      if (process.argv.includes('--once')) {
        process.exitCode = 1;
        break;
      }
      await Bun.sleep(1000);
    }
  } while (!stop && !process.argv.includes('--once'));
} finally {
  await db.end();
}
