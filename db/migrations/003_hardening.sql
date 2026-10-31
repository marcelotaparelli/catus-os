CREATE TABLE rate_limits (
 bucket text PRIMARY KEY,
 window_started_at timestamptz NOT NULL,
 attempts integer NOT NULL CHECK(attempts>0)
);
CREATE INDEX rate_limits_expiry_idx ON rate_limits(window_started_at);
CREATE TABLE idempotency_keys (
 organization_id uuid NOT NULL,
 user_id uuid NOT NULL,
 route text NOT NULL,
 key uuid NOT NULL,
 request_hash text NOT NULL,
 response_status integer,
 response_body jsonb,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(organization_id,user_id,route,key),
 FOREIGN KEY(user_id,organization_id) REFERENCES memberships(user_id,organization_id),
 CHECK((response_status IS NULL)=(response_body IS NULL))
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);
CREATE INDEX sessions_cleanup_idx ON sessions(expires_at,last_seen_at);
CREATE INDEX sessions_revoked_cleanup_idx ON sessions(revoked_at) WHERE revoked_at IS NOT NULL;
