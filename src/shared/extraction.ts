export interface Evidence {
  quote: string;
  start: number;
  end: number;
}
export interface Grounded {
  text: string;
  evidence: Evidence[];
}
export interface SuggestedProposal {
  title: string;
  description: string;
  evidence: Evidence[];
  acceptance_criteria: Grounded[];
}
export interface ExtractionResult {
  version: 1;
  summary: Grounded;
  requirements: Grounded[];
  decisions: Grounded[];
  commitments: Grounded[];
  missing_information: string[];
  questions: string[];
  proposals: SuggestedProposal[];
}
export interface Duplicate {
  id: string;
  type: 'request' | 'proposal';
  title: string;
  reason: 'same_title' | 'similar_text';
}
export interface Proposal extends SuggestedProposal {
  id: string;
  extraction_id: string;
  state: 'proposed' | 'accepted' | 'rejected';
  version: number;
  request_id: string | null;
  duplicates: Duplicate[];
}
export interface ExtractionJob {
  id: string;
  interaction_id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  created_at: string;
  result: ExtractionResult | null;
  failure_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  estimated_cost_micro_usd: string | null;
  consumed_micro_usd: string | null;
  source_text: string;
  source_hash: string;
  provider_config: { model: string; promptVersion: string };
  proposals: Proposal[];
  reviews: {
    id: string;
    proposal_id: string;
    actor_user_id: string;
    action: string;
    created_at: string;
    before_snapshot: unknown;
    after_snapshot: unknown;
  }[];
}
export interface AiPolicy {
  enabled: boolean;
  policy_reference: string;
  data_scope: 'synthetic' | 'authorized_client';
  daily_budget_micro_usd: string;
  per_job_budget_micro_usd: string;
  daily_job_limit: number;
}
export interface AiCapability {
  available: boolean;
  reason: string;
  model?: string;
  policy: AiPolicy | null;
}
