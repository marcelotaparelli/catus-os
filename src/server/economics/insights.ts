// Pure, deterministic reading of M4 engine results. No new formula and no threshold is
// invented here: health and actions only classify values the engine or the records hold.
import type { EconomicsResult } from '../../shared/economics';
import {
  dayLabel,
  hoursLabel,
  moneyGrouped,
  percentLabel,
} from '../../shared/economics';
import type {
  HoursLine,
  MissingItem,
  ProjectHealth,
  RecommendedAction,
} from '../../shared/overview';

const signedHours = (n: number) => (n > 0 ? '+' : '') + hoursLabel(n);
const positive = (minor: string | null) => minor !== null && BigInt(minor) > 0n;

export function assessHealth(
  result: EconomicsResult | null,
  blocked: number,
  uncovered: number,
): { health: ProjectHealth; reason: string } {
  if (!result)
    return {
      health: 'unmeasured',
      reason: 'Sem termos econômicos aprovados: não há margem a calcular.',
    };
  if (result.projected_margin === null)
    return {
      health: 'incomplete',
      reason:
        'Margem indisponível até completar os dados listados; ausência não é zero.',
    };
  const m = moneyGrouped(result.projected_margin, result.currency);
  if (BigInt(result.projected_margin) < 0n)
    return {
      health: 'negative',
      reason: `Projeção de conclusão com prejuízo de ${m}.`,
    };
  const risks: string[] = [];
  if (BigInt(result.projected_margin) === 0n)
    risks.push('margem projetada zero');
  if ((result.hours_variance_minutes ?? 0) > 0)
    risks.push(
      `${signedHours(result.hours_variance_minutes!)} sobre o previsto`,
    );
  if (positive(result.cost_variance))
    risks.push(
      `custo ${moneyGrouped(result.cost_variance, result.currency)} acima do orçamento`,
    );
  if (
    result.capacity_minutes !== null &&
    (result.remaining_minutes ?? 0) > result.capacity_minutes
  )
    risks.push('restante acima da capacidade declarada');
  if (blocked) risks.push(`${blocked} demanda(s) bloqueada(s)`);
  if (uncovered) risks.push(`${uncovered} demanda(s) sem cobertura comercial`);
  if (risks.length)
    return {
      health: 'at_risk',
      reason: `Margem de ${m} ainda positiva, mas com ${risks.join(', ')}.`,
    };
  return {
    health: 'positive',
    reason: `Margem de ${m} sem desvio de horas ou custo.`,
  };
}

interface MissingRule {
  match: (engineText: string) => boolean;
  label: string;
  kind: 'config' | 'rate' | 'terms' | 'estimate' | 'capacity' | 'commercial';
}
// Engine messages stay canonical (they are stored in reports); this only translates them.
const missingRules: MissingRule[] = [
  {
    match: (m) => m.startsWith('configuração econômica'),
    label: 'Premissas (tributos, comissões e overhead) aprovadas',
    kind: 'config',
  },
  {
    match: (m) => m === 'overhead vigente',
    label: 'Taxa de overhead vigente',
    kind: 'config',
  },
  {
    match: (m) =>
      m.startsWith('taxa/câmbio das horas') ||
      m.startsWith('taxa vigente da estimativa'),
    label: 'Custo por hora vigente na mesma moeda',
    kind: 'rate',
  },
  {
    match: (m) =>
      m === 'estimativas aprovadas' || m.startsWith('estimativa para item'),
    label: 'Estimativa aprovada de item do escopo',
    kind: 'estimate',
  },
  {
    match: (m) => m === 'capacidade explícita',
    label: 'Capacidade alocada declarada',
    kind: 'capacity',
  },
  {
    match: (m) => m === 'declaração de apontamentos completos',
    label: 'Declaração de que os apontamentos estão completos',
    kind: 'terms',
  },
  {
    match: (m) => m === 'declaração de custos externos completos',
    label: 'Declaração de que os custos externos estão completos',
    kind: 'terms',
  },
  {
    match: (m) =>
      m.startsWith('minutos incluídos') ||
      m.startsWith('taxa/previsão de excedente') ||
      m.startsWith('moeda do custo'),
    label: 'Termos ou custos em conflito com o contrato',
    kind: 'terms',
  },
  {
    match: (m) => m.startsWith('cobertura M3'),
    label: 'Contrato vigente e escopo aprovado',
    kind: 'commercial',
  },
];
const handledElsewhere = (m: string) =>
  m === 'horas pendentes de decisão' || m.startsWith('atividade sem cobertura');
