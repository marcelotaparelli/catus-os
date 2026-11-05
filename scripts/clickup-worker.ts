// The only process holding the ClickUp token. Off unless enabled and fully configured; then
// no network call happens at all. Its database account cannot read economics or demands.
import pg from 'pg';
import { createClickUpClient } from '../src/server/clickup/client';
import { clickupWorkerConfig } from '../src/server/clickup/config';
import { runDueSyncs } from '../src/server/clickup/sync';

const config = clickupWorkerConfig();
if (!config.enabled) {
  console.log(`ClickUp integration disabled (${config.reason}); nothing to do`);
  process.exit(0);
}
if (!process.env.CLICKUP_WORKER_DATABASE_URL)
  throw new Error('CLICKUP_WORKER_DATABASE_URL required; prepare clickup:role');
if (
  process.env.DATABASE_URL ||
  process.env.RUNTIME_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.MAINTENANCE_DATABASE_URL ||
  process.env.AI_WORKER_DATABASE_URL
)
  throw new Error('Use the isolated ClickUp worker launcher');
const db = new pg.Pool({
  connectionString: process.env.CLICKUP_WORKER_DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});
db.on('error', () =>
  console.error('ClickUp worker database connection failure'),
);
const role = (
  await db.query(
    "SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,has_table_privilege(current_user,'economic_records','SELECT') economics,has_table_privilege(current_user,'requests','SELECT') requests,has_table_privilege(current_user,'contracts','SELECT') contracts FROM pg_roles r WHERE rolname=current_user",
  )
).rows[0];
if (!role || Object.values(role).some(Boolean))
  throw new Error('ClickUp worker database role is overprivileged');
const client = createClickUpClient({
  token: config.token,
  requestsPerMinute: config.requestsPerMinute,
});
const once = process.argv.includes('--once');
let stop = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stop = true;
  });
try {
  do {
    let pauseSeconds = 0;
    try {
      const result = await runDueSyncs(db, client, config);
      pauseSeconds = result.pauseSeconds;
      console.log(`ClickUp sync cycle: ${result.processed} list(s) processed`);
    } catch (e) {
      // A class only: no token, URL or provider content in logs.
      console.error(
        'ClickUp sync cycle failed',
        (e as { code?: string }).code ?? 'internal',
      );
      if (once) process.exitCode = 1;
    }
    if (once) break;
    const until = Date.now() + Math.max(30, pauseSeconds) * 1000;
    while (!stop && Date.now() < until) await Bun.sleep(1000);
  } while (!stop);
} finally {
  await db.end();
}
