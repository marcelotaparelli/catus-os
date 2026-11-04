// Persistent queue of deterministic automations. Jobs are written by trigger with the change
// that caused them, so a stopped or failing worker never loses work nor blocks a transaction:
// jobs wait and retry with backoff, and the queue screen does not depend on them.
import type { Pool, PoolClient } from 'pg';
import { assess } from './rules';
import { loadFacts } from './service';

export interface AutomationJob {
  id: string;
  organization_id: string;
  kind: 'evaluate_request' | 'sweep';
  request_id: string | null;
  attempts: number;
}
export type Evaluate = (db: PoolClient, job: AutomationJob) => Promise<void>;
const MAX_ATTEMPTS = 6;

/** Opens what is true now and resolves what stopped being true; both are idempotent. */
export const evaluate: Evaluate = async (db, job) => {
  const today = new Date().toISOString().slice(0, 10),
    now = new Date(),
    rows = await loadFacts(
      db,
      job.organization_id,
      job.request_id ?? undefined,
    );
  // A sweep also covers demands that left the open list: their alerts must close.
  const known = rows.map((r) => r.id);
  for (const r of rows) {
    const kinds = assess(r, today, now).map((s) => s.kind);
    for (const kind of kinds)
      await db.query(
        'INSERT INTO demand_alerts(organization_id,request_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [job.organization_id, r.id, kind],
      );
    await db.query(
      'UPDATE demand_alerts SET resolved_at=now() WHERE request_id=$1 AND organization_id=$2 AND resolved_at IS NULL AND NOT kind=ANY($3::text[])',
      [r.id, job.organization_id, kinds],
    );
  }
  if (!job.request_id)
    await db.query(
      'UPDATE demand_alerts SET resolved_at=now() WHERE organization_id=$1 AND resolved_at IS NULL AND NOT request_id=ANY($2::uuid[])',
      [job.organization_id, known],
    );
};

export async function enqueueSweeps(
  pool: Pool,
  now = new Date(),
  sweepSeconds = 300,
) {
  const bucket = Math.floor(now.getTime() / (sweepSeconds * 1000));
  await pool.query(
    "INSERT INTO automation_jobs(organization_id,kind,dedupe_key) SELECT id,'sweep','sweep:'||$1::text FROM organizations ON CONFLICT DO NOTHING",
    [String(bucket)],
  );
}

/** Runs at most `limit` due jobs; returns how many it claimed. Safe across processes. */
export async function runDueJobs(
  pool: Pool,
  options: {
    limit?: number;
    evaluator?: Evaluate;
    backoffSeconds?: number;
    leaseSeconds?: number;
  } = {},
) {
  const { limit = 20, backoffSeconds = 30, leaseSeconds = 120 } = options;
  const run = options.evaluator ?? evaluate;
  // A job that exhausted its attempts while running (crash) ends as failed, visibly.
  await pool.query(
    "UPDATE automation_jobs SET state='failed',finished_at=now(),last_error='lease expired' WHERE state='running' AND lease_until<now() AND attempts>=$1",
    [MAX_ATTEMPTS],
  );
  const { rows: jobs } = await pool.query<AutomationJob>(
    `UPDATE automation_jobs SET state='running',attempts=attempts+1,lease_until=now()+make_interval(secs=>$2) WHERE id IN (
 SELECT id FROM automation_jobs WHERE (state='queued' AND next_attempt_at<=now()) OR (state='running' AND lease_until<now())
 ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $1) RETURNING id,organization_id,kind,request_id,attempts`,
    [limit, leaseSeconds],
  );
  for (const job of jobs) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await run(db, job);
      await db.query(
        "UPDATE automation_jobs SET state='done',finished_at=now(),lease_until=NULL,last_error=NULL WHERE id=$1",
        [job.id],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined);
      // Only a class of error: no client data goes into this column or the log.
      const code =
        (e as { code?: string }).code ??
        (e instanceof Error ? e.name : 'unknown');
      await pool.query(
        `UPDATE automation_jobs SET state=CASE WHEN attempts>=$2 THEN 'failed' ELSE 'queued' END,finished_at=CASE WHEN attempts>=$2 THEN now() END,lease_until=NULL,last_error=$3,
 next_attempt_at=now()+make_interval(secs=>$4*power(2,attempts-1)) WHERE id=$1`,
        [job.id, MAX_ATTEMPTS, String(code).slice(0, 200), backoffSeconds],
      );
      console.error('Follow-up automation job failed', job.kind, code);
    } finally {
      db.release();
    }
  }
  return jobs.length;
}

/** Started by the API process. Never throws into the server; stopping it stops only alerts. */
export function startFollowupAutomation(
  pool: Pool,
  options: {
    intervalMs?: number;
    sweepSeconds?: number;
    evaluator?: Evaluate;
    backoffSeconds?: number;
  } = {},
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await enqueueSweeps(pool, new Date(), options.sweepSeconds);
      while (await runDueJobs(pool, options));
    } catch (e) {
      console.error(
        'Follow-up automation unavailable',
        (e as { code?: string }).code ?? 'internal',
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 30000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
