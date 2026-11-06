-- M6.1 task links. At Catus one shared ClickUp list ("Projetos") holds every client project:
-- each top-level task is a project and its subtasks are the activities. A Catus project
-- can now follow one top-level task and its descendants instead of a whole list, so the
-- other clients of that list are never requested nor stored. List links stay as they are.
--
-- Additive: two new nullable columns, and list_id stops being mandatory only for task links
-- (a check keeps exactly one of the two). Rollback to a version without task links: first
-- deactivate them (UPDATE clickup_project_links SET active=false WHERE root_task_id IS NOT
-- NULL), since that version's worker would try to read them as lists and fail.

ALTER TABLE clickup_project_links
  ADD COLUMN root_task_id text CHECK(root_task_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  ALTER COLUMN list_id DROP NOT NULL,
  ADD CONSTRAINT clickup_links_list_or_task CHECK((list_id IS NULL) <> (root_task_id IS NULL));
CREATE UNIQUE INDEX clickup_links_one_active_task ON clickup_project_links(organization_id,root_task_id) WHERE active AND root_task_id IS NOT NULL;

-- A run reads either a list or a task tree; list_name keeps the root's home list name.
ALTER TABLE clickup_sync_runs
  ADD COLUMN root_task_id text CHECK(root_task_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  ALTER COLUMN list_id DROP NOT NULL,
  ADD CONSTRAINT clickup_runs_list_or_task CHECK((list_id IS NULL) <> (root_task_id IS NULL));
