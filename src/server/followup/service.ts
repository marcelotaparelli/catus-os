// The queue is computed from the current data on every read, so it stays correct even when
// the automation is stopped; automation only adds alerts that do not repeat.
import type { PoolClient } from 'pg';
import { InputError, uuid } from '../../shared/domain';
import type { Status } from '../../shared/domain';
import { WIP_LIMIT } from '../../shared/followup';
import type {
  FollowupQueue,
  FollowupSummary,
  QueueItem,
} from '../../shared/followup';
import { audit, authorize } from '../auth/policy';
import type { Context } from '../auth/policy';
import { allRecords, current, times } from '../economics/service';
import { HttpError } from '../errors';
import { assess, concerns, visibleTo } from './rules';
import type { DemandFacts } from './rules';

const utcToday = () => new Date().toISOString().slice(0, 10);
export type Row = DemandFacts & {
  title: string;
  owner: string;
  next_action: string;
  version: number;
  project_id: string;
  project_name: string;
  client_name: string;
};

/** Facts of open demands, or of one demand in any state. Includes approved estimates and hours. */
export async function loadFacts(
  db: PoolClient,
  organizationId: string,
  requestId?: string,
): Promise<Row[]> {
  const scope = { db, organizationId } as Context;
  const { rows } = await db.query(
    `SELECT r.id,r.title,r.status,r.template,r.owner_user_id,COALESCE(u.display_name,r.owner) owner,r.next_action,r.version,r.updated_at,r.follow_up_on::text,r.blocked_reason,r.waiting_on,
 p.id project_id,p.name project_name,c.name client_name,
 COALESCE(u.active AND m.active,false) owner_active,
 COALESCE(s.state='approved' AND ct.state='active' AND (now() AT TIME ZONE 'UTC')::date BETWEEN ct.valid_from AND ct.valid_until,false) covered
 FROM requests r JOIN interactions i ON i.id=r.interaction_id AND i.organization_id=r.organization_id JOIN projects p ON p.id=i.project_id AND p.organization_id=i.organization_id JOIN clients c ON c.id=p.client_id AND c.organization_id=p.organization_id
 LEFT JOIN users u ON u.id=r.owner_user_id LEFT JOIN memberships m ON m.user_id=r.owner_user_id AND m.organization_id=r.organization_id
 LEFT JOIN scope_items si ON si.id=r.scope_item_id AND si.organization_id=r.organization_id LEFT JOIN scope_versions s ON s.id=si.scope_id AND s.organization_id=si.organization_id AND s.project_id=p.id LEFT JOIN contracts ct ON ct.id=s.contract_id AND ct.organization_id=s.organization_id
 WHERE r.organization_id=$1 AND ($2::uuid IS NOT NULL AND r.id=$2 OR $2::uuid IS NULL AND r.status<>'done')
 ORDER BY r.updated_at,r.id LIMIT 500`,
    [organizationId, requestId ?? null],
  );
  if (!rows.length) return [];
  const estimates = current(await allRecords(scope)).filter(
      (r) => r.kind === 'estimate',
    ),
    entries = await times(scope);
  return rows.map((r) => {
    // Same base as the overview: estimates of the latest validity period of this demand.
    const own = estimates.filter((e) => e.payload.request_id === r.id),
      latest = own
        .map((e) => e.valid_until)
        .sort()
        .at(-1),
      base = own.filter((e) => e.valid_until === latest);
    return {
      ...r,
      planned_minutes: base.length
        ? base.reduce((a, e) => a + Number(e.payload.planned_minutes), 0)
        : null,
      logged_minutes: entries
        .filter(
          (t) =>
            t.request_id === r.id && ['approved', 'pending'].includes(t.state),
        )
        .reduce((a, t) => a + t.minutes, 0),
    };
  });
}

