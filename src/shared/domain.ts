export const statuses = [
  'new',
  'triage',
  'ready',
  'in_progress',
  'blocked',
  'done',
] as const;
export type Status = (typeof statuses)[number];
export const statusLabels: Record<Status, string> = {
  new: 'Nova',
  triage: 'Em triagem',
  ready: 'Pronta',
  in_progress: 'Em execução',
  blocked: 'Bloqueada',
  done: 'Concluída',
};
export const transitions: Record<Status, readonly Status[]> = {
  new: ['triage'],
  triage: ['ready', 'blocked'],
  ready: ['in_progress', 'triage', 'blocked'],
  in_progress: ['done', 'blocked'],
  blocked: ['triage', 'ready', 'in_progress'],
  done: ['triage'],
};
export class InputError extends Error {}
export function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new InputError(`${field}: informe de 1 a ${max} caracteres`);
  return value.trim();
}
export function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new InputError('Identificador inválido');
  return value;
}
export function status(value: unknown): Status {
  if (!statuses.includes(value as Status))
    throw new InputError('Estado inválido');
  return value as Status;
}
export function transition(from: Status, to: Status) {
  if (from !== to && !transitions[from].includes(to))
    throw new InputError(`Transição inválida: ${from} → ${to}`);
}
export interface Client {
  id: string;
  name: string;
}
export interface Project {
  id: string;
  client_id: string;
  name: string;
}
export interface Interaction {
  id: string;
  project_id: string;
  kind: 'meeting' | 'service' | 'conversation' | 'observation';
  summary: string;
  occurred_at: string;
}
export interface WorkRequest {
  id: string;
  interaction_id: string;
  title: string;
  description: string;
  status: Status;
  owner: string;
  owner_user_id: string | null;
  scope_item_id?: string | null;
  commercial_coverage?: 'covered' | 'pending_analysis';
  scope_number?: number | null;
  contract_title?: string | null;
  origin_proposal_id?: string | null;
  suggested_acceptance_criteria?: import('./extraction').Grounded[] | null;
  next_action: string;
  template?: import('./followup').TemplateId | null;
  follow_up_on?: string | null;
  blocked_reason?: string | null;
  waiting_on?: import('./followup').WaitingOn | null;
  /** Closing it goes through delivery and acceptance, in the action queue. */
  has_agreement?: boolean;
  version: number;
  client_name: string;
  project_name: string;
  project_id?: string;
  updated_at?: string;
}
export interface Snapshot {
  clients: Client[];
  projects: Project[];
  interactions: Interaction[];
  requests: WorkRequest[];
}
/** ISO day (or timestamp) shown as DD/MM/AAAA; text only, so no timezone shift. */
export function dayText(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
export function timeLabel(
  iso: string,
  timeStyle: 'short' | 'medium' = 'short',
): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle });
}
/** DD/MM/AAAA or DDMMAAAA to ISO; null when that calendar day does not exist. */
export function dayFromText(raw: string): string | null {
  const m = /^(\d{2})\/?(\d{2})\/?(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`,
    t = new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!));
  return t.toISOString().slice(0, 10) === iso ? iso : null;
}
/** Local "DD/MM/AAAA HH:MM" to an instant; null when it does not exist. */
export function instantFromText(raw: string): string | null {
  const m = /^(\S+) (\d{2}):(\d{2})$/.exec(raw.trim()),
    day = m && dayFromText(m[1]!);
  if (!day || +m![2]! > 23 || +m![3]! > 59) return null;
  return new Date(`${day}T${m![2]}:${m![3]}`).toISOString();
}
