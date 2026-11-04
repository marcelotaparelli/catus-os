import { dayText } from './domain';
// Monetary values are decimal integer strings in the currency's smallest unit. Never JS floats.
export type Minor = string;
export type EconomicKind =
  | 'config'
  | 'rate'
  | 'terms'
  | 'estimate'
  | 'capacity'
  | 'direct_cost';
export interface EconomicRecord {
  id: string;
  kind: EconomicKind;
  project_id: string | null;
  series_key: string;
  revision: number;
  previous_id: string | null;
  currency: string;
  valid_from: string;
  valid_until: string;
  source: string;
  payload: Record<string, unknown>;
  created_by: string;
  created_at: string;
  decision: 'approved' | 'rejected' | null;
  decision_snapshot?: Record<string, unknown>;
  decided_at?: string;
}
export interface TimeEntry {
  id: string;
  project_id: string;
  request_id: string;
  user_id: string;
  work_date: string;
  minutes: number;
  comment: string;
  state: 'pending' | 'approved' | 'rejected' | 'reversed';
  created_at: string;
}
export interface EconomicsInput {
  currency: string;
  period_from: string;
  period_until: string;
  as_of: string;
  regime: 'fixed_price' | 'retainer';
  revenue: Minor;
  recognized: Minor | null;
  included_minutes: number | null;
  carry_in_minutes: number;
  overage_rule: 'none' | 'billable';
  overage_rate: Minor | null;
  config: {
    tax_bps: number;
    commission_bps: number;
    overhead_rule: 'none_explicit' | 'per_labor_minute';
    overhead_rate: Minor | null;
  } | null;
  actuals: {
    id: string;
    minutes: number;
    cost: Minor | null;
    currency: string | null;
  }[];
  pending_minutes: number;
  estimates: {
    id: string;
    planned_minutes: number;
    remaining_minutes: number;
    rate: Minor | null;
    currency: string | null;
  }[];
  direct: {
    id: string;
    stage: 'incurred' | 'remaining' | 'budget';
    amount: Minor;
    currency: string;
  }[];
  capacity_minutes: number | null;
  direct_costs_complete: boolean;
  time_entries_complete: boolean;
  projection_missing: string[];
  actual_missing: string[];
  alerts: string[];
}
export interface EconomicsResult {
  engine_version: string;
  currency: string;
  period_from: string;
  period_until: string;
  as_of: string;
  contracted_revenue: Minor;
  recognized_revenue: Minor | null;
  projected_revenue: Minor | null;
  planned_minutes: number | null;
  approved_minutes: number;
  pending_minutes: number;
  remaining_minutes: number | null;
  capacity_minutes: number | null;
  included_minutes: number | null;
  carry_in_minutes: number;
  balance_minutes: number | null;
  overage_minutes: number | null;
  labor_incurred: Minor | null;
  direct_incurred: Minor | null;
  overhead_incurred: Minor | null;
  cost_incurred: Minor | null;
  budget_cost: Minor | null;
  estimate_to_complete: Minor | null;
  eac: Minor | null;
  projected_margin: Minor | null;
  projected_margin_bps: string | null;
  realized_cost: Minor | null;
  realized_margin: Minor | null;
  realized_margin_bps: string | null;
  hours_variance_minutes: number | null;
  cost_variance: Minor | null;
  projection_missing: string[];
  actual_missing: string[];
  alerts: string[];
}
export interface EconomicsView {
  clients?: {
    client_id: string;
    currency: string;
    period_from: string;
    period_until: string;
    report_ids: string[];
    contracted_revenue: string;
    eac: string | null;
    projected_margin: string | null;
    projected_margin_bps: string | null;
    realized_margin: string | null;
    projection_missing: string[];
    actual_missing: string[];
  }[];
  records: EconomicRecord[];
  times: TimeEntry[];
  reports: {
    id: string;
    project_id: string;
    terms_id: string;
    as_of: string;
    result: EconomicsResult;
    created_at: string;
    input_hash: string;
    inputs: unknown;
  }[];
  events: {
    id: string;
    entity_type: string;
    entity_id: string;
    action: string;
    actor_user_id: string;
    actor_role: string;
    data: unknown;
    created_at: string;
  }[];
}
export function moneyLabel(
  minor: string | null | undefined,
  currency: string,
): string {
  if (minor == null) return 'Indisponível';
  const n = BigInt(minor),
    sign = n < 0n ? '-' : '',
    abs = n < 0n ? -n : n;
  const digits = ['JPY', 'CLP'].includes(currency) ? 0 : 2;
  return `${currency} ${sign}${digits ? `${abs / 100n},${(abs % 100n).toString().padStart(2, '0')}` : abs}`;
}
/** Same value as moneyLabel, with thousands separators for executive reading. */
export function moneyGrouped(
  minor: string | null | undefined,
  currency: string,
): string {
  const label = moneyLabel(minor, currency);
  return minor == null
    ? label
    : label.replace(/\d+/, (whole) =>
        whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.'),
      );
}
export function percentLabel(bps: string | null | undefined): string {
  if (bps == null) return 'Indisponível';
  const n = BigInt(bps),
    abs = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${abs / 100n},${(abs % 100n).toString().padStart(2, '0')}%`;
}
export function hoursLabel(minutes: number | null | undefined): string {
  if (minutes == null) return 'Indisponível';
  const abs = Math.abs(minutes),
    h = Math.floor(abs / 60),
    m = abs % 60;
  return `${minutes < 0 ? '-' : ''}${h}h${m ? String(m).padStart(2, '0') : ''}`;
}
export function dayLabel(iso: string | null | undefined): string {
  return dayText(iso) || 'Indisponível';
}
