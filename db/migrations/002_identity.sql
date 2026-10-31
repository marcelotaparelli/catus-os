-- Existing M0 data is assigned to an explicit legacy organization, never discarded.
CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200));
INSERT INTO organizations VALUES ('00000000-0000-4000-8000-000000000001','Catus');
CREATE TABLE users (
 id uuid PRIMARY KEY, issuer text NOT NULL, subject text, email text NOT NULL,
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200), active boolean NOT NULL DEFAULT true,
 UNIQUE(issuer,subject), UNIQUE(issuer,email), CHECK(email=lower(email))
);
CREATE TABLE memberships (
 user_id uuid NOT NULL REFERENCES users(id), organization_id uuid NOT NULL REFERENCES organizations(id),
 role text NOT NULL CHECK(role IN ('administrator','manager','po','developer')), active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(user_id,organization_id)
);
ALTER TABLE clients ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE clients SET organization_id='00000000-0000-4000-8000-000000000001';
ALTER TABLE clients ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE clients ADD UNIQUE(id,organization_id);
ALTER TABLE projects ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE projects SET organization_id='00000000-0000-4000-8000-000000000001';
ALTER TABLE projects ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE projects ADD UNIQUE(id,organization_id);
ALTER TABLE projects ADD FOREIGN KEY(client_id,organization_id) REFERENCES clients(id,organization_id);
ALTER TABLE interactions ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE interactions SET organization_id='00000000-0000-4000-8000-000000000001';
ALTER TABLE interactions ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE interactions ADD UNIQUE(id,organization_id);
ALTER TABLE interactions ADD FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id);
ALTER TABLE requests ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE requests SET organization_id='00000000-0000-4000-8000-000000000001';
ALTER TABLE requests ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE requests ADD UNIQUE(id,organization_id);
ALTER TABLE requests ADD FOREIGN KEY(interaction_id,organization_id) REFERENCES interactions(id,organization_id);
ALTER TABLE requests ADD COLUMN owner_user_id uuid;
ALTER TABLE requests ADD FOREIGN KEY(owner_user_id,organization_id) REFERENCES memberships(user_id,organization_id);
-- Legacy owner text remains intact. Every new request must be assigned explicitly by the API.
ALTER TABLE audit_events ADD COLUMN organization_id uuid REFERENCES organizations(id);
UPDATE audit_events SET organization_id='00000000-0000-4000-8000-000000000001';
ALTER TABLE audit_events ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE audit_events ADD COLUMN actor_user_id uuid REFERENCES users(id);
ALTER TABLE audit_events ADD COLUMN entity_type text NOT NULL DEFAULT 'request';
ALTER TABLE audit_events ADD COLUMN entity_id uuid;
UPDATE audit_events SET entity_id=request_id;
ALTER TABLE audit_events ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE audit_events ALTER COLUMN request_id DROP NOT NULL;
ALTER TABLE audit_events ADD FOREIGN KEY(request_id,organization_id) REFERENCES requests(id,organization_id);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, csrf_token text NOT NULL,
 user_id uuid NOT NULL, organization_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '8 hours',
 last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 FOREIGN KEY(user_id,organization_id) REFERENCES memberships(user_id,organization_id)
);
CREATE TABLE oidc_transactions (
 state_hash text PRIMARY KEY, nonce text NOT NULL, verifier text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE INDEX clients_org_idx ON clients(organization_id);
CREATE INDEX projects_org_idx ON projects(organization_id);
CREATE INDEX interactions_org_idx ON interactions(organization_id,created_at DESC);
CREATE INDEX requests_org_idx ON requests(organization_id,updated_at DESC);
CREATE INDEX audit_org_idx ON audit_events(organization_id,created_at DESC);
CREATE INDEX sessions_user_idx ON sessions(user_id,organization_id);
