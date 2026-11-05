-- M6.1 status scope. ClickUp statuses are defined per Space, Folder or List, so the same
-- name ("review", "on hold") can mean different things in two lists. Additive only: the
-- organization-wide mappings of 012 stay as they are and remain the fallback, and the
-- previous application version keeps reading and writing this schema unchanged.

-- The list whose workflow defines the task's status ("home list"). NULL until the next
-- read, or when the provider does not say; then the linked list it was read through is used.
ALTER TABLE clickup_tasks ADD COLUMN home_list_id text CHECK(home_list_id ~ '^[0-9]{1,20}$');

-- A mapping valid for one ClickUp list only. It wins over the organization-wide one.
CREATE TABLE clickup_list_status_mappings (
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  list_id text NOT NULL CHECK(list_id ~ '^[0-9]{1,20}$'),
  status_key text NOT NULL CHECK(length(status_key) BETWEEN 1 AND 200),
  managerial_state text NOT NULL CHECK(managerial_state IN ('not_started','in_progress','blocked','waiting_client','in_review','done')),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,list_id,status_key)
);
