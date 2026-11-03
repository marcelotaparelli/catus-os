// Read model of GET /api/overview. Every figure comes from the M4 engine or from
// stored records; a missing input is null (never zero) and is named in `missing`.
import type { EconomicsResult } from './economics';
import type { Role } from './identity';

export type ProjectHealth =
  | 'negative'
  | 'at_risk'
  | 'positive'
  | 'incomplete'
  | 'unmeasured';

export interface ActionTarget {
  route: 'economia' | 'comercial' | 'solicitacoes' | 'acesso' | 'auditoria';
  query?: Record<string, string>;
}
export interface RecommendedAction {
  code: string;
  action: string;
  /** Named people; never a generic owner when the membership can resolve one. */
  owner: string;
  owner_basis: string;
  reason: string;
  target: ActionTarget;
}
export interface HoursLine {
  request_id: string;
  title: string;
  owner: string;
  status: string;
  planned_minutes: number | null;
  approved_minutes: number;
  pending_minutes: number;
  remaining_minutes: number | null;
  variance_minutes: number | null;
  expected_on: string | null;
  overdue: boolean;
}
export interface MissingItem {
  label: string;
  count: number;
}
export interface ProjectOverview {
  project_id: string;
  project_name: string;
  client_name: string;
  health: ProjectHealth;
  health_reason: string;
  result: EconomicsResult | null;
  source: {
    terms_id: string;
    terms_revision: number;
    terms_source: string;
    regime: string;
    contract_title: string;
    scope_number: number | null;
    approved_time_entries: number;
    approved_estimates: number;
    latest_report: {
      id: string;
      as_of: string;
      created_at: string;
      input_hash: string;
      matches_live: boolean;
    } | null;
  } | null;
  projection_missing: MissingItem[];
  actual_missing: MissingItem[];
  hours: HoursLine[];
  open_requests: number;
  blocked_requests: number;
  uncovered_requests: number;
  actions: RecommendedAction[];
}
export interface GovernanceCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  target: ActionTarget;
}
export interface FinancialOverview {
  kind: 'financial';
  as_of: string;
  projects: ProjectOverview[];
  organization_actions: RecommendedAction[];
  governance?: {
    members_by_role: Record<Role, number>;
    checks: GovernanceCheck[];
  };
}
export interface OperationalDemand {
  id: string;
  title: string;
  project_name: string;
  client_name: string;
  status: string;
  owner: string;
  next_action: string;
  covered: boolean;
  expected_on: string | null;
  planned_minutes: number | null;
  remaining_minutes: number | null;
  overdue: boolean;
}
export interface OperationalOverview {
  kind: 'operational';
  as_of: string;
  demands: OperationalDemand[];
  scopes: {
    id: string;
    title: string;
    number: number;
    state: string;
    project_name: string;
  }[];
  pending_changes: number;
  actions: RecommendedAction[];
}
export interface PersonalOverview {
  kind: 'personal';
  as_of: string;
  hours: { pending: number; approved: number; rejected: number };
  /** Minutes this person logged per request, excluding rejected/reversed entries. */
  logged_by_request: Record<string, number>;
  rejected: {
    id: string;
    work_date: string;
    minutes: number;
    comment: string;
  }[];
}
export type Overview =
  | FinancialOverview
  | OperationalOverview
  | PersonalOverview;
export const healthLabels: Record<ProjectHealth, string> = {
  negative: 'Margem negativa',
  at_risk: 'Em risco',
  incomplete: 'Dados insuficientes',
  unmeasured: 'Sem base econômica',
  positive: 'Margem positiva',
};
/** Most urgent first. */
export const healthOrder: ProjectHealth[] = [
  'negative',
  'at_risk',
  'incomplete',
  'unmeasured',
  'positive',
];
