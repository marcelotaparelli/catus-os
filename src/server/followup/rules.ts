// Deterministic rules: same facts, same answer. No external service and no inference.
import type {
  Signal,
  SignalKind,
  TemplateId,
  WaitingOn,
  Alignment,
} from '../../shared/followup';
import type { Status } from '../../shared/domain';
import type { Role } from '../../shared/identity';

export interface DemandFacts {
  id: string;
  status: Status;
  template: TemplateId | null;
  owner_user_id: string | null;
  owner_active: boolean;
  follow_up_on: string | null;
  blocked_reason: string | null;
  waiting_on: WaitingOn | null;
  covered: boolean;
  updated_at: Date;
  planned_minutes: number | null;
  logged_minutes: number;
  alignment?: Alignment | null;
}
/** Starting parameters of the workflow, not targets. */
const limits: Record<
  TemplateId,
  { stallDays: number; coverageFrom: readonly Status[] }
> = {
  // Maintenance goes straight to execution: coverage only matters once work starts.
  manutencao: { stallDays: 3, coverageFrom: ['in_progress'] },
  implantacao: { stallDays: 7, coverageFrom: ['ready', 'in_progress'] },
};
export const WIP_LIMIT = 5;
const DAY = 864e5;
const hours = (m: number) => `${Math.round((m / 60) * 10) / 10}h`;
const pluralDays = (n: number) => (n === 1 ? '1 dia' : `${n} dias`);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY);

export function assess(f: DemandFacts, today: string, now: Date): Signal[] {
  if (f.status === 'done') return [];
  const t = limits[f.template ?? 'manutencao'],
    out: Signal[] = [],
    late = !!f.follow_up_on && f.follow_up_on < today;
  if (!f.owner_user_id || !f.owner_active)
    out.push({
      kind: 'no_owner',
      rank: 1,
      label: 'Sem responsável',
      reason: f.owner_user_id
        ? 'O responsável não está mais ativo nesta organização.'
        : 'Ninguém responde por esta demanda.',
    });
  if (late && f.status === 'blocked' && f.waiting_on === 'client')
    out.push({
      kind: 'client_delay',
      rank: 3,
      label: 'Cliente em atraso',
      reason: `O cliente deveria ter respondido há ${pluralDays(daysBetween(f.follow_up_on!, today))}: ${f.blocked_reason ?? 'motivo não registrado'}.`,
    });
  else if (late)
    out.push({
      kind: 'overdue',
      rank: 2,
      label: 'Compromisso vencido',
      reason: `Venceu há ${pluralDays(daysBetween(f.follow_up_on!, today))}.`,
    });
  if (f.planned_minutes !== null && f.logged_minutes > f.planned_minutes)
    out.push({
      kind: 'over_hours',
      rank: 4,
      label: 'Acima das horas estimadas',
      reason: `${hours(f.logged_minutes)} apontadas para ${hours(f.planned_minutes)} estimadas.`,
    });
  if (!f.covered && t.coverageFrom.includes(f.status))
    out.push({
      kind: 'no_coverage',
      // Work already running outside a contract comes before everything else.
      rank: f.status === 'in_progress' ? 0 : 5,
      label:
        f.status === 'in_progress'
          ? 'Em execução sem cobertura'
          : 'Sem cobertura comercial',
      reason:
        f.status === 'in_progress'
          ? 'Há trabalho em andamento sem item de escopo aprovado. A decisão é comercial.'
          : 'Falta analisar se está no contrato antes de executar.',
    });
  const idle = Math.floor((now.getTime() - f.updated_at.getTime()) / DAY);
  if (f.status !== 'blocked' && idle >= t.stallDays)
    out.push({
      kind: 'stalled',
      rank: 6,
      label: 'Parada',
      reason: `Sem movimentação há ${pluralDays(idle)}.`,
    });
  if (f.status === 'blocked' && !late)
    out.push({
      kind: 'blocked',
      rank: 7,
      label: 'Bloqueada',
      reason: f.blocked_reason ?? 'Motivo do bloqueio não registrado.',
    });
  // New demands are born with a commitment: an empty one predates migration 010.
  if (!f.follow_up_on)
    out.push({
      kind: 'no_follow_up',
      rank: 8,
      label: 'Sem compromisso',
      reason: 'Falta uma data para a próxima verificação.',
    });
  const a = f.alignment;
  if (a?.high_risk && !a.authorized)
    out.push({
      kind: 'risk_unauthorized',
      rank: 0,
      label: 'Alto risco sem autorização',
      reason: 'Só começa ou é entregue depois que um gestor autorizar.',
    });
  if (a?.delivered_at && f.status === 'in_progress')
    out.push({
      kind: 'awaiting_acceptance',
      rank: 3,
      label: 'Aguardando aceite',
      reason: 'Entregue. O silêncio do cliente não conta como aceite.',
    });
  if (a && a.version - 1 + a.rejections >= 2)
    out.push({
      kind: 'repeated_change',
      rank: 5,
      label: 'Mudança repetida',
      reason: `${a.version - 1} mudanças no combinado e ${a.rejections} recusas. Vale rever se é escopo novo.`,
    });
  if (
    f.template === 'implantacao' &&
    ['ready', 'in_progress'].includes(f.status)
  ) {
    if (!a)
      out.push({
        kind: 'no_agreement',
        rank: 5,
        label: 'Sem combinado',
        reason:
          'Faltam os critérios de aceite. Isto é um aviso e não impede seguir.',
      });
    else if (!a.confirmed && f.status === 'in_progress')
      out.push({
        kind: 'unconfirmed',
        rank: 5,
        label: 'Executando sem confirmação',
        reason:
          'O cliente não confirmou o combinado. Isto é um aviso e fica registrado.',
      });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** Who must see a condition. Everyone else with access reads it in the team list. */
const audience: Record<SignalKind, readonly (Role | 'owner')[]> = {
  no_owner: ['po', 'manager'],
  no_coverage: ['po', 'manager'],
  over_hours: ['manager'],
  overdue: ['owner', 'manager'],
  client_delay: ['owner', 'po', 'manager'],
  blocked: ['owner', 'manager'],
  stalled: ['owner'],
  no_follow_up: ['owner'],
  no_agreement: ['po', 'manager'],
  unconfirmed: ['po', 'manager'],
  awaiting_acceptance: ['po', 'manager'],
  repeated_change: ['po', 'manager'],
  risk_unauthorized: ['manager', 'administrator'],
};
export function concerns(
  kind: SignalKind,
  role: Role,
  isOwner: boolean,
): boolean {
  return (
    audience[kind].includes(role) ||
    (isOwner && audience[kind].includes('owner'))
  );
}
/** Reading boundary: estimates and other people's hours stay out of the developer's and PO's view. */
export function visibleTo(kind: SignalKind, role: Role, status: Status) {
  if (kind === 'over_hours') return ['manager', 'administrator'].includes(role);
  if (kind === 'no_coverage' && role === 'developer')
    return status === 'in_progress';
  return true;
}
