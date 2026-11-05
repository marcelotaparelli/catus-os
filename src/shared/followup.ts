// Nenhuma demanda esquecida: read model of GET /api/followup and the deterministic
// parameters behind it. The numbers are starting parameters of the workflow, not targets.
import type { Status } from './domain';

export const templateIds = ['manutencao', 'implantacao'] as const;
export type TemplateId = (typeof templateIds)[number];
export const templates: Record<
  TemplateId,
  { label: string; followUpDays: number; nextAction: string }
> = {
  manutencao: {
    label: 'Manutenção',
    followUpDays: 2,
    nextAction: 'Reproduzir o pedido e confirmar o que fazer',
  },
  implantacao: {
    label: 'Implantação',
    followUpDays: 5,
    nextAction: 'Fazer a descoberta e o briefing com o cliente',
  },
};
export const waitingLabels = {
  client: 'Cliente',
  internal: 'Equipe interna',
  third_party: 'Terceiro',
} as const;
export type WaitingOn = keyof typeof waitingLabels;

export type SignalKind =
  | 'no_owner'
  | 'overdue'
  | 'client_delay'
  | 'over_hours'
  | 'no_coverage'
  | 'stalled'
  | 'blocked'
  | 'no_follow_up'
  | 'no_agreement'
  | 'unconfirmed'
  | 'awaiting_acceptance'
  | 'repeated_change'
  | 'risk_unauthorized';
export interface Signal {
  kind: SignalKind;
  /** Lower comes first in the queue. */
  rank: number;
  label: string;
  reason: string;
  /** An alert exists for this episode and nobody acknowledged it yet. */
  is_new?: boolean;
}
/** The current agreement of a demand. Absent means nobody recorded one, not that it is fine. */
export interface Alignment {
  version: number;
  criteria: string;
  high_risk: boolean;
  /** The client confirmed this version. */
  confirmed: boolean;
  /** A manager or administrator authorized this version. */
  authorized: boolean;
  /** Set while the delivery waits for the client's answer. */
  delivered_at: string | null;
  rejections: number;
}
export interface QueueItem {
  id: string;
  title: string;
  client_name: string;
  project_name: string;
  project_id: string;
  status: Status;
  template: TemplateId | null;
  owner: string;
  owner_user_id: string | null;
  next_action: string;
  follow_up_on: string | null;
  blocked_reason: string | null;
  waiting_on: WaitingOn | null;
  version: number;
  alignment: Alignment | null;
  /** Criteria that already exist for this demand. Never sent to a developer. */
  suggested_criteria?: string | null;
  for_me: boolean;
  signals: Signal[];
}
export interface FollowupQueue {
  as_of: string;
  items: QueueItem[];
  new_alerts: number;
  /** Named overload; only for those who distribute work. */
  overloaded?: { name: string; in_progress: number }[];
  /** Only for manager and administrator. */
  stage_times?: { status: Status; count: number; median_minutes: number }[];
  automation?: {
    last_sweep_at: string | null;
    late: boolean;
    retrying: number;
    failed: number;
  };
}
export interface FollowupSummary {
  for_me: number;
  new_alerts: number;
}

/** ISO day plus business days; weekends are skipped, holidays are not known. */
export function addBusinessDays(day: string, count: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  for (let left = count; left > 0; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() % 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
export const defaultFollowUp = (today: string, t: TemplateId | null) =>
  addBusinessDays(today, templates[t ?? 'manutencao'].followUpDays);

/** The single next stage offered as one click. */
export function nextStep(
  status: Status,
  template: TemplateId | null,
): { to: Status; label: string } | null {
  switch (status) {
    case 'new':
      return template === 'manutencao'
        ? { to: 'ready', label: 'Liberar para execução' }
        : { to: 'triage', label: 'Iniciar triagem' };
    case 'triage':
      return { to: 'ready', label: 'Liberar para execução' };
    case 'ready':
      return { to: 'in_progress', label: 'Iniciar execução' };
    case 'in_progress':
      return { to: 'done', label: 'Concluir' };
    case 'blocked':
      return { to: 'in_progress', label: 'Retomar' };
    default:
      return null;
  }
}
