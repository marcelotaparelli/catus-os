// GET /api/overview: a read-only, role-filtered reading of records that already exist.
// It persists nothing and recalculates with the M4 engine, so it can never disagree with
// a report generated from the same data. Money is built only in the financial branch.
import { calculate } from './engine';
import { allRecords, current, financial, observe, times } from './service';
import { assessHealth, humanMissing, recommendActions } from './insights';
import type { DemandRef } from './insights';
import { authorize } from '../auth/policy';
import type { Context } from '../auth/policy';
import { getMembers, getMissionControl } from '../modules/mission-control';
import { dayLabel } from '../../shared/economics';
import type { EconomicRecord } from '../../shared/economics';
import type {
  FinancialOverview,
  GovernanceCheck,
  HoursLine,
  OperationalOverview,
  Overview,
  PersonalOverview,
  ProjectOverview,
} from '../../shared/overview';
import { healthOrder } from '../../shared/overview';
import type { Role } from '../../shared/identity';

const utcToday = () => new Date().toISOString().slice(0, 10);
const list = (names: string[], none: string) =>
  names.length ? names.join(' ou ') : none;

type Member = { id: string; name: string; role: Role };
type Mission = Awaited<ReturnType<typeof getMissionControl>>;
type Request = {
  id: string;
  title: string;
  status: string;
  owner: string;
  owner_user_id: string | null;
  next_action: string;
  project_id: string;
  project_name: string;
  client_name: string;
  commercial_coverage: string;
};

/** People allowed to decide; `except` keeps approval independent from the preparer. */
function deciders(members: Member[], approvalRoles: string[], except?: string) {
  return list(
    members
      .filter((m) => approvalRoles.includes(m.role) && m.id !== except)
      .map((m) => m.name),
    'Nenhum membro elegível: provisione um aprovador independente',
  );
}
function hoursLines(
  requests: Request[],
  estimates: EconomicRecord[],
  entries: { request_id: string; minutes: number; state: string }[],
  today: string,
): HoursLine[] {
  const ids = new Set([
    ...estimates.map((e) => String(e.payload.request_id)),
    ...entries
      .filter((t) => ['approved', 'pending'].includes(t.state))
      .map((t) => t.request_id),
  ]);
  return [...ids]
    .map((id) => {
      const r = requests.find((x) => x.id === id),
        own = estimates.filter((e) => e.payload.request_id === id),
        sum = (key: string) =>
          own.length
            ? own.reduce((a, e) => a + Number(e.payload[key]), 0)
            : null,
        minutes = (state: string) =>
          entries
            .filter((t) => t.request_id === id && t.state === state)
            .reduce((a, t) => a + t.minutes, 0),
        planned = sum('planned_minutes'),
        remaining = sum('remaining_minutes'),
        approved = minutes('approved'),
        expected = own.length
          ? own
              .map((e) => String(e.payload.expected_on))
              .sort()
              .at(-1)!
          : null;
      return {
        request_id: id,
        title: r?.title ?? 'Demanda fora da lista carregada',
        owner: r?.owner ?? 'Desconhecido',
        status: r?.status ?? 'unknown',
        planned_minutes: planned,
        approved_minutes: approved,
        pending_minutes: minutes('pending'),
        remaining_minutes: remaining,
        variance_minutes:
          planned === null || remaining === null
            ? null
            : approved + remaining - planned,
        expected_on: expected,
        overdue:
          expected !== null &&
          expected < today &&
          (remaining ?? 0) > 0 &&
          r?.status !== 'done',
      };
    })
    .sort(
      (a, b) =>
        (b.variance_minutes ?? -Infinity) - (a.variance_minutes ?? -Infinity),
    );
}

