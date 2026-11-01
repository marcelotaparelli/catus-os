import { test, expect } from 'bun:test';
import {
  calculate,
  laborCost,
  roundRatio,
} from '../src/server/economics/engine';
import { minor, parsePayload } from '../src/server/economics/validation';
import type { EconomicsInput } from '../src/shared/economics';
export function fixedInput(): EconomicsInput {
  return {
    currency: 'BRL',
    period_from: '2026-11-01',
    period_until: '2026-11-30',
    as_of: '2026-11-15',
    regime: 'fixed_price',
    revenue: '1000000',
    recognized: '400000',
    included_minutes: null,
    carry_in_minutes: 0,
    overage_rule: 'none',
    overage_rate: null,
    config: {
      tax_bps: 1000,
      commission_bps: 500,
      overhead_rule: 'per_labor_minute',
      overhead_rate: '1200',
    },
    actuals: [{ id: 't1', minutes: 120, cost: '12000', currency: 'BRL' }],
    pending_minutes: 0,
    estimates: [
      {
        id: 'e1',
        planned_minutes: 600,
        remaining_minutes: 480,
        rate: '6000',
        currency: 'BRL',
      },
    ],
    direct: [
      { id: 'd1', stage: 'budget', amount: '20000', currency: 'BRL' },
      { id: 'd2', stage: 'incurred', amount: '5000', currency: 'BRL' },
      { id: 'd3', stage: 'remaining', amount: '15000', currency: 'BRL' },
    ],
    capacity_minutes: 1000,
    direct_costs_complete: true,
    time_entries_complete: true,
    projection_missing: [],
    actual_missing: [],
    alerts: [],
  };
}
test('independent fixed-price arithmetic: costs, EAC, net margins, denominator and changing ETC without changing actuals', () => {
  const input = fixedInput(),
    a = calculate(input);
  expect(a.labor_incurred).toBe('12000');
  expect(a.cost_incurred).toBe('19400');
  expect(a.estimate_to_complete).toBe('72600');
  expect(a.eac).toBe('242000');
  expect(a.budget_cost).toBe('242000');
  expect(a.projected_margin).toBe('758000');
  expect(a.projected_margin_bps).toBe('7580');
  expect(a.realized_cost).toBe('79400');
  expect(a.realized_margin).toBe('320600');
  expect(a.realized_margin_bps).toBe('8015');
  const before = JSON.stringify(a);
  input.estimates[0]!.remaining_minutes = 1200;
  const b = calculate(input);
  expect(b.eac).toBe('328400');
  expect(b.projected_margin).toBe('671600');
  expect(b.cost_incurred).toBe(a.cost_incurred);
  expect(b.realized_margin).toBe(a.realized_margin);
  expect(JSON.stringify(a)).toBe(before);
  expect(b.alerts).toContain('Estouro previsto de horas');
  expect(b.alerts).toContain('Horas restantes excedem capacidade declarada');
});
test('integer half-away-from-zero at every labor/percentage boundary; huge products are exact, no floating arithmetic', () => {
  expect(laborCost(1, '1')).toBe('0');
  expect(laborCost(30, '1')).toBe('1');
  expect(roundRatio(-15n, 10n)).toBe(-2n);
  expect(roundRatio(15n, 10n)).toBe(2n);
  expect(laborCost(10000000, '999999999999999')).toBe('166666666666666500000');
  expect(() => roundRatio(1n, 0n)).toThrow();
  for (const v of [
    1.1,
    1,
    '1.2',
    '-1',
    '01',
    '1e3',
    '',
    null,
    '1000000000000000',
  ])
    expect(() => minor(v)).toThrow();
  expect(minor('0')).toBe('0');
});
test('retainer has its own balance, included/carry minutes and explicit overage, never fixed-price hours assumptions', () => {
  const i = fixedInput();
  Object.assign(i, {
    regime: 'retainer',
    included_minutes: 600,
    carry_in_minutes: 60,
    overage_rule: 'billable',
    overage_rate: '6000',
  });
  i.actuals = [{ id: 't', minutes: 720, cost: '72000', currency: 'BRL' }];
  i.estimates[0]!.remaining_minutes = 0;
  const r = calculate(i);
  expect(r.balance_minutes).toBe(-60);
  expect(r.overage_minutes).toBe(60);
  expect(r.projected_revenue).toBe('1006000');
  expect(r.contracted_revenue).toBe('1000000');
  expect(r.recognized_revenue).toBe('400000');
  expect(r.alerts).toContain('Excedente de minutos do retainer');
});
test('missing rate, estimate, config, capacity, costs or mixed currency yields explicit incompleteness, never fictional positive margins', () => {
  for (const mutation of [
    (i: EconomicsInput) => (i.config = null),
    (i: EconomicsInput) => (i.estimates = []),
    (i: EconomicsInput) => (i.actuals[0]!.cost = null),
    (i: EconomicsInput) => (i.estimates[0]!.rate = null),
    (i: EconomicsInput) => (i.capacity_minutes = null),
    (i: EconomicsInput) => (i.direct_costs_complete = false),
    (i: EconomicsInput) => (i.direct[0]!.currency = 'USD'),
  ]) {
    const i = fixedInput();
    mutation(i);
    const r = calculate(i);
    expect(r.projected_margin).toBeNull();
    expect(r.projection_missing.length).toBeGreaterThan(0);
  }
  const i = fixedInput();
  i.recognized = null;
  i.pending_minutes = 10;
  const r = calculate(i);
  expect(r.realized_margin).toBeNull();
  expect(r.projected_margin).toBeNull();
  expect(r.approved_minutes).toBe(120);
  expect(r.pending_minutes).toBe(10);
});
test('explicit zeros allowed; zero revenue never produces a margin percentage or implies receipt of cash', () => {
  const i = fixedInput();
  i.revenue = '0';
  i.recognized = '0';
  const r = calculate(i);
  expect(r.projected_margin_bps).toBeNull();
  expect(r.realized_margin_bps).toBeNull();
  expect(BigInt(r.projected_margin!)).toBeLessThan(0n);
  expect(r).not.toHaveProperty('cash_received');
  expect(() =>
    parsePayload('config', {
      tax_bps: 0,
      commission_bps: 0,
      overhead_rule: 'none_explicit',
      overhead_minor_per_hour: null,
      weekdays: [1, 2, 3, 4, 5],
      minutes_per_day: 480,
      holidays: [],
    }),
  ).not.toThrow();
  expect(() =>
    parsePayload('config', {
      tax_bps: 0,
      commission_bps: 0,
      overhead_rule: 'none_explicit',
      weekdays: [1],
      minutes_per_day: 480,
      holidays: [],
    }),
  ).toThrow();
});
test('canonical hashes survive JSONB key ordering; client totals never mix currencies, periods or repeated observations', async () => {
  const { inputHash } = await import('../src/server/economics/hash');
  const { clientRollups } = await import('../src/server/economics/rollup');
  expect(inputHash({ a: 1, b: { x: 2, y: 3 } })).toBe(
    inputHash({ b: { y: 3, x: 2 }, a: 1 }),
  );
  const a = calculate(fixedInput()),
    other = calculate({ ...fixedInput(), currency: 'USD' }),
    next = calculate({
      ...fixedInput(),
      period_from: '2026-12-01',
      period_until: '2026-12-31',
    });
  const rollup = clientRollups([
    { id: 'latest', project_id: 'p1', inputs: { client_id: 'c1' }, result: a },
    { id: 'older', project_id: 'p1', inputs: { client_id: 'c1' }, result: a },
    { id: 'usd', project_id: 'p2', inputs: { client_id: 'c1' }, result: other },
    { id: 'dec', project_id: 'p1', inputs: { client_id: 'c1' }, result: next },
  ]);
  expect(rollup).toHaveLength(3);
  const brl = rollup.find(
    (x) => x.currency === 'BRL' && x.period_from === '2026-11-01',
  )!;
  expect(brl.report_ids).toEqual(['latest']);
  expect(brl.contracted_revenue).toBe('1000000');
  expect(brl.projected_margin).toBe('758000');
  const { calendarMinutes } = await import('../src/server/economics/engine');
  expect(
    calendarMinutes('2026-11-02', '2026-11-08', [1, 2, 3, 4, 5], 480, [
      '2026-11-03',
    ]),
  ).toBe(1920);
});
