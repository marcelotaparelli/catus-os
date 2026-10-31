export const statuses = [
  'new',
  'triage',
  'ready',
  'in_progress',
  'blocked',
  'done',
] as const;
export type Status = (typeof statuses)[number];
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
  origin_proposal_id?: string | null;
  suggested_acceptance_criteria?: import('./extraction').Grounded[] | null;
  next_action: string;
  version: number;
  client_name: string;
  project_name: string;
}
export interface Snapshot {
  clients: Client[];
  projects: Project[];
  interactions: Interaction[];
  requests: WorkRequest[];
}