async function financialOverview(ctx: Context): Promise<FinancialOverview> {
  financial(ctx);
  const today = utcToday(),
    mission: Mission = await getMissionControl(ctx),
    requests = mission.requests as Request[],
    members = (await getMembers(ctx)) as Member[],
    records = await allRecords(ctx),
    approved = current(records),
    entries = await times(ctx);
  const { rows: contracts } = await ctx.db.query(
      "SELECT id,project_id,title,state,(now() AT TIME ZONE 'UTC')::date BETWEEN valid_from AND valid_until AS current_valid FROM contracts WHERE organization_id=$1",
      [ctx.organizationId],
    ),
    { rows: scopes } = await ctx.db.query(
      'SELECT id,project_id,contract_id,number,state FROM scope_versions WHERE organization_id=$1',
      [ctx.organizationId],
    ),
    policy = (
      await ctx.db.query(
        'SELECT approval_roles,version FROM commercial_policies WHERE organization_id=$1',
        [ctx.organizationId],
      )
    ).rows[0],
    { rows: reports } = await ctx.db.query(
      'SELECT DISTINCT ON (project_id,terms_id) id,project_id,terms_id,as_of,created_at,input_hash,result FROM economic_reports WHERE organization_id=$1 ORDER BY project_id,terms_id,created_at DESC,id DESC',
      [ctx.organizationId],
    );
  const roles: string[] = policy?.approval_roles ?? [
      'manager',
      'administrator',
    ],
    decisionMakers = deciders(members, roles),
    pos = list(
      members.filter((m) => m.role === 'po').map((m) => m.name),
      decisionMakers,
    ),
    hourDeciders = (uid: string) =>
      deciders(members, ['manager', 'administrator'], uid);
  const projects: ProjectOverview[] = [];
  for (const p of mission.projects as {
    id: string;
    client_id: string;
    name: string;
  }[]) {
    const own = requests.filter((r) => r.project_id === p.id),
      open = own.filter((r) => r.status !== 'done'),
      term = approved
        .filter(
          (r) =>
            r.kind === 'terms' &&
            r.project_id === p.id &&
            r.valid_from <= today,
        )
        .sort((a, b) => b.valid_until.localeCompare(a.valid_until))[0];
    const projectEntries = entries.filter((t) => t.project_id === p.id),
      logged = (id: string) =>
        projectEntries
          .filter(
            (t) =>
              t.request_id === id && ['approved', 'pending'].includes(t.state),
          )
          .reduce((a, t) => a + t.minutes, 0),
      ref = (r: Request): DemandRef => ({
        id: r.id,
        title: r.title,
        owner: r.owner,
        next_action: r.next_action,
        logged_minutes: logged(r.id),
      }),
      blocked = open.filter((r) => r.status === 'blocked').map(ref),
      uncovered = open
        .filter((r) => r.commercial_coverage !== 'covered')
        .map(ref);
    let result = null,
      hours: HoursLine[] = [],
      source: ProjectOverview['source'] = null,
      scoped = projectEntries;
    if (term) {
      const asOf = term.valid_until < today ? term.valid_until : today,
        seen = await observe(ctx, approved, entries, term, asOf);
      result = calculate(seen.input);
      scoped = seen.entries;
      hours = hoursLines(requests, seen.estimates, seen.entries, today);
      const contract = contracts.find((c) => c.id === term.payload.contract_id),
        scope = scopes.find((s) => s.id === term.payload.scope_id),
        latest = reports.find((x) => x.terms_id === term.id);
      source = {
        terms_id: term.id,
        terms_revision: term.revision,
        terms_source: term.source,
        regime: seen.input.regime,
        contract_title: contract?.title ?? 'Contrato não encontrado',
        scope_number: scope?.number ?? null,
        approved_time_entries: seen.input.actuals.length,
        approved_estimates: seen.estimates.length,
        latest_report: latest
          ? {
              id: latest.id,
              as_of:
                latest.as_of instanceof Date
                  ? latest.as_of.toISOString().slice(0, 10)
                  : String(latest.as_of).slice(0, 10),
              created_at: latest.created_at,
              input_hash: latest.input_hash,
              matches_live:
                latest.result.eac === result.eac &&
                latest.result.projected_margin === result.projected_margin &&
                latest.result.cost_incurred === result.cost_incurred,
            }
          : null,
      };
    }
    const pendingByUser = new Map<string, number>();
    for (const t of scoped.filter((t) => t.state === 'pending'))
      pendingByUser.set(
        t.user_id,
        (pendingByUser.get(t.user_id) ?? 0) + t.minutes,
      );
    const contract = contracts
        .filter((c) => c.project_id === p.id)
        .sort(
          (a, b) => Number(b.state === 'active') - Number(a.state === 'active'),
        )[0],
      scopeRows = scopes.filter((s) => s.project_id === p.id),
      gapScope =
        scopeRows.find((s) => s.state === 'submitted') ??
        scopeRows.find((s) => s.state === 'draft');
    const commercialGap = !contract
      ? {
          action: 'Registrar o contrato do projeto',
          owner: pos,
          basis: 'PO da organização',
        }
      : contract.state !== 'active' || !contract.current_valid
        ? {
            action: 'Ativar ou renovar o contrato do projeto',
            owner: decisionMakers,
            basis: 'Gestor/administrador',
          }
        : gapScope?.state === 'submitted'
          ? {
              action: 'Decidir o escopo submetido',
              owner: decisionMakers,
              basis: 'Alçada comercial',
            }
          : !scopeRows.some((s) => s.state === 'approved')
            ? {
                action: 'Preparar e submeter o escopo do projeto',
                owner: pos,
                basis: 'PO da organização',
              }
            : null;
    const health = assessHealth(result, blocked.length, uncovered.length);
    projects.push({
      project_id: p.id,
      project_name: p.name,
      client_name:
        (mission.clients as { id: string; name: string }[]).find(
          (c) => c.id === p.client_id,
        )?.name ?? '',
      health: health.health,
      health_reason: health.reason,
      result,
      source,
      projection_missing: humanMissing(result?.projection_missing ?? []),
      actual_missing: humanMissing(result?.actual_missing ?? []),
      hours,
      open_requests: open.length,
      blocked_requests: blocked.length,
      uncovered_requests: uncovered.length,
      actions: recommendActions({
        project_id: p.id,
        result,
        hours,
        blocked,
        uncovered,
        pending_hours: [...pendingByUser].map(([user, minutes]) => ({
          minutes,
          deciders: hourDeciders(user),
        })),
        pending_records: records
          .filter((r) => r.project_id === p.id && !r.decision)
          .map((r) => ({
            kind: r.kind,
            deciders: deciders(members, roles, r.created_by),
          })),
        commercial_gap: commercialGap,
        decisionMakers,
        pos,
      }),
    });
  }
  projects.sort(
    (a, b) => healthOrder.indexOf(a.health) - healthOrder.indexOf(b.health),
  );
  const orgPending = records.filter((r) => !r.project_id && !r.decision);
  const out: FinancialOverview = {
    kind: 'financial',
    as_of: today,
    projects,
    organization_actions: orgPending.map((r) => ({
      code: 'record_pending',
      action: `Decidir ${r.kind === 'config' ? 'premissas econômicas' : 'custo por hora'} preparado`,
      owner: deciders(members, roles, r.created_by),
      owner_basis: 'Alçada comercial, diferente de quem preparou',
      reason: 'Vale para toda a organização e só produz efeito após decisão.',
      target: { route: 'economia', query: { painel: 'decisoes' } },
    })),
  };
  if (ctx.role === 'administrator') {
    const eligible = members.filter((m) => roles.includes(m.role)).length,
      unlinked = requests.filter((r) => !r.owner_user_id).length,
      pendingRecords = records.filter((r) => !r.decision).length,
      pendingHours = entries.filter((t) => t.state === 'pending').length,
      lastAudit = (
        await ctx.db.query(
          'SELECT created_at FROM audit_events WHERE organization_id=$1 ORDER BY id DESC LIMIT 1',
          [ctx.organizationId],
        )
      ).rows[0]?.created_at,
      checks: GovernanceCheck[] = [
        {
          id: 'policy',
          label: 'Alçada comercial',
          ok: !!policy,
          detail: policy
            ? `Política v${policy.version}: decidem ${roles.map((r) => (r === 'manager' ? 'gestores' : 'administradores')).join(' e ')}.`
            : 'Não configurada: escopos e registros econômicos não podem ser decididos.',
          target: { route: 'comercial' },
        },
        {
          id: 'independent',
          label: 'Aprovação independente',
          ok: eligible >= 2,
          detail: `${eligible} ${eligible === 1 ? 'pessoa pode' : 'pessoas podem'} decidir; são necessárias ao menos 2 para separar preparo e decisão.`,
          target: { route: 'acesso' },
        },
        {
          id: 'pending',
          label: 'Decisões econômicas em dia',
          ok: !pendingRecords && !pendingHours,
          detail: `${pendingRecords} ${pendingRecords === 1 ? 'registro pendente' : 'registros pendentes'} e ${pendingHours} ${pendingHours === 1 ? 'apontamento pendente' : 'apontamentos pendentes'}.`,
          target: { route: 'economia', query: { painel: 'decisoes' } },
        },
        {
          id: 'owners',
          label: 'Responsáveis vinculados',
          ok: !unlinked,
          detail: unlinked
            ? `${unlinked} ${unlinked === 1 ? 'solicitação usa' : 'solicitações usam'} responsável legado sem vínculo a um membro.`
            : 'Toda solicitação carregada tem responsável vinculado a um membro.',
          target: {
            route: 'solicitacoes',
            query: { responsavel: 'unassigned' },
          },
        },
        {
          id: 'audit',
          label: 'Trilha de auditoria',
          ok: !!lastAudit,
          detail: lastAudit
            ? 'Eventos registrados por ator; consulte a trilha completa.'
            : 'Nenhum evento registrado nesta organização.',
          target: { route: 'auditoria' },
        },
      ];
    out.governance = {
      members_by_role: {
        administrator: members.filter((m) => m.role === 'administrator').length,
        manager: members.filter((m) => m.role === 'manager').length,
        po: members.filter((m) => m.role === 'po').length,
        developer: members.filter((m) => m.role === 'developer').length,
      },
      checks,
    };
  }
  return out;
}

