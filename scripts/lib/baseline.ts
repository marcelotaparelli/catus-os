// Linha de base de retrabalho, reaberturas, tempo de ciclo e esforço do PO, para comparar
// antes e depois de Alinhamento e Aceite. Só agregados, sem título, cliente ou pessoa.
import type { PoolClient } from 'pg';
import { allRecords, current } from '../../src/server/economics/service';
import type { Context } from '../../src/server/auth/policy';

const NOT_REVERSED = `NOT EXISTS(SELECT 1 FROM time_events e WHERE e.entry_id=t.id AND e.organization_id=t.organization_id AND e.action='reversed')`;
const median = (values: number[]) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (v: number | null) =>
  v === null ? null : Math.round(v * 100) / 100;

/** Must run inside a READ ONLY transaction: see runBaseline. */
export async function baselineFor(
  db: PoolClient,
  organizationId: string,
  since: string,
) {
  const demands = (
    await db.query(
      `SELECT r.id,COALESCE(r.template,'sem_modelo') template,
 (SELECT min(e.occurred_at) FROM request_events e WHERE e.organization_id=r.organization_id AND e.request_id=r.id AND e.to_status='done' AND e.from_status IS DISTINCT FROM 'done') first_done,
 extract(epoch FROM (SELECT min(e.occurred_at) FROM request_events e WHERE e.organization_id=r.organization_id AND e.request_id=r.id AND e.to_status='done' AND e.from_status IS DISTINCT FROM 'done')-r.created_at)/3600 cycle_hours,
 (SELECT count(*)::int FROM request_events e WHERE e.organization_id=r.organization_id AND e.request_id=r.id AND e.from_status='done' AND e.to_status<>'done') reopenings,
 (SELECT count(*)::int FROM request_events e WHERE e.organization_id=r.organization_id AND e.request_id=r.id AND 'next_action'=ANY(e.changes)) next_action_changes,
 (SELECT count(*)::int FROM request_events e WHERE e.organization_id=r.organization_id AND e.request_id=r.id AND e.to_status='blocked' AND e.from_status IS DISTINCT FROM 'blocked') blocks,
 (SELECT count(*)::int FROM request_events e JOIN memberships m ON m.user_id=e.actor_user_id AND m.organization_id=e.organization_id WHERE e.organization_id=r.organization_id AND e.request_id=r.id AND m.role='po') po_actions,
 COALESCE((SELECT sum(t.minutes)::int FROM time_entries t WHERE t.organization_id=r.organization_id AND t.request_id=r.id AND ${NOT_REVERSED}),0) minutes,
 COALESCE((SELECT sum(t.minutes)::int FROM time_entries t JOIN memberships m ON m.user_id=t.user_id AND m.organization_id=t.organization_id WHERE t.organization_id=r.organization_id AND t.request_id=r.id AND m.role='po' AND ${NOT_REVERSED}),0) po_minutes,
 (SELECT count(*)::int FROM interactions i JOIN interactions o ON o.id=r.interaction_id AND o.organization_id=r.organization_id WHERE i.organization_id=r.organization_id AND i.project_id=o.project_id AND i.occurred_at>=r.created_at AND i.occurred_at<=COALESCE((SELECT min(e.occurred_at) FROM request_events e WHERE e.organization_id=r.organization_id AND e.request_id=r.id AND e.to_status='done'),now())) contacts
 FROM requests r WHERE r.organization_id=$1 AND r.created_at>=$2::date`,
      [organizationId, since],
    )
  ).rows;
  const estimates = current(
    await allRecords({ db, organizationId } as Context),
  ).filter((e) => e.kind === 'estimate');
  const planned = (id: string) => {
    const own = estimates.filter((e) => e.payload.request_id === id),
      latest = own
        .map((e) => e.valid_until)
        .sort()
        .at(-1),
      base = own.filter((e) => e.valid_until === latest);
    return base.length
      ? base.reduce((a, e) => a + Number(e.payload.planned_minutes), 0)
      : null;
  };
  const byTemplate: Record<string, unknown> = {};
  for (const template of new Set(demands.map((d) => d.template))) {
    const all = demands.filter((d) => d.template === template),
      closed = all.filter((d) => d.first_done),
      reopened = all.filter((d) => d.reopenings > 0),
      deviation = closed.flatMap((d) => {
        const p = planned(d.id);
        return p ? [d.minutes / p] : [];
      });
    byTemplate[template] = {
      demandas: all.length,
      concluidas: closed.length,
      amostra_pequena: closed.length < 20,
      reaberturas: all.reduce((n, d) => n + d.reopenings, 0),
      taxa_retrabalho: closed.length
        ? Math.round((reopened.length / closed.length) * 1e4) / 1e4
        : null,
      ciclo_horas_mediana: round(
        median(closed.map((d) => Number(d.cycle_hours))),
      ),
      trocas_de_proxima_acao_mediana: median(
        closed.map((d) => d.next_action_changes),
      ),
      contatos_com_cliente_mediana: median(closed.map((d) => d.contacts)),
      bloqueios_mediana: median(closed.map((d) => d.blocks)),
      acoes_do_po_por_demanda_mediana: median(closed.map((d) => d.po_actions)),
      horas_do_po_por_demanda_mediana: round(
        median(closed.map((d) => d.po_minutes / 60)),
      ),
      horas_por_demanda_mediana: round(
        median(closed.map((d) => d.minutes / 60)),
      ),
      demandas_com_estimativa: deviation.length,
      horas_sobre_estimativa_mediana: round(median(deviation)),
    };
  }
  const history = (
    await db.query(
      'SELECT min(occurred_at) desde FROM request_events WHERE organization_id=$1',
      [organizationId],
    )
  ).rows[0];
  return {
    desde: since,
    // Before migration 010 nothing recorded a reopening: earlier demands count as never reopened.
    historico_de_eventos_desde: history.desde?.toISOString() ?? null,
    por_modelo: byTemplate,
  };
}

/** One organization at a time, in a transaction the database itself refuses to write in. */
export async function runBaseline(db: PoolClient, since: string) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    const orgs = (await db.query('SELECT id FROM organizations ORDER BY id'))
        .rows,
      out: Record<string, unknown> = {};
    for (const o of orgs) out[o.id] = await baselineFor(db, o.id, since);
    return out;
  } finally {
    await db.query('ROLLBACK');
  }
}
