import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
export interface RatePolicy {
  limit: number;
  windowSeconds: number;
}
export const loginPolicy: RatePolicy = { limit: 20, windowSeconds: 60 };
export const apiPolicy: RatePolicy = { limit: 300, windowSeconds: 60 };
/** Independent autocommit: a denied/rolled-back operation still consumes quota. */
export async function consumeRate(db: Pool, key: string, policy: RatePolicy) {
  const bucket = createHash('sha256').update(key).digest('hex');
  const row = (
    await db.query(
      `INSERT INTO rate_limits(bucket,window_started_at,attempts) VALUES($1,clock_timestamp(),1)
 ON CONFLICT(bucket) DO UPDATE SET
 attempts=CASE WHEN rate_limits.window_started_at<=clock_timestamp()-make_interval(secs=>$2) THEN 1 ELSE rate_limits.attempts+1 END,
 window_started_at=CASE WHEN rate_limits.window_started_at<=clock_timestamp()-make_interval(secs=>$2) THEN clock_timestamp() ELSE rate_limits.window_started_at END
 RETURNING attempts,GREATEST(1,ceil(extract(epoch FROM window_started_at+make_interval(secs=>$2)-clock_timestamp())))::int retry_after`,
      [bucket, policy.windowSeconds],
    )
  ).rows[0];
  return {
    allowed: row.attempts <= policy.limit,
    retryAfter: row.retry_after as number,
  };
}
