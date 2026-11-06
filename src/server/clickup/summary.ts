// Pure: from stored rows to what the panel shows. Nothing here estimates or extrapolates.
import type {
  ExecutionAttention,
  ExecutionCounts,
  ExecutionFreshness,
  ExecutionLink,
  ExecutionOwner,
  ExecutionSituation,
  ExecutionUnmapped,
  ManagerialState,
  ProjectExecution,
} from '../../shared/clickup';

export const STALE_AFTER_MINUTES = 60;
const ATTENTION_LIMIT = 10;
export interface TaskRow {
  task_id: string;
  name: string;
  url: string | null;
  parent_task_id: string | null;
  status_raw: string;
  status_type: string;
  assignee_ids: string[];
  waiting_on: string[] | null;
  due_at: string | Date | null;
  due_has_time: boolean;
  /**
   * Lists whose workflow may define the status: the home list when known, otherwise every
   * linked list of the project the task was read through.
   */
  status_lists: string[];
  /** The top-level task a task link follows: the project itself, not an activity. */
  is_root?: boolean;
}
export interface StatusMappings {
  organization: Map<string, ManagerialState>;
  /** list id → status key → state. Wins over the organization-wide mapping. */
  lists: Map<string, Map<string, ManagerialState>>;
}
export const statusKey = (status: string) => status.trim().toLowerCase();
/**
 * The same name can mean different things in two lists. A list mapping wins over the
 * organization one; when the home list is unknown and the candidate lists disagree, the
 * status stays unmapped instead of picking one.
 */
export function stateFor(t: TaskRow, m: StatusMappings) {
  const key = statusKey(t.status_raw);
  const states = new Set(
    (t.status_lists.length ? t.status_lists : [null]).map(
      (l) =>
        (l !== null && m.lists.get(l)?.get(key)) || m.organization.get(key),
    ),
  );
  return states.size === 1 ? [...states][0] : undefined;
}
const isClosed = (t: TaskRow) => ['closed', 'done'].includes(t.status_type);
/**
 * A due date without a time has no known timezone in the data, so it only counts as late
 * after a full day has passed: never accuse a task that may still be on time.
 */