function buildItems(
  ctx: Context,
  rows: Row[],
  alerts: Map<string, { acknowledged: boolean }>,
) {
  const today = utcToday(),
    now = new Date();
  const items: QueueItem[] = [];
  for (const r of rows) {
    const isOwner = r.owner_user_id === ctx.userId;
    // A developer reads only the work assigned to them.
    if (ctx.role === 'developer' && !isOwner) continue;
    const signals = assess(r, today, now)
      .filter((s) => visibleTo(s.kind, ctx.role, r.status))
      .map((s) => ({
        ...s,
        is_new: alerts.get(`${r.id}:${s.kind}`)?.acknowledged === false,
      }));
    const forMe =
      isOwner || signals.some((s) => concerns(s.kind, ctx.role, isOwner));
    if (!forMe && !signals.length) continue;
    items.push({
      id: r.id,
      title: r.title,
      client_name: r.client_name,
      project_name: r.project_name,
      project_id: r.project_id,
      status: r.status,
      template: r.template,
      owner: r.owner,
      owner_user_id: r.owner_user_id,
      next_action: r.next_action,
      follow_up_on: r.follow_up_on,
      blocked_reason: r.blocked_reason,
      waiting_on: r.waiting_on,
      version: r.version,
      for_me: forMe,
      signals,
    });
  }
  return items.sort(
    (a, b) =>
      Number(b.for_me) - Number(a.for_me) ||
      (a.signals[0]?.rank ?? 99) - (b.signals[0]?.rank ?? 99) ||
      (a.follow_up_on ?? '9999').localeCompare(b.follow_up_on ?? '9999'),
  );
}
async function openAlerts(ctx: Context) {
  const { rows } = await ctx.db.query(
    'SELECT id,request_id,kind,acknowledged_at FROM demand_alerts WHERE organization_id=$1 AND resolved_at IS NULL',
    [ctx.organizationId],
  );
  return rows as {
    id: string;
    request_id: string;
    kind: string;
    acknowledged_at: Date | null;
  }[];
}
const alertMap = (rows: Awaited<ReturnType<typeof openAlerts>>) =>
  new Map(
    rows.map((a) => [
      `${a.request_id}:${a.kind}`,
      { acknowledged: !!a.acknowledged_at },
    ]),
  );
const myNewAlerts = (ctx: Context, items: QueueItem[]) =>
  items
    .filter((i) => i.for_me)
    .flatMap((i) =>
      i.signals
        .filter(
          (s) =>
            s.is_new &&
            concerns(s.kind, ctx.role, i.owner_user_id === ctx.userId),
        )
        .map((s) => `${i.id}:${s.kind}`),
    );

export async function followupQueue(ctx: Context): Promise<FollowupQueue> {
  authorize(ctx, 'read');
  const rows = await loadFacts(ctx.db, ctx.organizationId),
    items = buildItems(ctx, rows, alertMap(await openAlerts(ctx))),
    result: FollowupQueue = {
      as_of: utcToday(),
      items,
      new_alerts: myNewAlerts(ctx, items).length,
    };
  if (ctx.role === 'developer') return result;
  const running = new Map<string, { name: string; in_progress: number }>();
  for (const r of rows)
    if (r.status === 'in_progress' && r.owner_user_id) {
      const person = running.get(r.owner_user_id) ?? {
        name: r.owner,
        in_progress: 0,
      };
      person.in_progress++;
      running.set(r.owner_user_id, person);
    }
  result.overloaded = [...running.values()].filter(
    (p) => p.in_progress > WIP_LIMIT,
  );
  if (ctx.role === 'po') return result;
  result.stage_times = (
    await ctx.db.query(
      `WITH moves AS (SELECT to_status status,occurred_at,lead(occurred_at) OVER (PARTITION BY request_id ORDER BY occurred_at,version) left_at FROM request_events WHERE organization_id=$1 AND from_status IS DISTINCT FROM to_status)
 SELECT status,count(*)::int AS count,round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM left_at-occurred_at)/60))::int median_minutes FROM moves WHERE left_at IS NOT NULL GROUP BY status`,
      [ctx.organizationId],
    )
  ).rows as { status: Status; count: number; median_minutes: number }[];
  const health = (
    await ctx.db.query(
      `SELECT (SELECT max(finished_at) FROM automation_jobs WHERE organization_id=$1 AND kind='sweep' AND state='done') last_sweep_at,
 (SELECT count(*)::int FROM automation_jobs WHERE organization_id=$1 AND state='queued' AND attempts>0) retrying,
 (SELECT count(*)::int FROM automation_jobs WHERE organization_id=$1 AND state='failed') failed`,
      [ctx.organizationId],
    )
  ).rows[0];
  result.automation = {
    last_sweep_at: health.last_sweep_at?.toISOString() ?? null,
    late:
      !health.last_sweep_at ||
      Date.now() - health.last_sweep_at.getTime() > 15 * 60000,
    retrying: health.retrying,
    failed: health.failed,
  };
  return result;
}