async function operationalOverview(ctx: Context): Promise<OperationalOverview> {
  const today = utcToday(),
    mission = await getMissionControl(ctx),
    requests = mission.requests as Request[],
    members = (await getMembers(ctx)) as Member[],
    approved = current(await allRecords(ctx)).filter(
      (r) => r.kind === 'estimate',
    );
  const { rows: scopes } = await ctx.db.query(
      "SELECT s.id,s.title,s.number,s.state,p.name project_name FROM scope_versions s JOIN projects p ON p.id=s.project_id AND p.organization_id=s.organization_id WHERE s.organization_id=$1 AND s.state IN ('draft','submitted') ORDER BY s.created_at,s.id",
      [ctx.organizationId],
    ),
    pendingChanges = Number(
      (
        await ctx.db.query(
          "SELECT count(*) n FROM change_requests WHERE organization_id=$1 AND state='pending'",
          [ctx.organizationId],
        )
      ).rows[0].n,
    ),
    policy = (
      await ctx.db.query(
        'SELECT approval_roles FROM commercial_policies WHERE organization_id=$1',
        [ctx.organizationId],
      )
    ).rows[0];
  const decisionMakers = deciders(
    members,
    policy?.approval_roles ?? ['manager', 'administrator'],
  );
  const demands = requests
    .filter((r) => r.status !== 'done')
    .map((r) => {
      const own = approved.filter((e) => e.payload.request_id === r.id),
        latest = own
          .map((e) => e.valid_until)
          .sort()
          .at(-1),
        base = own.filter((e) => e.valid_until === latest),
        sum = (key: string) =>
          base.length
            ? base.reduce((a, e) => a + Number(e.payload[key]), 0)
            : null,
        expected = base.length
          ? base
              .map((e) => String(e.payload.expected_on))
              .sort()
              .at(-1)!
          : null,
        remaining = sum('remaining_minutes');
      return {
        id: r.id,
        title: r.title,
        project_name: r.project_name,
        client_name: r.client_name,
        status: r.status,
        owner: r.owner,
        next_action: r.next_action,
        covered: r.commercial_coverage === 'covered',
        expected_on: expected,
        planned_minutes: sum('planned_minutes'),
        remaining_minutes: remaining,
        overdue: expected !== null && expected < today && (remaining ?? 0) > 0,
      };
    })
    .sort(
      (a, b) =>
        Number(b.status === 'blocked') - Number(a.status === 'blocked') ||
        Number(b.overdue) - Number(a.overdue) ||
        (a.expected_on ?? '9999').localeCompare(b.expected_on ?? '9999'),
    );
  const pos = list(
    members.filter((m) => m.role === 'po').map((m) => m.name),
    ctx.name,
  );
  const actions: OperationalOverview['actions'] = [
    ...demands
      .filter((d) => d.status === 'blocked')
      .map((d) => ({
        code: 'blocked',
        action: `Destravar “${d.title}”: ${d.next_action}`,
        owner: d.owner,
        owner_basis: 'Responsável pela demanda',
        reason: `Bloqueada em ${d.project_name}.`,
        target: {
          route: 'solicitacoes' as const,
          query: { estado: 'blocked' },
        },
      })),
    ...demands
      .filter((d) => d.overdue)
      .map((d) => ({
        code: 'overdue',
        action: `Replanejar “${d.title}”: prazo de ${dayLabel(d.expected_on)} vencido`,
        owner: d.owner,
        owner_basis: 'Responsável pela demanda',
        reason: `Prazo estimado vencido em ${d.project_name}.`,
        target: { route: 'solicitacoes' as const },
      })),
    ...demands
      .filter((d) => !d.covered)
      .map((d) => ({
        code: 'uncovered',
        action: `Vincular “${d.title}” a um item de escopo`,
        owner: pos,
        owner_basis: 'PO da organização',
        reason: `Sem cobertura comercial em ${d.project_name}.`,
        target: { route: 'comercial' as const },
      })),
    ...scopes.map((s) =>
      s.state === 'draft'
        ? {
            code: 'scope_draft',
            action: `Submeter o escopo “${s.title}” (V${s.number})`,
            owner: pos,
            owner_basis: 'PO da organização',
            reason: `Rascunho sem efeito comercial em ${s.project_name}.`,
            target: { route: 'comercial' as const },
          }
        : {
            code: 'scope_submitted',
            action: `Cobrar a decisão do escopo “${s.title}” (V${s.number})`,
            owner: decisionMakers,
            owner_basis: 'Alçada comercial',
            reason: `Submetido e aguardando decisão em ${s.project_name}.`,
            target: { route: 'comercial' as const },
          },
    ),
    ...demands
      .filter((d) => d.covered && d.planned_minutes === null)
      .map((d) => ({
        code: 'estimate_missing',
        action: `Estimar “${d.title}”`,
        owner: pos,
        owner_basis: 'PO da organização',
        reason: `Coberta, sem estimativa aprovada em ${d.project_name}.`,
        target: {
          route: 'economia' as const,
          query: { preparar: 'estimate', demanda: d.id },
        },
      })),
  ];
  return {
    kind: 'operational',
    as_of: today,
    demands,
    scopes,
    pending_changes: pendingChanges,
    actions,
  };
}

