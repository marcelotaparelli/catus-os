import { InputError, text, uuid } from '../../shared/domain';
import { currencies } from '../../shared/commercial';
import type { EconomicKind } from '../../shared/economics';
export function fields(b: Record<string, unknown>, keys: string[]) {
  if (Object.keys(b).some((k) => !keys.includes(k)))
    throw new InputError('Campo não permitido');
}
export function integer(
  v: unknown,
  label: string,
  max = 10000000,
  min = 0,
): number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new InputError(label + ': inteiro fora do limite');
  return Number(v);
}
export function minor(v: unknown): string {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(v))
    throw new InputError(
      'Dinheiro exige string inteira de unidades mínimas, não float/negativo',
    );
  return v;
}
export function day(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    v < '2000-01-01' ||
    v > '2100-12-31' ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    throw new InputError('Data ISO inválida (2000–2100)');
  return v;
}
export const today = () => new Date().toISOString().slice(0, 10);
export function one<T extends string>(v: unknown, values: readonly T[]): T {
  if (!values.includes(v as T)) throw new InputError('Opção inválida');
  return v as T;
}
export function bool(v: unknown): boolean {
  if (typeof v !== 'boolean')
    throw new InputError('Declaração booleana explícita obrigatória');
  return v;
}
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new InputError('Objeto obrigatório');
  return v as Record<string, unknown>;
}
export function parsePayload(
  kind: EconomicKind,
  b: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case 'config':
      fields(b, [
        'tax_bps',
        'commission_bps',
        'overhead_rule',
        'overhead_minor_per_hour',
        'weekdays',
        'minutes_per_day',
        'holidays',
      ]);
      {
        const tax = integer(b.tax_bps, 'Tributos', 10000),
          commission = integer(b.commission_bps, 'Comissões', 10000);
        if (tax + commission > 10000)
          throw new InputError('Tributos + comissões excedem receita');
        const rule = one(b.overhead_rule, [
          'none_explicit',
          'per_labor_minute',
        ]);
        if (
          !Array.isArray(b.weekdays) ||
          !b.weekdays.length ||
          b.weekdays.length > 7 ||
          new Set(b.weekdays).size !== b.weekdays.length
        )
          throw new InputError('Calendário explícito obrigatório');
        const weekdays = b.weekdays.map((x) =>
          integer(x, 'Dia ISO da semana', 7, 1),
        );
        if (!Array.isArray(b.holidays) || b.holidays.length > 366)
          throw new InputError('Feriados explícitos obrigatórios');
        if (rule === 'none_explicit' && b.overhead_minor_per_hour !== null)
          throw new InputError(
            'Overhead ausente por declaração exige taxa null',
          );
        return {
          tax_bps: tax,
          commission_bps: commission,
          overhead_rule: rule,
          overhead_minor_per_hour:
            rule === 'per_labor_minute'
              ? minor(b.overhead_minor_per_hour)
              : null,
          weekdays,
          minutes_per_day: integer(b.minutes_per_day, 'Minutos/dia', 1440, 1),
          holidays: b.holidays.map(day),
        };
      }
    case 'rate':
      fields(b, ['user_id', 'role', 'minor_per_hour']);
      {
        if ((b.user_id == null) === (b.role == null))
          throw new InputError('Taxa exige profissional OU função');
        return {
          user_id: b.user_id == null ? null : uuid(b.user_id),
          role:
            b.role == null
              ? null
              : one(b.role, ['administrator', 'manager', 'po', 'developer']),
          minor_per_hour: minor(b.minor_per_hour),
        };
      }
    case 'terms':
      fields(b, [
        'contract_id',
        'scope_id',
        'amount_minor',
        'recognition_rule',
        'recognized_minor',
        'direct_costs_complete',
        'time_entries_complete',
        'included_minutes',
        'overage_rule',
        'overage_rate_minor',
        'rollover_rule',
        'rollover_cap_minutes',
        'carry_in_minutes',
        'prior_terms_id',
        'change_request_id',
      ]);
      {
        const recognition = one(b.recognition_rule, [
            'none',
            'at_period_end',
            'manual',
          ]),
          overage = one(b.overage_rule, ['none', 'billable']),
          rollover = one(b.rollover_rule, ['none', 'carry_capped']);
        if (recognition !== 'manual' && b.recognized_minor !== null)
          throw new InputError(
            'Receita reconhecida manual deve ter regra manual',
          );
        if (overage === 'none' && b.overage_rate_minor !== null)
          throw new InputError('Excedente não faturável exige taxa null');
        const carry = integer(b.carry_in_minutes, 'Rollover de entrada'),
          cap = integer(b.rollover_cap_minutes, 'Teto de rollover');
        if (
          (rollover === 'none' &&
            (carry !== 0 || cap !== 0 || b.prior_terms_id !== null)) ||
          carry > cap ||
          (carry > 0 && b.prior_terms_id == null)
        )
          throw new InputError('Rollover exige regra, teto e origem aprovados');
        return {
          contract_id: uuid(b.contract_id),
          scope_id: uuid(b.scope_id),
          amount_minor: minor(b.amount_minor),
          recognition_rule: recognition,
          recognized_minor:
            recognition === 'manual' ? minor(b.recognized_minor) : null,
          direct_costs_complete: bool(b.direct_costs_complete),
          time_entries_complete: bool(b.time_entries_complete),
          included_minutes:
            b.included_minutes === null
              ? null
              : integer(b.included_minutes, 'Minutos incluídos'),
          overage_rule: overage,
          overage_rate_minor:
            overage === 'billable' ? minor(b.overage_rate_minor) : null,
          rollover_rule: rollover,
          rollover_cap_minutes: cap,
          carry_in_minutes: carry,
          prior_terms_id:
            b.prior_terms_id == null ? null : uuid(b.prior_terms_id),
          change_request_id:
            b.change_request_id == null ? null : uuid(b.change_request_id),
        };
      }
    case 'estimate':
      fields(b, [
        'terms_id',
        'request_id',
        'user_id',
        'planned_minutes',
        'remaining_minutes',
        'expected_on',
      ]);
      return {
        terms_id: uuid(b.terms_id),
        request_id: uuid(b.request_id),
        user_id: uuid(b.user_id),
        planned_minutes: integer(b.planned_minutes, 'Minutos previstos'),
        remaining_minutes: integer(b.remaining_minutes, 'Minutos restantes'),
        expected_on: day(b.expected_on),
      };
    case 'capacity':
      fields(b, ['user_id', 'available_minutes']);
      return {
        user_id: uuid(b.user_id),
        available_minutes: integer(b.available_minutes, 'Minutos disponíveis'),
      };
    case 'direct_cost':
      fields(b, [
        'terms_id',
        'expense_key',
        'classification',
        'budget_minor',
        'incurred_minor',
        'remaining_minor',
      ]);
      return {
        terms_id: uuid(b.terms_id),
        expense_key: text(b.expense_key, 'Identificador único da despesa', 100),
        classification: one(b.classification, ['external', 'expense']),
        budget_minor: minor(b.budget_minor),
        incurred_minor: minor(b.incurred_minor),
        remaining_minor: minor(b.remaining_minor),
      };
  }
}
export const currency = (v: unknown) => one(v, currencies);
