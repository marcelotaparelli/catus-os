import type { EconomicsResult } from '../../shared/economics';
import { roundRatio } from './engine';
export function clientRollups(
  rows: {
    id: string;
    project_id: string;
    inputs: { client_id: string };
    result: EconomicsResult;
  }[],
) {
  // Rows newest-first. Never aggregate repeated observations or different currencies/competencies.
  const selected = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = JSON.stringify([
      r.project_id,
      r.result.currency,
      r.result.period_from,
      r.result.period_until,
    ]);
    if (!selected.has(k)) selected.set(k, r);
  }
  const groups = new Map<string, typeof rows>();
  for (const r of selected.values()) {
    const k = JSON.stringify([
      r.inputs.client_id,
      r.result.currency,
      r.result.period_from,
      r.result.period_until,
    ]);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((rs) => {
    const first = rs[0]!,
      sum = (
        key:
          | 'contracted_revenue'
          | 'recognized_revenue'
          | 'eac'
          | 'realized_cost'
          | 'projected_revenue',
      ) =>
        rs.every((r) => r.result[key] !== null)
          ? rs.reduce((n, r) => n + BigInt(r.result[key]!), 0n)
          : null;
    const revenue = sum('projected_revenue'),
      eac = sum('eac'),
      recognized = sum('recognized_revenue'),
      actual = sum('realized_cost');
    const pm = rs.flatMap((r) =>
        r.result.projection_missing.map((m) => r.project_id + ': ' + m),
      ),
      am = rs.flatMap((r) =>
        r.result.actual_missing.map((m) => r.project_id + ': ' + m),
      );
    const margin =
        pm.length === 0 && revenue !== null && eac !== null
          ? revenue - eac
          : null,
      realized =
        am.length === 0 && recognized !== null && actual !== null
          ? recognized - actual
          : null;
    return {
      client_id: first.inputs.client_id,
      currency: first.result.currency,
      period_from: first.result.period_from,
      period_until: first.result.period_until,
      report_ids: rs.map((r) => r.id),
      contracted_revenue: sum('contracted_revenue')!.toString(),
      eac: eac?.toString() ?? null,
      projected_margin: margin?.toString() ?? null,
      projected_margin_bps:
        margin !== null && revenue !== null && revenue > 0n
          ? roundRatio(margin * 10000n, revenue).toString()
          : null,
      realized_margin: realized?.toString() ?? null,
      projection_missing: pm,
      actual_missing: am,
    };
  });
}