export async function followupSummary(ctx: Context): Promise<FollowupSummary> {
  const items = buildItems(
    ctx,
    await loadFacts(ctx.db, ctx.organizationId),
    alertMap(await openAlerts(ctx)),
  );
  return {
    for_me: items.filter((i) => i.for_me && i.signals.length).length,
    new_alerts: myNewAlerts(ctx, items).length,
  };
}

/** Marks as seen only the alerts that concern this person. The condition stays in the queue. */
async function acknowledge(ctx: Context) {
  const items = buildItems(
      ctx,
      await loadFacts(ctx.db, ctx.organizationId),
      alertMap(await openAlerts(ctx)),
    ),
    mine = new Set(myNewAlerts(ctx, items)),
    ids = (await openAlerts(ctx))
      .filter(
        (a) => !a.acknowledged_at && mine.has(`${a.request_id}:${a.kind}`),
      )
      .map((a) => a.id);
  if (ids.length) {
    await ctx.db.query(
      'UPDATE demand_alerts SET acknowledged_at=now(),acknowledged_by=$3 WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND acknowledged_at IS NULL',
      [ctx.organizationId, ids, ctx.userId],
    );
    await audit(ctx, 'demand_alerts', ctx.userId, `acknowledged:${ids.length}`);
  }
  return { acknowledged: ids.length };
}

async function timeline(ctx: Context, id: string) {
  const requestId = uuid(id);
  const owner = (
    await ctx.db.query(
      'SELECT owner_user_id FROM requests WHERE id=$1 AND organization_id=$2',
      [requestId, ctx.organizationId],
    )
  ).rows[0];
  if (!owner) throw new HttpError(404, 'Solicitação não encontrada');
  if (ctx.role === 'developer' && owner.owner_user_id !== ctx.userId)
    throw new HttpError(403, 'Operação não permitida');
  return (
    await ctx.db.query(
      `SELECT e.changes,e.from_status,e.to_status,e.follow_up_on::text,e.version,e.occurred_at,o.display_name owner,a.display_name actor
 FROM request_events e LEFT JOIN users o ON o.id=e.owner_user_id LEFT JOIN users a ON a.id=e.actor_user_id
 WHERE e.organization_id=$1 AND e.request_id=$2 ORDER BY e.occurred_at,e.version`,
      [ctx.organizationId, requestId],
    )
  ).rows;
}

export async function followupRoute(
  ctx: Context,
  path: string,
  method: string,
): Promise<unknown | undefined> {
  if (path === '/api/followup' && method === 'GET') return followupQueue(ctx);
  if (path === '/api/followup/alerts/ack') {
    if (method !== 'POST') throw new InputError('Use POST');
    authorize(ctx, 'read');
    return acknowledge(ctx);
  }
  const events = /^\/api\/followup\/([^/]+)\/events$/.exec(path);
  if (events && method === 'GET') {
    authorize(ctx, 'read');
    return timeline(ctx, events[1]!);
  }
  return undefined;
}
