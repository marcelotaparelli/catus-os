export type ContractKind = 'fixed_price' | 'retainer';
export type ScopeState =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'superseded';
export interface Contract {
  id: string;
  project_id: string;
  client_id: string;
  title: string;
  kind: ContractKind;
  currency: string;
  valid_from: string;
  valid_until: string;
  state: 'draft' | 'active' | 'closed';
  document_reference: string;
  created_by: string;
  version: number;
}
export interface ScopeItem {
  id?: string;
  description: string;
  deliverables: string;
  exclusions: string;
  acceptance_criteria: string;
  dependencies: string;
  origin_interaction_id: string | null;
  origin_request_id: string | null;
}
export interface ScopeVersion {
  id: string;
  project_id: string;
  contract_id: string;
  number: number;
  title: string;
  state: ScopeState;
  previous_id: string | null;
  version: number;
  created_by: string;
  submitted_by: string | null;
  items: ScopeItem[];
  decision: {
    decision: string;
    actor_user_id: string;
    actor_role: string;
    policy_version: number;
    policy_roles: string[];
    scope_version: number;
    reason: string;
    decided_at: string;
  } | null;
}
export interface ChangeRequest {
  id: string;
  project_id: string;
  base_scope_id: string;
  proposed_scope_id: string;
  reason: string;
  impact: string;
  state: 'pending' | 'approved' | 'rejected';
  created_by: string;
}
export interface CommercialPolicy {
  approval_roles: ('manager' | 'administrator')[];
  version: number;
}
export interface CommercialSnapshot {
  contracts: Contract[];
  scopes: ScopeVersion[];
  changes: ChangeRequest[];
  policy: CommercialPolicy | null;
  events: {
    id: string;
    entity_type: string;
    entity_id: string;
    action: string;
    actor_user_id: string;
    actor_role: string;
    created_at: string;
    before_data: unknown;
    after_data: unknown;
  }[];
}
// M4 consumes approved, versioned references. No amounts, rates or inferred estimates in M3.
export interface CommercialBasis {
  contract_id: string;
  scope_id: string;
  scope_number: number;
  scope_item_id: string;
  contract_kind: ContractKind;
  currency: string;
  valid_from: string;
  valid_until: string;
}
export const currencies = [
  'BRL',
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'CHF',
  'ARS',
  'CLP',
  'MXN',
] as const;