export function isOverdue(t: TaskRow, now: Date) {
  if (!t.due_at || isClosed(t)) return false;
  const due = new Date(t.due_at).getTime();
  return (t.due_has_time ? due : due + 86400000) < now.getTime();
}
export function freshnessOf(links: ExecutionLink[], now: Date) {
  if (!links.length) return 'not_linked' as ExecutionFreshness;
  if (links.some((l) => !l.last_success_at))
    return 'never_synced' as ExecutionFreshness;
  if (links.some((l) => l.last_error_code))
    return 'failing' as ExecutionFreshness;
  const limit = now.getTime() - STALE_AFTER_MINUTES * 60000;
  return (
    links.some((l) => new Date(l.last_success_at!).getTime() < limit)
      ? 'stale'
      : 'fresh'
  ) as ExecutionFreshness;
}
export function summarize(
  links: ExecutionLink[],
  all: TaskRow[],
  mappings: StatusMappings,
  people: Map<string, string>,
  extra: { removed_from_lists: number; data_warnings: number },
  now: Date,
): ProjectExecution {
  const freshness = freshnessOf(links, now);
  const successes = links
    .map((l) => l.last_success_at)
    .filter((v): v is string => !!v)
    .sort();
  // A list never read means the total is unknown: partial counts would read as the truth.
  if (freshness === 'not_linked' || freshness === 'never_synced')
    return {
      freshness,
      last_sync_at: successes[0] ?? null,
      situation: 'unavailable',
      links,
      roots: [],
      activity_statuses: [],
      counts: null,
      owners: [],
      attention: [],
      unmapped_statuses: [],
      removed_from_lists: 0,
      data_warnings: 0,
    };
  // The root of a task link is the project: shown apart, never counted as an activity, and
  // its status says nothing about how far the activities are.
  const roots = all.filter((t) => t.is_root),
    tasks = all.filter((t) => !t.is_root),
    rootIds = new Set(roots.map((t) => t.task_id));
  const open = tasks.filter((t) => !isClosed(t));
  const stateOf = (t: TaskRow) => stateFor(t, mappings);
  // Grouped by the list that would own the mapping; null when that list is ambiguous.
  const listNames = new Map(links.map((l) => [l.list_id, l.list_name]));
  for (const r of roots) {
    const l = links.find((l) => l.task_id === r.task_id);
    if (l && r.status_lists.length === 1)
      listNames.set(r.status_lists[0]!, l.list_name);
  }
  const unmapped = new Map<string, ExecutionUnmapped>();
  let activitiesUnmapped = false;
  for (const t of [...open, ...roots.filter((r) => !isClosed(r))])
    if (!stateOf(t)) {
      activitiesUnmapped ||= !t.is_root;
      const list = t.status_lists.length === 1 ? t.status_lists[0]! : null;
      const id = list + '\u0000' + t.status_raw;
      const u = unmapped.get(id) ?? {
        status: t.status_raw,
        tasks: 0,
        list_id: list,
        list_name: list && (listNames.get(list) ?? null),
      };
      u.tasks++;
      unmapped.set(id, u);
    }
  const known = new Map(all.map((t) => [t.task_id, t]));
  const countState = (state: ManagerialState) => {
    const n = open.filter((t) => stateOf(t) === state).length;
    // Zero while some statuses are unmapped would claim something nobody knows.
    return n === 0 && activitiesUnmapped ? null : n;
  };
  // Directly under a root, an activity is a task of the project, not a subtask.
  const topLevel = (t: TaskRow) =>
    !t.parent_task_id || rootIds.has(t.parent_task_id);
  const waitingDependency = open.some((t) => t.waiting_on === null)
    ? null
    : open.filter((t) =>
        t.waiting_on!.some((id) => {
          const other = known.get(id);
          return !other || !isClosed(other);
        }),
      ).length;
  const dues = open
    .map((t) => (t.due_at ? new Date(t.due_at).toISOString() : null))
    .filter((d): d is string => !!d && d >= now.toISOString())
    .sort();
  const overdue = open.filter((t) => isOverdue(t, now));
  const counts: ExecutionCounts = {
    tasks_open: open.filter(topLevel).length,
    tasks_closed: tasks.filter((t) => isClosed(t) && topLevel(t)).length,
    subtasks_open: open.filter((t) => !topLevel(t)).length,
    subtasks_closed: tasks.filter((t) => isClosed(t) && !topLevel(t)).length,
    overdue: overdue.length,
    without_due_date: open.filter((t) => !t.due_at).length,
    next_due_at: dues[0] ?? null,
    unassigned_open: open.filter((t) => !t.assignee_ids.length).length,
    blocked: countState('blocked'),
    waiting_client: countState('waiting_client'),
    waiting_dependency: waitingDependency,
  };
  const name = (id: string) => people.get(id) ?? 'Pessoa sem nome no ClickUp';
  const byOwner = new Map<string, ExecutionOwner>();
  for (const t of open)
    for (const id of t.assignee_ids) {
      const o = byOwner.get(id) ?? { name: name(id), open: 0, overdue: 0 };
      o.open++;
      if (isOverdue(t, now)) o.overdue++;
      byOwner.set(id, o);
    }
  const attention = open
    .map((t): ExecutionAttention => {
      const state = stateOf(t),
        reasons: ExecutionAttention['reasons'] = [];
      if (state === 'blocked') reasons.push('blocked');
      if (state === 'waiting_client') reasons.push('waiting_client');
      if (isOverdue(t, now)) reasons.push('overdue');
      return {
        id: t.task_id,
        name: t.name,
        url: t.url,
        status: t.status_raw,
        due_at: t.due_at ? new Date(t.due_at).toISOString() : null,
        owners: t.assignee_ids.map(name),
        reasons,
      };
    })
    .filter((a) => a.reasons.length)
    .sort(
      (a, b) =>
        Number(b.reasons.includes('blocked')) -
          Number(a.reasons.includes('blocked')) ||
        (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999') ||
        a.id.localeCompare(b.id),
    )
    .slice(0, ATTENTION_LIMIT);
  const situation: ExecutionSituation = counts.blocked
    ? 'blocked'
    : counts.overdue
      ? 'overdue'
      : !tasks.length
        ? 'no_tasks'
        : !open.length
          ? 'all_closed'
          : 'no_known_delay';
  return {
    freshness,
    last_sync_at: successes[0] ?? null,
    situation,
    links,
    roots: roots.map((r) => ({
      id: r.task_id,
      name: r.name,
      url: r.url,
      status: r.status_raw,
      state: stateOf(r) ?? null,
      due_at: r.due_at ? new Date(r.due_at).toISOString() : null,
      overdue: isOverdue(r, now),
      owners: r.assignee_ids.map(name),
    })),
    activity_statuses: [
      ...tasks
        .reduce(
          (m, t) => m.set(t.status_raw, (m.get(t.status_raw) ?? 0) + 1),
          new Map<string, number>(),
        )
        .entries(),
    ]
      .map(([status, n]) => ({ status, tasks: n }))
      .sort((a, b) => b.tasks - a.tasks || a.status.localeCompare(b.status)),
    counts,
    owners: [...byOwner.values()].sort(
      (a, b) =>
        b.overdue - a.overdue ||
        b.open - a.open ||
        a.name.localeCompare(b.name),
    ),
    attention,
    unmapped_statuses: [...unmapped.values()].sort(
      (a, b) =>
        b.tasks - a.tasks ||
        a.status.localeCompare(b.status) ||
        (a.list_id ?? '').localeCompare(b.list_id ?? ''),
    ),
    ...extra,
  };
}