async function personalOverview(ctx: Context): Promise<PersonalOverview> {
  const own = (await times(ctx)).filter((t) => t.user_id === ctx.userId),
    sum = (state: string) =>
      own.filter((t) => t.state === state).reduce((a, t) => a + t.minutes, 0),
    logged: Record<string, number> = {};
  for (const t of own.filter((t) => ['approved', 'pending'].includes(t.state)))
    logged[t.request_id] = (logged[t.request_id] ?? 0) + t.minutes;
  const corrected = new Set(
    own.map(
      (t) => (t as unknown as { replaces_id: string | null }).replaces_id,
    ),
  );
  return {
    kind: 'personal',
    as_of: utcToday(),
    hours: {
      pending: sum('pending'),
      approved: sum('approved'),
      rejected: sum('rejected'),
    },
    logged_by_request: logged,
    rejected: own
      .filter((t) => t.state === 'rejected' && !corrected.has(t.id))
      .map((t) => ({
        id: t.id,
        work_date: t.work_date,
        minutes: t.minutes,
        comment: t.comment,
      })),
  };
}

export async function overview(ctx: Context): Promise<Overview> {
  authorize(ctx, 'read');
  if (ctx.role === 'developer') return personalOverview(ctx);
  if (ctx.role === 'po') return operationalOverview(ctx);
  return financialOverview(ctx);
}
