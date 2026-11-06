// Read model of the ClickUp execution shown to partners. A count that cannot be known is
// null, shown as "Não disponível", never zero. No percentage or delivery forecast exists.
export const managerialStates = [
  'not_started',
  'in_progress',
  'blocked',
  'waiting_client',
  'in_review',
  'done',
] as const;
export type ManagerialState = (typeof managerialStates)[number];
export const managerialLabels: Record<ManagerialState, string> = {
  not_started: 'Não iniciada',
  in_progress: 'Em andamento',
  blocked: 'Bloqueada',
  waiting_client: 'Aguardando cliente',
  in_review: 'Em revisão',
  done: 'Concluída',
};
export type ExecutionFreshness =
  | 'not_linked'
  | 'never_synced'
  | 'failing'
  | 'stale'
  | 'fresh';
export type ExecutionSituation =
  | 'unavailable'
  | 'blocked'
  | 'overdue'
  | 'no_tasks'
  | 'all_closed'
  | 'no_known_delay';
export const situationLabels: Record<ExecutionSituation, string> = {
  unavailable: 'Não disponível',
  blocked: 'Com bloqueios',
  overdue: 'Com atrasos',
  no_tasks: 'Sem tarefas registradas',
  all_closed: 'Todas as tarefas concluídas',
  // Says nothing about blocks: those have their own figure, which may be unknown.
  no_known_delay: 'Sem atraso registrado',
};
export const syncErrorLabels: Record<string, string> = {
  unauthorized: 'o ClickUp recusou o token',
  not_found: 'não encontrada no ClickUp',
  rate_limited: 'limite de chamadas do ClickUp',
  upstream: 'o ClickUp respondeu com erro',
  network: 'sem conexão com o ClickUp',
  timeout: 'o ClickUp não respondeu a tempo',
  invalid_response: 'resposta do ClickUp em formato inesperado',
  too_large: 'resposta do ClickUp grande demais',
  too_many_pages: 'lista grande demais para uma leitura',
  workspace_mismatch: 'fora do workspace configurado',
  not_top_level: 'não é tarefa principal',
  hierarchy_mismatch: 'subtarefas incoerentes',
  too_many_tasks: 'grande demais para uma leitura',
  lease_expired: 'a leitura foi interrompida',
  link_deactivated: 'o vínculo foi desativado durante a leitura',
};
export interface ExecutionLink {
  id: string;
  list_id: string | null;
  /** Set for a link to a top-level task instead of a list. */
  task_id: string | null;
  list_name: string | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_error_code: string | null;
}
export interface ExecutionCounts {
  tasks_open: number;
  tasks_closed: number;
  subtasks_open: number;
  subtasks_closed: number;
  /** Open tasks and subtasks past their due date. */
  overdue: number;
  /** Open tasks and subtasks with no due date, which can never count as late. */
  without_due_date: number;
  next_due_at: string | null;
  unassigned_open: number;
  blocked: number | null;
  waiting_client: number | null;
  waiting_dependency: number | null;
}
export interface ExecutionOwner {
  name: string;
  open: number;
  overdue: number;
}
export interface ExecutionAttention {
  id: string;
  name: string;
  url: string | null;
  status: string;
  due_at: string | null;
  owners: string[];
  reasons: ('overdue' | 'blocked' | 'waiting_client')[];
}
/** An open status without meaning. list_id null: the mapping saved from it is organization-wide. */
export interface ExecutionUnmapped {
  status: string;
  tasks: number;
  list_id: string | null;
  list_name: string | null;
}
/**
 * The top-level task that stands for the project in a shared list. Its status is the
 * managerial one the team sets; it is shown as is, never derived from or counted with the
 * activities, and is not a measure of their progress.
 */
export interface ExecutionRoot {
  id: string;
  name: string;
  url: string | null;
  status: string;
  /** null: no explicit mapping for this status. */
  state: ManagerialState | null;
  due_at: string | null;
  overdue: boolean;
  owners: string[];
}
export interface ProjectExecution {
  freshness: ExecutionFreshness;
  /** Oldest successful read among the linked lists: the age of the whole picture. */
  last_sync_at: string | null;
  situation: ExecutionSituation;
  links: ExecutionLink[];
  roots: ExecutionRoot[];
  /** Activities (every task except the roots) per ClickUp status, open and closed. */
  activity_statuses: { status: string; tasks: number }[];
  counts: ExecutionCounts | null;
  owners: ExecutionOwner[];
  attention: ExecutionAttention[];
  /** Open tasks whose status has no explicit mapping; blocked figures are partial then. */
  unmapped_statuses: ExecutionUnmapped[];
  removed_from_lists: number;
  data_warnings: number;
}
