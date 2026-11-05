// Web-side of the integration: reads what the worker stored and manages links and status
// mappings. Partners only (manager/administrator); it never calls ClickUp nor holds a token.
import { audit } from '../auth/policy';
import type { Context } from '../auth/policy';
import { HttpError } from '../errors';
import { InputError, uuid } from '../../shared/domain';
import { managerialStates } from '../../shared/clickup';
import type {
  ExecutionLink,
  ManagerialState,
  ProjectExecution,
} from '../../shared/clickup';
import type { FinancialOverview, Overview } from '../../shared/overview';
import { statusKey, summarize } from './summary';
import type { StatusMappings, TaskRow } from './summary';

const available = (ctx: Context, organizationId: string | undefined) =>
  !!organizationId && ctx.organizationId === organizationId;
const iso = (v: Date | string | null) =>
  v === null ? null : new Date(v).toISOString();

async function executionByProject(ctx: Context, now: Date) {
  const org = ctx.organizationId;
  const links = (
    await ctx.db.query(
      'SELECT id,project_id,list_id,list_name,last_success_at,last_attempt_at,last_error_code,last_data_warnings FROM clickup_project_links WHERE organization_id=$1 AND active ORDER BY created_at,id',
      [org],
    )
  ).rows;
  const byProject = new Map<string, Map<string, TaskRow>>();
  const removed = new Map<string, Set<string>>();
  const { rows: tasks } = await ctx.db.query(
    `SELECT l.project_id,l.list_id,t.home_list_id,m.missing_since,t.task_id,t.name,t.url,t.parent_task_id,t.status_raw,t.status_type,t.assignee_ids,t.waiting_on,t.due_at,t.due_has_time
 FROM clickup_list_tasks m JOIN clickup_project_links l ON l.id=m.link_id AND l.organization_id=m.organization_id
 JOIN clickup_tasks t ON t.organization_id=m.organization_id AND t.task_id=m.task_id
 WHERE m.organization_id=$1 AND l.active`,
    [org],
  );
  // A task in two lists of one project is one task. Its status belongs to its home list;
  // without one, to every linked list it was read through.
  for (const t of tasks) {
    if (t.missing_since) {
      if (!removed.has(t.project_id)) removed.set(t.project_id, new Set());
      removed.get(t.project_id)!.add(t.task_id);
      continue;
    }
    if (!byProject.has(t.project_id)) byProject.set(t.project_id, new Map());
    const live = byProject.get(t.project_id)!,
      seen = live.get(t.task_id)?.status_lists ?? [];
    live.set(t.task_id, {
      ...t,
      status_lists: t.home_list_id
        ? [t.home_list_id]
        : [...new Set([...seen, t.list_id])].sort(),
    });
  }
  const mappings: StatusMappings = {
    organization: new Map(),
    lists: new Map(),
  };
  for (const m of (
    await ctx.db.query(
      'SELECT NULL list_id,status_key,managerial_state FROM clickup_status_mappings WHERE organization_id=$1 UNION ALL SELECT list_id,status_key,managerial_state FROM clickup_list_status_mappings WHERE organization_id=$1',
      [org],
    )
  ).rows as {
    list_id: string | null;
    status_key: string;
    managerial_state: ManagerialState;
  }[]) {
    if (m.list_id === null)
      mappings.organization.set(m.status_key, m.managerial_state);
    else {
      if (!mappings.lists.has(m.list_id))
        mappings.lists.set(m.list_id, new Map());
      mappings.lists.get(m.list_id)!.set(m.status_key, m.managerial_state);
    }
  }
  const people = new Map<string, string>(
    (
      await ctx.db.query(
        'SELECT clickup_user_id,display_name FROM clickup_people WHERE organization_id=$1',
        [org],
      )
    ).rows.map((p) => [p.clickup_user_id, p.display_name]),
  );
  return (projectId: string): ProjectExecution => {
    const own = links.filter((l) => l.project_id === projectId);
    const views: ExecutionLink[] = own.map((l) => ({
      id: l.id,
      list_id: l.list_id,
      list_name: l.list_name,
      last_success_at: iso(l.last_success_at),
      last_attempt_at: iso(l.last_attempt_at),
      last_error_code: l.last_error_code,
    }));
    const live = byProject.get(projectId);
    const stillThere = (id: string) => live?.has(id) ?? false;
    return summarize(
      views,
      [...(live?.values() ?? [])],
      mappings,
      people,
      {
        removed_from_lists: [...(removed.get(projectId) ?? [])].filter(
          (id) => !stillThere(id),
        ).length,
        data_warnings: own.reduce((n, l) => n + l.last_data_warnings, 0),
      },
      now,
    );
  };
}
/** Adds execution to the partners' reading. Off or other roles: the response is untouched. */
export async function withExecution<T extends Overview>(
  ctx: Context,
  organizationId: string | undefined,
  overview: T,
  now = new Date(),
): Promise<T> {
  if (overview.kind !== 'financial' || !available(ctx, organizationId))
    return overview;
  const read = await executionByProject(ctx, now),
    financialView = overview as FinancialOverview;
  return {
    ...overview,
    projects: financialView.projects.map((p) => ({
      ...p,
      execution: read(p.project_id),
    })),
  };
}
async function createLink(ctx: Context, body: Record<string, unknown>) {
  const projectId = uuid(body.project_id);
  if (typeof body.list_id !== 'string' || !/^\d{1,20}$/.test(body.list_id))
    throw new InputError('Informe o ID numérico da lista do ClickUp');
  const { rows } = await ctx.db.query(
    'INSERT INTO clickup_project_links(organization_id,project_id,list_id,created_by) VALUES($1,$2,$3,$4) RETURNING id,project_id,list_id',
    [ctx.organizationId, projectId, body.list_id, ctx.userId],
  );
  await audit(ctx, 'clickup_link', rows[0].id, 'created');
  return rows[0];
}
async function deactivateLink(ctx: Context, id: string) {
  const { rows } = await ctx.db.query(
    'UPDATE clickup_project_links SET active=false,deactivated_at=now(),deactivated_by=$3 WHERE id=$1 AND organization_id=$2 AND active RETURNING id',
    [uuid(id), ctx.organizationId, ctx.userId],
  );
  if (!rows[0]) throw new HttpError(404, 'Vínculo não encontrado');
  await audit(ctx, 'clickup_link', id, 'deactivated');
  return { status: 'ok' };
}
async function setMapping(ctx: Context, body: Record<string, unknown>) {
  const key = typeof body.status === 'string' ? statusKey(body.status) : '';
  if (!key || key.length > 200) throw new InputError('Status inválido');
  if (!managerialStates.includes(body.state as ManagerialState))
    throw new InputError('Estado gerencial inválido');
  // Without a list: organization-wide, the fallback for every list (the M6.1 behaviour).
  if (body.list_id === undefined || body.list_id === null) {
    const { rows } = await ctx.db.query(
      `INSERT INTO clickup_status_mappings(organization_id,status_key,managerial_state,updated_by) VALUES($1,$2,$3,$4)
 ON CONFLICT(organization_id,status_key) DO UPDATE SET managerial_state=excluded.managerial_state,updated_by=excluded.updated_by,updated_at=now() RETURNING id`,
      [ctx.organizationId, key, body.state, ctx.userId],
    );
    await audit(ctx, 'clickup_status_mapping', rows[0].id, 'set:' + body.state);
    return { status: 'ok' };
  }
  // Only a list this organization knows: a linked one or the home list of a stored task.
  if (typeof body.list_id !== 'string' || !/^\d{1,20}$/.test(body.list_id))
    throw new InputError('Lista inválida');
  const known = await ctx.db.query(
    'SELECT 1 FROM clickup_project_links WHERE organization_id=$1 AND list_id=$2 UNION ALL SELECT 1 FROM clickup_tasks WHERE organization_id=$1 AND home_list_id=$2 LIMIT 1',
    [ctx.organizationId, body.list_id],
  );
  if (!known.rowCount) throw new InputError('Lista não vinculada');
  const { rows } = await ctx.db.query(
    `INSERT INTO clickup_list_status_mappings(organization_id,list_id,status_key,managerial_state,updated_by) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(organization_id,list_id,status_key) DO UPDATE SET managerial_state=excluded.managerial_state,updated_by=excluded.updated_by,updated_at=now() RETURNING id`,
    [ctx.organizationId, body.list_id, key, body.state, ctx.userId],
  );
  await audit(
    ctx,
    'clickup_list_status_mapping',
    rows[0].id,
    'set:' + body.state,
  );
  return { status: 'ok' };
}
/** undefined: not one of these routes. Off or another tenant: as if they did not exist. */
export async function clickupRoute(
  ctx: Context,
  organizationId: string | undefined,
  path: string,
  method: string,
  body?: Record<string, unknown>,
) {
  if (!path.startsWith('/api/clickup/')) return undefined;
  if (!available(ctx, organizationId))
    throw new HttpError(404, 'Rota não encontrada');
  if (!['manager', 'administrator'].includes(ctx.role))
    throw new HttpError(403, 'Disponível apenas para gestor ou administrador');
  if (method === 'GET' && path === '/api/clickup/sync-runs')
    return (
      await ctx.db.query(
        'SELECT id,link_id,source,list_id,state,started_at,finished_at,http_calls,pages,tasks_seen,tasks_inserted,tasks_updated,tasks_missing,data_warnings,error_code,http_status FROM clickup_sync_runs WHERE organization_id=$1 ORDER BY started_at DESC,id LIMIT 100',
        [ctx.organizationId],
      )
    ).rows;
  if (method === 'POST' && body) {
    if (path === '/api/clickup/links') return createLink(ctx, body);
    if (path === '/api/clickup/status-mappings') return setMapping(ctx, body);
    const off = /^\/api\/clickup\/links\/([^/]+)\/deactivate$/.exec(path);
    if (off) return deactivateLink(ctx, off[1]!);
  }
  throw new HttpError(404, 'Rota não encontrada');
}
