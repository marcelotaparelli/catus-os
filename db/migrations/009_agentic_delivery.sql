CREATE TABLE delivery_policies (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 settings jsonb NOT NULL, approved_by uuid NOT NULL REFERENCES users(id), approved_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,organization_id), UNIQUE(id,organization_id),
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id)
);
CREATE TABLE delivery_specs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, request_id uuid NOT NULL, revision integer NOT NULL,
 task_type text NOT NULL CHECK(task_type='nuvemshop-theme'), specification text NOT NULL, acceptance text NOT NULL,
 data_scope text NOT NULL CHECK(data_scope='synthetic'), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,organization_id,revision), UNIQUE(id,organization_id),
 FOREIGN KEY(request_id,organization_id) REFERENCES requests(id,organization_id)
);
CREATE TABLE delivery_report_approvals (
 report_id uuid PRIMARY KEY, organization_id uuid NOT NULL, actor_user_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(report_id,organization_id) REFERENCES economic_reports(id,organization_id)
);
CREATE TABLE delivery_runners (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id)
);
CREATE TABLE delivery_totals (
 policy_id uuid PRIMARY KEY REFERENCES delivery_policies(id), reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK(reserved_micro_usd>=0), spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK(spent_micro_usd>=0)
);
CREATE TABLE delivery_days (
 policy_id uuid NOT NULL REFERENCES delivery_policies(id), day date NOT NULL,
 reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK(reserved_micro_usd>=0), spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK(spent_micro_usd>=0), jobs integer NOT NULL DEFAULT 0,
 PRIMARY KEY(policy_id,day)
);
CREATE TABLE delivery_jobs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, request_id uuid NOT NULL, spec_id uuid NOT NULL, policy_id uuid NOT NULL,
 policy_version integer NOT NULL, report_id uuid NOT NULL, basis_hash text NOT NULL, snapshot jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','claimed','running','awaiting_review','blocked','failed','cancelled','completed')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 1), runner_id uuid REFERENCES delivery_runners(id), lease_hash text, lease_until timestamptz,
 budget_day date NOT NULL, reserved_micro_usd bigint NOT NULL CHECK(reserved_micro_usd>=0), consumed_micro_usd bigint, result jsonb, failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(spec_id), UNIQUE(id,organization_id),
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id),
 FOREIGN KEY(request_id,organization_id) REFERENCES requests(id,organization_id),
 FOREIGN KEY(spec_id,organization_id) REFERENCES delivery_specs(id,organization_id),
 FOREIGN KEY(policy_id,organization_id) REFERENCES delivery_policies(id,organization_id),
 FOREIGN KEY(report_id,organization_id) REFERENCES economic_reports(id,organization_id)
);
CREATE UNIQUE INDEX delivery_one_active_request_idx ON delivery_jobs(request_id,organization_id) WHERE state IN ('queued','claimed','running','awaiting_review');
CREATE INDEX delivery_queue_idx ON delivery_jobs(organization_id,project_id,created_at) WHERE state='queued';
CREATE TABLE delivery_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), job_id uuid, entity_id uuid NOT NULL,
 actor_user_id uuid REFERENCES users(id), actor text NOT NULL, action text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(job_id,organization_id) REFERENCES delivery_jobs(id,organization_id)
);
CREATE INDEX delivery_events_org_idx ON delivery_events(organization_id,created_at DESC,id);
CREATE TABLE delivery_reviews (
 job_id uuid PRIMARY KEY, organization_id uuid NOT NULL, actor_user_id uuid NOT NULL REFERENCES users(id),
 decision text NOT NULL CHECK(decision IN ('accepted','rejected','correction_requested')),reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(job_id,organization_id) REFERENCES delivery_jobs(id,organization_id)
);
CREATE TRIGGER delivery_spec_immutable BEFORE UPDATE OR DELETE ON delivery_specs FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
CREATE TRIGGER delivery_event_immutable BEFORE UPDATE OR DELETE ON delivery_events FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
CREATE TRIGGER delivery_review_immutable BEFORE UPDATE OR DELETE ON delivery_reviews FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
CREATE TRIGGER delivery_report_approval_immutable BEFORE UPDATE OR DELETE ON delivery_report_approvals FOR EACH ROW EXECUTE FUNCTION forbid_economic_rewrite();
