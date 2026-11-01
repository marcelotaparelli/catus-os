CREATE TABLE contracts (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 project_id uuid NOT NULL, client_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 kind text NOT NULL CHECK(kind IN ('fixed_price','retainer')),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 valid_from date NOT NULL, valid_until date NOT NULL CHECK(valid_until>=valid_from),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','closed')),
 document_reference text NOT NULL CHECK(length(document_reference) BETWEEN 1 AND 2000),
 created_by uuid NOT NULL REFERENCES users(id), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id), UNIQUE(id,project_id,organization_id),
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id),
 FOREIGN KEY(client_id,organization_id) REFERENCES clients(id,organization_id)
);
CREATE INDEX contracts_project_idx ON contracts(organization_id,project_id);
CREATE TABLE commercial_policies (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 approval_roles text[] NOT NULL CHECK(cardinality(approval_roles) BETWEEN 1 AND 2 AND approval_roles <@ ARRAY['manager','administrator']::text[]),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scope_versions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), project_id uuid NOT NULL,
 contract_id uuid NOT NULL, number integer NOT NULL CHECK(number>0),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','submitted','approved','rejected','superseded')),
 previous_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL REFERENCES users(id), submitted_by uuid REFERENCES users(id), submitted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id), UNIQUE(id,project_id,organization_id), UNIQUE(project_id,organization_id,number),
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id),
 FOREIGN KEY(contract_id,project_id,organization_id) REFERENCES contracts(id,project_id,organization_id),
 FOREIGN KEY(previous_id,project_id,organization_id) REFERENCES scope_versions(id,project_id,organization_id)
);
CREATE UNIQUE INDEX scope_one_pending_idx ON scope_versions(project_id,organization_id) WHERE state IN ('draft','submitted');
CREATE UNIQUE INDEX scope_one_approved_idx ON scope_versions(project_id,organization_id) WHERE state='approved';
CREATE TABLE scope_contributors (
 scope_id uuid NOT NULL, organization_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
 PRIMARY KEY(scope_id,user_id), FOREIGN KEY(scope_id,organization_id) REFERENCES scope_versions(id,organization_id)
);
CREATE TABLE scope_items (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, scope_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 20),
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
 deliverables text NOT NULL CHECK(length(deliverables) BETWEEN 1 AND 2000),
 exclusions text NOT NULL CHECK(length(exclusions) BETWEEN 1 AND 2000),
 acceptance_criteria text NOT NULL CHECK(length(acceptance_criteria) BETWEEN 1 AND 2000),
 dependencies text NOT NULL CHECK(length(dependencies) BETWEEN 1 AND 2000),
 origin_interaction_id uuid, origin_request_id uuid,
 CHECK(origin_interaction_id IS NOT NULL OR origin_request_id IS NOT NULL),
 UNIQUE(id,organization_id), UNIQUE(scope_id,position),
 FOREIGN KEY(scope_id,organization_id) REFERENCES scope_versions(id,organization_id),
 FOREIGN KEY(origin_interaction_id,organization_id) REFERENCES interactions(id,organization_id),
 FOREIGN KEY(origin_request_id,organization_id) REFERENCES requests(id,organization_id)
);
CREATE TABLE change_requests (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 base_scope_id uuid NOT NULL, proposed_scope_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000), impact text NOT NULL CHECK(length(impact) BETWEEN 1 AND 4000),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id), UNIQUE(proposed_scope_id),
 FOREIGN KEY(base_scope_id,project_id,organization_id) REFERENCES scope_versions(id,project_id,organization_id),
 FOREIGN KEY(proposed_scope_id,project_id,organization_id) REFERENCES scope_versions(id,project_id,organization_id)
);
CREATE TABLE scope_decisions (
 scope_id uuid PRIMARY KEY, organization_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 actor_user_id uuid NOT NULL REFERENCES users(id), actor_role text NOT NULL CHECK(actor_role IN ('administrator','manager')),
 policy_version integer NOT NULL, policy_roles text[] NOT NULL,
 scope_version integer NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000), decided_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(scope_id,organization_id) REFERENCES scope_versions(id,organization_id)
);
CREATE TABLE commercial_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 entity_type text NOT NULL CHECK(entity_type IN ('contract','scope','change_request','coverage','commercial_policy')),
 entity_id uuid NOT NULL, action text NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES users(id), actor_role text NOT NULL,
 before_data jsonb, after_data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commercial_events_org_idx ON commercial_events(organization_id,created_at DESC,id);
ALTER TABLE requests ADD COLUMN scope_item_id uuid;
ALTER TABLE requests ADD FOREIGN KEY(scope_item_id,organization_id) REFERENCES scope_items(id,organization_id);
CREATE INDEX requests_scope_item_idx ON requests(scope_item_id) WHERE scope_item_id IS NOT NULL;
-- Protect versioned content even against accidental writes from future modules.
CREATE FUNCTION guard_scope_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Scope history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','version','submitted_by','submitted_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','submitted_by','submitted_at']) AND OLD.state<>'draft' THEN
  RAISE EXCEPTION 'Submitted scope content is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.state<>'draft' AND (NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) THEN RAISE EXCEPTION 'Submission is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.state<>OLD.state AND NOT ((OLD.state='draft' AND NEW.state='submitted') OR (OLD.state='submitted' AND NEW.state IN ('approved','rejected')) OR (OLD.state='approved' AND NEW.state='superseded')) THEN
  RAISE EXCEPTION 'Invalid scope transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scope_version_guard BEFORE UPDATE OR DELETE ON scope_versions FOR EACH ROW EXECUTE FUNCTION guard_scope_version();
CREATE FUNCTION guard_scope_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; st text;
BEGIN
 sid:=CASE WHEN TG_OP='DELETE' THEN OLD.scope_id ELSE NEW.scope_id END;
 SELECT state INTO st FROM scope_versions WHERE id=sid FOR UPDATE;
 IF st<>'draft' THEN RAISE EXCEPTION 'Scope items are immutable after submission' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Replace items only in a draft' USING ERRCODE='23514'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER scope_item_guard BEFORE INSERT OR UPDATE OR DELETE ON scope_items FOR EACH ROW EXECUTE FUNCTION guard_scope_item();
CREATE FUNCTION guard_contract_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'draft' AND (to_jsonb(NEW)-ARRAY['state','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','updated_at']) THEN RAISE EXCEPTION 'Activated contract terms are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.state<>OLD.state AND NOT ((OLD.state='draft' AND NEW.state IN ('active','closed')) OR (OLD.state='active' AND NEW.state='closed')) THEN RAISE EXCEPTION 'Invalid contract transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contract_terms_guard BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION guard_contract_terms();
