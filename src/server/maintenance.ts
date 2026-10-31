import type { Pool } from 'pg';
/** Bounded batches, preserving business/audit records. Runs under maintenance account only. */
export async function cleanup(db: Pool, batch = 500) {
  if (!Number.isInteger(batch) || batch < 1 || batch > 5000)
    throw new Error('Invalid cleanup batch');
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='5s'");
    if (
      !(await c.query('SELECT pg_try_advisory_xact_lock(74612003) locked'))
        .rows[0].locked
    ) {
      await c.query('COMMIT');
      return { sessions: 0, states: 0, limits: 0, keys: 0 };
    }
    const sessions = await c.query(
      `DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at<=now() OR last_seen_at<=now()-interval '30 minutes' OR revoked_at IS NOT NULL ORDER BY expires_at LIMIT $1)`,
      [batch],
    );
    const states = await c.query(
      'DELETE FROM oidc_transactions WHERE state_hash IN (SELECT state_hash FROM oidc_transactions WHERE expires_at<=now() LIMIT $1)',
      [batch],
    );
    const limits = await c.query(
      "DELETE FROM rate_limits WHERE window_started_at<now()-interval '1 day' AND bucket IN (SELECT bucket FROM rate_limits WHERE window_started_at<now()-interval '1 day' LIMIT $1)",
      [batch],
    );
    const keys = await c.query(
      'DELETE FROM idempotency_keys WHERE (organization_id,user_id,route,key) IN (SELECT organization_id,user_id,route,key FROM idempotency_keys WHERE expires_at<=now() LIMIT $1)',
      [batch],
    );
    await c.query('COMMIT');
    return {
      sessions: sessions.rowCount,
      states: states.rowCount,
      limits: limits.rowCount,
      keys: keys.rowCount,
    };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
