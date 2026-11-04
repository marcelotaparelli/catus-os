-- Nenhuma demanda esquecida. Additive only: nullable columns without defaults (no table
-- rewrite, existing rows untouched) and new tables. The previous application version keeps
-- working on this schema, so a rollback of the code does not need a rollback of the data.
ALTER TABLE requests ADD COLUMN template text CHECK(template IN ('implantacao','manutencao'));
ALTER TABLE requests ADD COLUMN follow_up_on date;
ALTER TABLE requests ADD COLUMN blocked_reason text CHECK(length(blocked_reason) BETWEEN 1 AND 2000);
ALTER TABLE requests ADD COLUMN waiting_on text CHECK(waiting_on IN ('client','internal','third_party'));
CREATE INDEX requests_open_followup_idx ON requests(organization_id,follow_up_on) WHERE status<>'done';

-- Written by trigger in the same transaction as the change: no code path can skip it and no
-- automation failure can lose it.
CREATE TABLE request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  changes text[] NOT NULL CHECK(cardinality(changes)>0),
  from_status text,
  to_status text NOT NULL,
  owner_user_id uuid,
  follow_up_on date,
  version integer NOT NULL,
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(request_id,organization_id) REFERENCES requests(id,organization_id)
);
CREATE INDEX request_events_request_idx ON request_events(organization_id,request_id,occurred_at);
CREATE FUNCTION forbid_request_event_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Request history is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER request_event_immutable BEFORE UPDATE OR DELETE ON request_events FOR EACH ROW EXECUTE FUNCTION forbid_request_event_rewrite();

-- Persistent queue. dedupe_key makes every enqueue idempotent.
CREATE TABLE automation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK(kind IN ('evaluate_request','sweep')),
  request_id uuid,
  dedupe_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text CHECK(length(last_error)<=200),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(organization_id,dedupe_key),
  FOREIGN KEY(request_id,organization_id) REFERENCES requests(id,organization_id)
);
CREATE INDEX automation_jobs_ready_idx ON automation_jobs(next_attempt_at) WHERE state IN ('queued','running');

-- One open alert per demand and condition: a repeated sweep can never notify twice. A new
-- episode of the same condition is a new row, after the previous one was resolved.
CREATE TABLE demand_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('no_owner','overdue','client_delay','over_hours','no_coverage','stalled','blocked','no_follow_up')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  FOREIGN KEY(request_id,organization_id) REFERENCES requests(id,organization_id)
);
CREATE UNIQUE INDEX demand_alerts_one_open ON demand_alerts(request_id,kind) WHERE resolved_at IS NULL;
CREATE INDEX demand_alerts_org_open_idx ON demand_alerts(organization_id) WHERE resolved_at IS NULL;

CREATE FUNCTION record_request_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed text[] := '{}';
BEGIN
  IF TG_OP='INSERT' THEN
    changed := ARRAY['created'];
  ELSE
    IF NEW.status IS DISTINCT FROM OLD.status THEN changed := array_append(changed,'status'); END IF;
    IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN changed := array_append(changed,'owner'); END IF;
    IF NEW.follow_up_on IS DISTINCT FROM OLD.follow_up_on THEN changed := array_append(changed,'follow_up'); END IF;
    IF NEW.next_action IS DISTINCT FROM OLD.next_action THEN changed := array_append(changed,'next_action'); END IF;
    IF NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason OR NEW.waiting_on IS DISTINCT FROM OLD.waiting_on THEN changed := array_append(changed,'blocked'); END IF;
    IF NEW.scope_item_id IS DISTINCT FROM OLD.scope_item_id THEN changed := array_append(changed,'coverage'); END IF;
    IF cardinality(changed)=0 THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO request_events(organization_id,request_id,changes,from_status,to_status,owner_user_id,follow_up_on,version,actor_user_id)
  VALUES(NEW.organization_id,NEW.id,changed,CASE WHEN TG_OP='UPDATE' THEN OLD.status END,NEW.status,NEW.owner_user_id,NEW.follow_up_on,NEW.version,NULLIF(current_setting('catus.actor_user_id',true),'')::uuid);
  INSERT INTO automation_jobs(organization_id,kind,request_id,dedupe_key)
  VALUES(NEW.organization_id,'evaluate_request',NEW.id,'request:'||NEW.id||':'||NEW.version)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER request_change_events AFTER INSERT OR UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION record_request_change();