const staticLabels: [(m: string) => boolean, string][] = [
  [(m) => m === 'horas pendentes de decisão', 'Decisão de horas pendentes'],
  [
    (m) => m.startsWith('atividade sem cobertura'),
    'Cobertura comercial de horas apontadas',
  ],
  [
    (m) => m.startsWith('receita reconhecida'),
    'Receita reconhecida por regra explícita',
  ],
];
export function humanMissing(list: string[]): MissingItem[] {
  const counts = new Map<string, number>();
  for (const m of list) {
    const label =
      missingRules.find((r) => r.match(m))?.label ??
      staticLabels.find(([f]) => f(m))?.[1] ??
      m;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count }));
}

export interface DemandRef {
  id: string;
  title: string;
  owner: string;
  next_action: string;
  logged_minutes: number;
}
export interface ActionFacts {
  project_id: string;
  result: EconomicsResult | null;
  hours: HoursLine[];
  blocked: DemandRef[];
  uncovered: DemandRef[];
  pending_hours: { minutes: number; deciders: string }[];
  pending_records: { kind: string; deciders: string }[];
  /** Next commercial step when no approved terms exist; null when terms can be prepared. */
  commercial_gap: { action: string; owner: string; basis: string } | null;
  decisionMakers: string;
  pos: string;
}
const recordNames: Record<string, string> = {
  config: 'premissas econômicas',
  rate: 'custo por hora',
  terms: 'termos econômicos',
  estimate: 'estimativa',
  capacity: 'capacidade',
  direct_cost: 'despesa',
};
/** Ordered by what most directly protects profit first; the first one is "do this now". */
export function recommendActions(f: ActionFacts): RecommendedAction[] {
  const r = f.result,
    out: RecommendedAction[] = [],
    economia = (query: Record<string, string>) => ({
      route: 'economia' as const,
      query: { projeto: f.project_id, ...query },
    }),
    money = (v: string | null) => moneyGrouped(v, r?.currency ?? 'BRL');
  const worst = [...f.hours]
    .filter((h) => (h.variance_minutes ?? 0) > 0)
    .sort((a, b) => b.variance_minutes! - a.variance_minutes!)[0];
  if (r?.projected_margin && BigInt(r.projected_margin) < 0n)
    out.push({
      code: 'margin_negative',
      action: 'Decidir entre aditivo comercial e redução de escopo',
      owner: f.decisionMakers,
      owner_basis: 'Gestor/administrador com alçada comercial',
      reason: `Margem projetada de ${money(r.projected_margin)} (${percentLabel(r.projected_margin_bps)}): custo previsto de ${money(r.eac)} para receita de ${money(r.projected_revenue)}.`,
      target: { route: 'comercial' },
    });
  if (f.pending_hours.length) {
    const minutes = f.pending_hours.reduce((a, h) => a + h.minutes, 0);
    out.push({
      code: 'hours_pending',
      action: `Decidir ${hoursLabel(minutes)} apontadas e pendentes`,
      owner: [...new Set(f.pending_hours.map((h) => h.deciders))].join(' · '),
      owner_basis: 'Gestor/administrador diferente de quem apontou',
      reason:
        'Horas pendentes não viram custo realizado e deixam a margem indisponível.',
      target: economia({ painel: 'horas' }),
    });
  }
  for (const kind of new Set(f.pending_records.map((x) => x.kind))) {
    const group = f.pending_records.filter((x) => x.kind === kind);
    out.push({
      code: 'record_pending',
      action: `Decidir ${recordNames[kind] ?? kind} em ${group.length} ${group.length === 1 ? 'versão preparada' : 'versões preparadas'}`,
      owner: [...new Set(group.map((x) => x.deciders))].join(' · '),
      owner_basis: 'Alçada comercial, diferente de quem preparou',
      reason: 'Registro preparado só produz efeito após decisão independente.',
      target: economia({ painel: 'decisoes' }),
    });
  }
  for (const d of f.blocked)
    out.push({
      code: 'blocked',
      action: `Desbloquear “${d.title}”: ${d.next_action}`,
      owner: d.owner,
      owner_basis: 'Responsável pela demanda',
      reason: 'Demanda bloqueada; a próxima ação registrada é a indicada.',
      target: { route: 'solicitacoes', query: { estado: 'blocked' } },
    });
  // Upstream of coverage: without an approved scope no demand can be covered at all.
  if (!r && f.commercial_gap)
    out.push({
      code: 'commercial_gap',
      action: f.commercial_gap.action,
      owner: f.commercial_gap.owner,
      owner_basis: f.commercial_gap.basis,
      reason: 'Termos econômicos exigem contrato ativo e escopo aprovado.',
      target: { route: 'comercial' },
    });
  for (const d of f.uncovered)
    out.push({
      code: 'uncovered',
      action: `Analisar cobertura comercial de “${d.title}”`,
      owner: f.pos,
      owner_basis: 'PO da organização',
      reason: d.logged_minutes
        ? `${hoursLabel(d.logged_minutes)} já apontadas sem item de escopo aprovado: trabalho que pode não ser receita.`
        : 'Demanda aberta sem item de escopo aprovado.',
      target: { route: 'comercial', query: { demanda: d.id } },
    });
  if (r && (r.hours_variance_minutes ?? 0) > 0)
    out.push({
      code: 'hours_overrun',
      action: worst
        ? `Reavaliar “${worst.title}”: confirmar o restante ou abrir change request`
        : 'Reavaliar horas restantes e abrir change request se preciso',
      owner: worst?.owner ?? f.decisionMakers,
      owner_basis: worst ? 'Responsável pela demanda' : 'Gestor com alçada',
      reason: `Previsto ${hoursLabel(r.planned_minutes)}; realizado ${hoursLabel(r.approved_minutes)} + restante ${hoursLabel(r.remaining_minutes)} = ${signedHours(r.hours_variance_minutes!)}${positive(r.cost_variance) ? `; custo ${money(r.cost_variance)} acima do orçamento` : ''}.`,
      target: economia({ painel: 'decisoes' }),
    });
  if (
    r &&
    r.capacity_minutes !== null &&
    (r.remaining_minutes ?? 0) > r.capacity_minutes
  )
    out.push({
      code: 'capacity',
      action: 'Realocar capacidade ou rever o prazo',
      owner: f.decisionMakers,
      owner_basis: 'Gestor com alçada',
      reason: `Restam ${hoursLabel(r.remaining_minutes)} para ${hoursLabel(r.capacity_minutes)} de capacidade declarada.`,
      target: economia({ preparar: 'capacity' }),
    });
  for (const h of f.hours.filter((h) => h.overdue))
    out.push({
      code: 'overdue',
      action: `Replanejar “${h.title}”: prazo de ${dayLabel(h.expected_on)} vencido`,
      owner: h.owner,
      owner_basis: 'Responsável pela demanda',
      reason: `Ainda restam ${hoursLabel(h.remaining_minutes)} estimadas.`,
      target: { route: 'solicitacoes' },
    });
  if (r) {
    const seen = new Set<string>();
    for (const m of r.projection_missing) {
      if (handledElsewhere(m)) continue;
      const rule = missingRules.find((x) => x.match(m));
      if (!rule || seen.has(rule.label)) continue;
      seen.add(rule.label);
      out.push({
        code: 'missing_' + rule.kind,
        action: `Completar: ${rule.label.toLowerCase()}`,
        owner: rule.kind === 'estimate' ? f.pos : f.decisionMakers,
        owner_basis:
          rule.kind === 'estimate' ? 'PO da organização' : 'Gestor/admin',
        reason: 'Sem este dado a margem projetada fica indisponível.',
        target:
          rule.kind === 'commercial'
            ? { route: 'comercial' }
            : economia({ preparar: rule.kind }),
      });
    }
  } else if (!f.commercial_gap)
    out.push({
      code: 'terms_missing',
      action: 'Preparar os termos econômicos do projeto',
      owner: f.decisionMakers,
      owner_basis: 'Gestor/admin',
      reason: 'Contrato e escopo existem, mas sem receita e regra aprovadas.',
      target: economia({ preparar: 'terms' }),
    });
  return out;
}
