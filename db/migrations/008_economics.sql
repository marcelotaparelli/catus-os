CREATE TABLE economic_records (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), project_id uuid,
 kind text NOT NULL CHECK(kind IN ('config','rate','terms','estimate','capacity','direct_cost')),
 series_key text NOT NULL, revision integer NOT NULL CHECK(revision>0), previous_id uuid,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), valid_from date NOT NULL, valid_until date NOT NULL CHECK(valid_until>=valid_from),
 source text NOT NULL CHECK(length(source) BETWEEN 1 AND 2000), payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id), UNIQUE(organization_id,series_key,revision),
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id),
 FOREIGN KEY(previous_id,organization_id) REFERENCES economic_records(id,organization_id)
);
CREATE INDEX economics_lookup_idx ON economic_records(organization_id,kind,project_id,valid_from);
CREATE TABLE economic_decisions (
 record_id uuid PRIMARY KEY, organization_id uuid NOT NULL, decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 actor_user_id uuid NOT NULL REFERENCES users(id), actor_role text NOT NULL CHECK(actor_role IN ('manager','administrator')),
 policy_version integer NOT NULL, reason text NOT NULL, snapshot jsonb NOT NULL, decided_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(record_id,organization_id) REFERENCES economic_records(id,organization_id)
);
CREATE TABLE time_entries (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, request_id uuid NOT NULL,
 user_id uuid NOT NULL, work_date date NOT NULL, minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1440),
 comment text NOT NULL CHECK(length(comment) BETWEEN 1 AND 2000), replaces_id uuid, fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,organization_id), UNIQUE(replaces_id),
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id),
 FOREIGN KEY(request_id,organization_id) REFERENCES requests(id,organization_id),
 FOREIGN KEY(user_id,organization_id) REFERENCES memberships(user_id,organization_id),
 FOREIGN KEY(replaces_id,organization_id) REFERENCES time_entries(id,organization_id)
);
CREATE INDEX time_period_idx ON time_entries(organization_id,project_id,work_date);
CREATE TABLE time_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, entry_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('approved','rejected','reversed')),
 actor_user_id uuid NOT NULL REFERENCES users(id), actor_role text NOT NULL, reason text NOT NULL,
 snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(entry_id,organization_id) REFERENCES time_entries(id,organization_id)
);
CREATE UNIQUE INDEX time_one_decision_idx ON time_events(entry_id) WHERE action IN ('approved','rejected');
CREATE UNIQUE INDEX time_one_reversal_idx ON time_events(entry_id) WHERE action='reversed';
CREATE TABLE economic_reports (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, terms_id uuid NOT NULL,
 as_of date NOT NULL, engine_version text NOT NULL, inputs jsonb NOT NULL, result jsonb NOT NULL, input_hash text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id), FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id),
 FOREIGN KEY(terms_id,organization_id) REFERENCES economic_records(id,organization_id)
);
CREATE TABLE economic_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), entity_type text NOT NULL,
 entity_id uuid NOT NULL, action text NOT NULL, actor_user_id uuid NOT NULL REFERENCES users(id), actor_role text NOT NULL,
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX economic_events_org_idx ON economic_events(organization_id,created_at DESC,id);
-- M4 is append-only: corrections and reversals never replace evidence or historical amounts.
CREATE FUNCTION forbid_economic_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Economic history is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER economic_record_immutable BEFORE UPDATE OR DELETE ON economic_records FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
CREATE TRIGGER economic_decision_immutable BEFORE UPDATE OR DELETE ON economic_decisions FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
CREATE TRIGGER time_entry_immutable BEFORE UPDATE OR DELETE ON time_entries FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
CREATE TRIGGER time_event_immutable BEFORE UPDATE OR DELETE ON time_events FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
CREATE TRIGGER economic_report_immutable BEFORE UPDATE OR DELETE ON economic_reports FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
CREATE TRIGGER economic_event_immutable BEFORE UPDATE OR DELETE ON economic_events FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
