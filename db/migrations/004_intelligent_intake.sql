CREATE TABLE ai_policies (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 enabled boolean NOT NULL DEFAULT false,
 policy_reference text NOT NULL CHECK(length(policy_reference) BETWEEN 1 AND 500),
 data_scope text NOT NULL CHECK(data_scope IN ('synthetic','authorized_client')),
 daily_budget_micro_usd bigint NOT NULL CHECK(daily_budget_micro_usd BETWEEN 1 AND 100000000),
 per_job_budget_micro_usd bigint NOT NULL CHECK(per_job_budget_micro_usd BETWEEN 1 AND 10000000),
 daily_job_limit int NOT NULL CHECK(daily_job_limit BETWEEN 1 AND 100),
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(updated_by,organization_id) REFERENCES memberships(user_id,organization_id)
);
CREATE TABLE ai_budget_days (
 organization_id uuid NOT NULL REFERENCES organizations(id), day date NOT NULL,
 reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK(reserved_micro_usd>=0),
 spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK(spent_micro_usd>=0),
 jobs int NOT NULL DEFAULT 0 CHECK(jobs>=0), PRIMARY KEY(organization_id,day)
);
CREATE TABLE extraction_jobs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, interaction_id uuid NOT NULL,
 project_id uuid NOT NULL, requested_by uuid NOT NULL, idempotency_key uuid NOT NULL,
 request_hash text NOT NULL, source_text text NOT NULL, source_hash text NOT NULL,
 data_scope text NOT NULL CHECK(data_scope IN ('synthetic','authorized_client')),
 policy_reference text NOT NULL, provider_config jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')),
 attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1),
 budget_day date NOT NULL, reserved_micro_usd bigint NOT NULL CHECK(reserved_micro_usd>=0),
 consumed_micro_usd bigint, estimated_cost_micro_usd bigint,
 input_tokens int, output_tokens int, latency_ms int, failure_code text,
 result jsonb, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(id,organization_id), UNIQUE(organization_id,requested_by,idempotency_key),
 FOREIGN KEY(interaction_id,organization_id) REFERENCES interactions(id,organization_id),
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id),
 FOREIGN KEY(requested_by,organization_id) REFERENCES memberships(user_id,organization_id),
 FOREIGN KEY(organization_id,budget_day) REFERENCES ai_budget_days(organization_id,day)
);
CREATE UNIQUE INDEX one_active_extraction_idx ON extraction_jobs(organization_id,interaction_id) WHERE state IN ('queued','running');
CREATE INDEX extraction_queue_idx ON extraction_jobs(created_at) WHERE state='queued';
CREATE TABLE ai_proposals (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, extraction_id uuid NOT NULL,
 title text NOT NULL, description text NOT NULL, acceptance_criteria jsonb NOT NULL,
 evidence jsonb NOT NULL, duplicates jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','accepted','rejected')),
 version int NOT NULL DEFAULT 1 CHECK(version>=1), request_id uuid,
 UNIQUE(id,organization_id), UNIQUE(request_id),
 CHECK((state='accepted')=(request_id IS NOT NULL)),
 FOREIGN KEY(extraction_id,organization_id) REFERENCES extraction_jobs(id,organization_id),
 FOREIGN KEY(request_id,organization_id) REFERENCES requests(id,organization_id)
);
CREATE INDEX ai_proposals_job_idx ON ai_proposals(organization_id,extraction_id);
CREATE TABLE proposal_reviews (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, proposal_id uuid NOT NULL,
 actor_user_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('edited','rejected','accepted')),
 before_snapshot jsonb NOT NULL, after_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(proposal_id,organization_id) REFERENCES ai_proposals(id,organization_id),
 FOREIGN KEY(actor_user_id,organization_id) REFERENCES memberships(user_id,organization_id)
);
ALTER TABLE requests ADD COLUMN origin_proposal_id uuid UNIQUE;
ALTER TABLE requests ADD COLUMN suggested_acceptance_criteria jsonb;
ALTER TABLE requests ADD FOREIGN KEY(origin_proposal_id,organization_id) REFERENCES ai_proposals(id,organization_id);
