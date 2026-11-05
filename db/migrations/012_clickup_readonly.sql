-- M6.1, ClickUp read-only. Additive only: new tables, nothing existing is altered, so the
-- previous application version keeps working on this schema. Numbered 012 because 011 is
-- reserved by the open PR #19; the runner applies by name and neither depends on the other.
-- External tasks live here and never become rows of `requests`.

-- A ClickUp list feeding a Catus project. Worker-owned sync state sits beside the link.
CREATE TABLE clickup_project_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  list_id text NOT NULL CHECK(list_id ~ '^[0-9]{1,20}$'),
  list_name text CHECK(length(list_name)<=500),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_by uuid REFERENCES users(id),
  deactivated_at timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code text CHECK(length(last_error_code)<=40),
  last_data_warnings integer NOT NULL DEFAULT 0 CHECK(last_data_warnings>=0),
  UNIQUE(id,organization_id),
  FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id)
);
CREATE UNIQUE INDEX clickup_links_one_active_list ON clickup_project_links(organization_id,list_id) WHERE active;
CREATE INDEX clickup_links_due_idx ON clickup_project_links(organization_id,next_sync_at) WHERE active;

-- Every attempt: origin, time, result and error class. Only a code, never a provider body.
CREATE TABLE clickup_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  link_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'clickup_api_v2',
  list_id text NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','succeeded','failed')),
  lease_until timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  http_calls integer NOT NULL DEFAULT 0,
  pages integer NOT NULL DEFAULT 0,
  tasks_seen integer NOT NULL DEFAULT 0,
  tasks_inserted integer NOT NULL DEFAULT 0,
  tasks_updated integer NOT NULL DEFAULT 0,
  tasks_missing integer NOT NULL DEFAULT 0,
  data_warnings integer NOT NULL DEFAULT 0,
  error_code text CHECK(length(error_code)<=40),
  http_status integer,
  FOREIGN KEY(link_id,organization_id) REFERENCES clickup_project_links(id,organization_id)
);
CREATE UNIQUE INDEX clickup_runs_one_running ON clickup_sync_runs(link_id) WHERE state='running';
CREATE INDEX clickup_runs_org_idx ON clickup_sync_runs(organization_id,started_at DESC);

-- External people. user_id stays empty until a human links it: never matched by name.
CREATE TABLE clickup_people (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  clickup_user_id text NOT NULL CHECK(length(clickup_user_id) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK(length(display_name)<=200),
  user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,clickup_user_id),
  FOREIGN KEY(user_id,organization_id) REFERENCES memberships(user_id,organization_id)
);

-- Latest known state of each task. One row per task, however many lists contain it.
-- Descriptions, comments, custom fields and e-mails are deliberately not stored.
CREATE TABLE clickup_tasks (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  task_id text NOT NULL CHECK(task_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  name text NOT NULL CHECK(length(name)<=500),
  url text CHECK(length(url)<=500),
  parent_task_id text,
  status_raw text NOT NULL CHECK(length(status_raw)<=200),
  status_type text NOT NULL CHECK(length(status_type)<=40),
  assignee_ids text[] NOT NULL DEFAULT '{}',
  -- NULL: the provider did not say. Different from an empty array.
  waiting_on text[],
  due_at timestamptz,
  due_has_time boolean NOT NULL DEFAULT false,
  start_at timestamptz,
  closed_at timestamptz,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,task_id)
);

-- Which list shows which task. missing_since is the reconciliation: set only by a complete
-- read that no longer returned the task, cleared if it returns. Nothing is deleted.
CREATE TABLE clickup_list_tasks (
  organization_id uuid NOT NULL,
  link_id uuid NOT NULL,
  task_id text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id uuid NOT NULL,
  missing_since timestamptz,
  PRIMARY KEY(link_id,task_id),
  FOREIGN KEY(link_id,organization_id) REFERENCES clickup_project_links(id,organization_id),
  FOREIGN KEY(organization_id,task_id) REFERENCES clickup_tasks(organization_id,task_id)
);
CREATE INDEX clickup_list_tasks_task_idx ON clickup_list_tasks(organization_id,task_id);

-- Explicit translation of a free-form status into a managerial state. Without a row the
-- status stays unmapped and the panel says so; nothing is guessed from its name.
CREATE TABLE clickup_status_mappings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  status_key text NOT NULL CHECK(length(status_key) BETWEEN 1 AND 200),
  managerial_state text NOT NULL CHECK(managerial_state IN ('not_started','in_progress','blocked','waiting_client','in_review','done')),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,status_key)
);
