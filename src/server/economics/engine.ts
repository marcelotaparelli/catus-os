import type { EconomicsInput, EconomicsResult } from '../../shared/economics';
export const ENGINE_VERSION = 'm4.1';
export function roundRatio(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('Positive denominator required');
  const sign = n < 0n ? -1n : 1n,
    a = n < 0n ? -n : n;
  return sign * ((a + d / 2n) / d);
}
export function laborCost(minutes: number, rate: string): string {
  return roundRatio(BigInt(minutes) * BigInt(rate), 60n).toString();
}
export function calculate(x: EconomicsInput): EconomicsResult {
  const pm = new Set(x.projection_missing),
    am = new Set(x.actual_missing),
    alerts = new Set(x.alerts);
  if (!x.config) {
    pm.add('configuração econômica/tributos/overhead');
    am.add('configuração econômica/tributos/overhead');
  }
  if (!x.time_entries_complete) {
    pm.add('declaração de apontamentos completos');
    am.add('declaração de apontamentos completos');
  }
  if (!x.direct_costs_complete) {
    pm.add('declaração de custos externos completos');
    am.add('declaração de custos externos completos');
  }
  if (!x.estimates.length) pm.add('estimativas aprovadas');
  if (x.capacity_minutes === null) pm.add('capacidade explícita');
  if (x.pending_minutes) {
    pm.add('horas pendentes de decisão');
    am.add('horas pendentes de decisão');
    alerts.add('Horas pendentes não são custo realizado');
  }
  if (x.recognized === null) am.add('receita reconhecida por regra explícita');
  const approved = x.actuals.reduce((a, t) => a + t.minutes, 0);
  const planned = x.estimates.length
    ? x.estimates.reduce((a, t) => a + t.planned_minutes, 0)
    : null;
  const remaining = x.estimates.length
    ? x.estimates.reduce((a, t) => a + t.remaining_minutes, 0)
    : null;
  let actual = 0n,
    future = 0n,
    budgetLabor = 0n;
  let actualOk = x.time_entries_complete,
    futureOk = !!x.estimates.length;
  for (const a of x.actuals) {
    if (a.cost === null || a.currency !== x.currency) {
      actualOk = false;
      pm.add('taxa/câmbio das horas ' + a.id);
      am.add('taxa/câmbio das horas ' + a.id);
    } else actual += BigInt(a.cost);
  }
  for (const e of x.estimates) {
    if (e.rate === null || e.currency !== x.currency) {
      futureOk = false;
      pm.add('taxa vigente da estimativa ' + e.id);
    } else {
      future += BigInt(laborCost(e.remaining_minutes, e.rate));
      budgetLabor += BigInt(laborCost(e.planned_minutes, e.rate));
    }
  }
  let di = 0n,
    dr = 0n,
    db = 0n,
    directOk = x.direct_costs_complete;
  for (const d of x.direct) {
    if (d.currency !== x.currency) {
      directOk = false;
      pm.add('moeda do custo ' + d.id);
      am.add('moeda do custo ' + d.id);
    } else if (d.stage === 'incurred') di += BigInt(d.amount);
    else if (d.stage === 'remaining') dr += BigInt(d.amount);
    else db += BigInt(d.amount);
  }
  const overhead = (minutes: number | null): bigint | null =>
    !x.config || minutes === null
      ? null
      : x.config.overhead_rule === 'none_explicit'
        ? 0n
        : x.config.overhead_rate === null
          ? null
          : BigInt(laborCost(minutes, x.config.overhead_rate));
  const oi = overhead(approved),
    of = overhead(remaining),
    ob = overhead(planned);
  if (oi === null) {
    pm.add('overhead vigente');
    am.add('overhead vigente');
  }
  const incurred =
    actualOk && directOk && oi !== null ? actual + di + oi : null;
  const etc = futureOk && directOk && of !== null ? future + dr + of : null;
  let overage: number | null = null,
    balance: number | null = null,
    projectedRevenue: bigint | null = BigInt(x.revenue);
  if (x.regime === 'retainer') {
    if (x.included_minutes === null) {
      pm.add('minutos incluídos do retainer');
      projectedRevenue = null;
    } else {
      balance = x.included_minutes + x.carry_in_minutes - approved;
      overage = Math.max(0, approved - x.included_minutes - x.carry_in_minutes);
      const projectedOverage =
        remaining === null
          ? null
          : Math.max(
              0,
              approved + remaining - x.included_minutes - x.carry_in_minutes,
            );
      if (x.overage_rule === 'billable') {
        if (x.overage_rate === null || projectedOverage === null) {
          pm.add('taxa/previsão de excedente');
          projectedRevenue = null;
        } else
          projectedRevenue += BigInt(
            laborCost(projectedOverage, x.overage_rate),
          );
      }
    }
  }
  const deductions = (revenue: bigint): bigint | null =>
    x.config
      ? roundRatio(revenue * BigInt(x.config.tax_bps), 10000n) +
        roundRatio(revenue * BigInt(x.config.commission_bps), 10000n)
      : null;
  const projectedDeductions =
    projectedRevenue === null ? null : deductions(projectedRevenue);
  const eac =
    incurred !== null && etc !== null && projectedDeductions !== null
      ? incurred + etc + projectedDeductions
      : null;
  const budgetDeductions = deductions(BigInt(x.revenue));
  const budget =
    futureOk && directOk && ob !== null && budgetDeductions !== null
      ? budgetLabor + db + ob + budgetDeductions
      : null;
  const realizedDeductions =
    x.recognized === null ? null : deductions(BigInt(x.recognized));
  const realized =
    incurred !== null && realizedDeductions !== null
      ? incurred + realizedDeductions
      : null;
  const margin =
    eac !== null && projectedRevenue !== null && pm.size === 0
      ? projectedRevenue - eac
      : null;
  const realizedMargin =
    realized !== null && x.recognized !== null && am.size === 0
      ? BigInt(x.recognized) - realized
      : null;
  if (planned !== null && remaining !== null && approved + remaining > planned)
    alerts.add('Estouro previsto de horas');
  if (eac !== null && budget !== null && eac > budget) {
    alerts.add('EAC acima do orçamento');
    alerts.add('Erosão de margem prevista: custo acima da baseline');
  }
  if (margin !== null && margin < 0n) alerts.add('Margem projetada negativa');
  if (
    x.capacity_minutes !== null &&
    remaining !== null &&
    remaining > x.capacity_minutes
  )
    alerts.add('Horas restantes excedem capacidade declarada');
  if (balance !== null && balance < 0)
    alerts.add('Excedente de minutos do retainer');
  if (pm.size || am.size)
    alerts.add('Dados incompletos; indicadores dependentes indisponíveis');
  const s = (n: bigint | null) => (n === null ? null : n.toString());
  return {
    engine_version: ENGINE_VERSION,
    currency: x.currency,
    period_from: x.period_from,
    period_until: x.period_until,
    as_of: x.as_of,
    contracted_revenue: x.revenue,
    recognized_revenue: x.recognized,
    projected_revenue: s(projectedRevenue),
    planned_minutes: planned,
    approved_minutes: approved,
    pending_minutes: x.pending_minutes,
    remaining_minutes: remaining,
    capacity_minutes: x.capacity_minutes,
    included_minutes: x.included_minutes,
    carry_in_minutes: x.carry_in_minutes,
    balance_minutes: balance,
    overage_minutes: overage,
    labor_incurred: actualOk ? s(actual) : null,
    direct_incurred: directOk ? s(di) : null,
    overhead_incurred: s(oi),
    cost_incurred: s(incurred),
    budget_cost: s(budget),
    estimate_to_complete: s(etc),
    eac: s(eac),
    projected_margin: s(margin),
    projected_margin_bps:
      margin !== null && projectedRevenue !== null && projectedRevenue > 0n
        ? s(roundRatio(margin * 10000n, projectedRevenue))
        : null,
    realized_cost: s(realized),
    realized_margin: s(realizedMargin),
    realized_margin_bps:
      realizedMargin !== null &&
      x.recognized !== null &&
      BigInt(x.recognized) > 0n
        ? s(roundRatio(realizedMargin * 10000n, BigInt(x.recognized)))
        : null,
    hours_variance_minutes:
      planned !== null && remaining !== null
        ? approved + remaining - planned
        : null,
    cost_variance: eac !== null && budget !== null ? s(eac - budget) : null,
    projection_missing: [...pm].sort(),
    actual_missing: [...am].sort(),
    alerts: [...alerts].sort(),
  };
}
export function calendarMinutes(
  from: string,
  until: string,
  weekdays: number[],
  minutesPerDay: number,
  holidays: string[],
): number {
  const excluded = new Set(holidays);
  let total = 0;
  for (
    let d = new Date(from + 'T00:00:00Z');
    d.toISOString().slice(0, 10) <= until;
    d = new Date(d.getTime() + 86400000)
  ) {
    const iso = d.toISOString().slice(0, 10),
      weekday = d.getUTCDay() || 7;
    if (weekdays.includes(weekday) && !excluded.has(iso))
      total += minutesPerDay;
  }
  return total;
}
