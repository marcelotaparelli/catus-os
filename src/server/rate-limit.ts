import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { hash } from './auth/cookies';
export interface RatePolicy {
  limit: number;
  windowSeconds: number;
}
export const loginPolicy: RatePolicy = { limit: 20, windowSeconds: 60 };
export const apiPolicy: RatePolicy = { limit: 300, windowSeconds: 60 };
/**
 * Rate-limit bucket. Login and callback stay per socket peer. Other API calls of a
 * live session get a quota per session: behind the edge forwarder (or a private
 * proxy) the whole team shares one peer, so a per-peer quota would let one
 * person's browser lock everybody out. Anonymous or invalid cookies keep the
 * per-peer bucket, so unauthenticated floods are limited exactly as before.
 */
export async function rateSubject(
  db: Pool,
  path: string,
  peer: string,
  sessionToken: string,
  issuer: string,
) {
  if (path === '/api/auth/login' || path === '/api/auth/callback')
    return `auth:${peer}`;
  if (/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) {
    // Same validity predicate as authenticate() in auth/session.ts.
    const live = await db.query(
      `SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=u.id AND m.organization_id=s.organization_id
 WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes' AND u.active AND m.active AND u.issuer=$2`,
      [hash(sessionToken), issuer],
    );
    if (live.rowCount) return `session:${live.rows[0].id}`;
  }
  return `api:${peer}`;
}
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
