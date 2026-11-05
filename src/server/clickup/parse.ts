// Turns untrusted provider JSON into the few fields Catus keeps. A task that cannot be
// identified fails the whole read: skipping it would look like a removal at reconciliation.
// A single bad optional field becomes null and a counted warning, so the panel can say so.
import { ClickUpError } from './client';

export interface ParsedPerson {
  id: string;
  name: string | null;
}
export interface ParsedTask {
  id: string;
  name: string;
  url: string | null;
  parent: string | null;
  /** The list whose workflow defines the status; null when the provider does not say. */
  homeList: string | null;
  status: string;
  statusType: string;
  assignees: ParsedPerson[];
  waitingOn: string[] | null;
  dueAt: string | null;
  dueHasTime: boolean;
  startAt: string | null;
  closedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PERSON_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_MS = Date.UTC(2000, 0, 1),
  MAX_MS = Date.UTC(2100, 0, 1);
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const invalid = () => new ClickUpError('invalid_response');

export interface Warnings {
  count: number;
}
/** ClickUp documents dates as millisecond strings; some answers carry numbers. */
export function parseDate(value: unknown, warnings: Warnings): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text === 'string' && /^\d{10,16}$/.test(text)) {
    const ms = Number(text);
    if (ms >= MIN_MS && ms < MAX_MS) return new Date(ms).toISOString();
  }
  warnings.count++;
  return null;
}
function parsePeople(value: unknown, warnings: Warnings): ParsedPerson[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.count++;
    return [];
  }
  const people: ParsedPerson[] = [];
  // The documentation shows objects in one endpoint and strings in another.
  for (const item of value) {
    const raw = isObject(item) ? item.id : item;
    const id =
      typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof id !== 'string' || !PERSON_ID.test(id)) {
      warnings.count++;
      continue;
    }
    const name =
      isObject(item) && typeof item.username === 'string' && item.username
        ? item.username.slice(0, 200)
        : null;
    people.push({ id, name });
  }
  return people;
}
function parseDependencies(
  value: unknown,
  taskId: string,
  warnings: Warnings,
): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    warnings.count++;
    return null;
  }
  const waiting = new Set<string>();
  for (const item of value) {
    let other: unknown;
    if (typeof item === 'string') other = item;
    else if (isObject(item)) {
      // Each entry points both ways; only "this task depends on that one" means waiting.
      if (item.task_id !== taskId) continue;
      other = item.depends_on;
    }
    if (typeof other === 'string' && TASK_ID.test(other)) {
      if (other !== taskId) waiting.add(other);
    } else warnings.count++;
  }
  return [...waiting];
}
const safeUrl = (value: unknown, warnings: Warnings) => {
  if (value === undefined || value === null) return null;
  // Rendered as a link: only the provider's own https host, so never a javascript: URL.
  if (
    typeof value === 'string' &&
    value.length <= 500 &&
    value.startsWith('https://app.clickup.com/')
  )
    return value;
  warnings.count++;
  return null;
};
export function parseTask(
  value: unknown,
  workspaceId: string,
  warnings: Warnings,
): ParsedTask {
  if (!isObject(value) || typeof value.id !== 'string') throw invalid();
  if (!TASK_ID.test(value.id)) throw invalid();
  // One token can reach several workspaces; only the configured one enters this tenant.
  if (value.team_id !== workspaceId && String(value.team_id) !== workspaceId)
    throw new ClickUpError('workspace_mismatch');
  const status = isObject(value.status) ? value.status : {};
  const statusText =
    typeof status.status === 'string' && status.status.trim()
      ? status.status.trim().slice(0, 200)
      : null;
  const statusType =
    typeof status.type === 'string' && status.type
      ? status.type.toLowerCase().slice(0, 40)
      : null;
  if (!statusText || !statusType) warnings.count++;
  let name = '(sem nome)';
  if (typeof value.name === 'string' && value.name.trim())
    name = value.name.trim().slice(0, 500);
  else warnings.count++;
  let parent: string | null = null;
  if (typeof value.parent === 'string' && TASK_ID.test(value.parent))
    parent = value.parent;
  else if (value.parent !== null && value.parent !== undefined)
    warnings.count++;
  // Documented as {id,name,...}; a bare id is accepted too.
  let homeList: string | null = null;
  const list = isObject(value.list) ? value.list.id : value.list;
  const listId =
    typeof list === 'number' && Number.isSafeInteger(list)
      ? String(list)
      : list;
  if (typeof listId === 'string' && /^\d{1,20}$/.test(listId))
    homeList = listId;
  else if (value.list !== null && value.list !== undefined) warnings.count++;
  return {
    id: value.id,
    name,
    url: safeUrl(value.url, warnings),
    parent,
    homeList,
    status: statusText ?? '(sem status)',
    statusType: statusType ?? 'unknown',
    assignees: parsePeople(value.assignees, warnings),
    waitingOn: parseDependencies(value.dependencies, value.id, warnings),
    dueAt: parseDate(value.due_date, warnings),
    dueHasTime: value.due_date_time === true,
    startAt: parseDate(value.start_date, warnings),
    closedAt:
      parseDate(value.date_done, warnings) ??
      parseDate(value.date_closed, warnings),
    createdAt: parseDate(value.date_created, warnings),
    updatedAt: parseDate(value.date_updated, warnings),
  };
}
export function parseTaskPage(
  value: unknown,
  workspaceId: string,
  warnings: Warnings,
) {
  if (!isObject(value) || !Array.isArray(value.tasks)) throw invalid();
  const tasks = value.tasks.map((t) => parseTask(t, workspaceId, warnings));
  return {
    tasks,
    // `last_page` is documented; an empty page is also treated as the end.
    finished: value.last_page === true || tasks.length === 0,
  };
}
export function parseListName(value: unknown) {
  if (!isObject(value) || typeof value.id !== 'string') throw invalid();
  return typeof value.name === 'string' ? value.name.slice(0, 500) : null;
}
