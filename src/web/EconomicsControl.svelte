<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { idempotentPost } from './ui/post';
  import { timeLabel } from '../shared/domain';
  import { roleLabels } from '../shared/identity';
  import type { Snapshot } from '../shared/domain';
  import type { Member } from '../shared/identity';
  import type {
    EconomicKind,
    EconomicRecord,
    EconomicsResult,
    EconomicsView,
    TimeEntry,
  } from '../shared/economics';
  import {
    dayLabel,
    hoursLabel,
    moneyGrouped,
    percentLabel,
  } from '../shared/economics';
  import type { CommercialSnapshot } from '../shared/commercial';
  import { currencies } from '../shared/commercial';
  import UnitField from './ui/UnitField.svelte';
  let {
    api,
    data,
    members,
    role,
    userId,
    query,
    onChanged,
  }: {
    api: <T>(
      path: string,
      method?: string,
      body?: unknown,
      key?: string,
    ) => Promise<T>;
    data: Snapshot;
    members: Member[];
    role: string;
    userId: string;
    /** Deep link from the executive reading: opens the right area, already filled. */
    query?: URLSearchParams;
    /** Reloads projects and demands, which other people may have just created. */
    onChanged?: () => Promise<void>;
  } = $props();
  let view = $state<EconomicsView>({
    records: [],
    times: [],
    reports: [],
    events: [],
  });
  let commercial = $state<CommercialSnapshot>({
    contracts: [],
    scopes: [],
    changes: [],
    policy: null,
    events: [],
  });
  let busy = $state(false),
    loaded = $state(false),
    error = $state(''),
    notice = $state('');
  let confidential = $derived(['manager', 'administrator'].includes(role));

  type TabId = 'decidir' | 'preparar' | 'horas' | 'rentabilidade' | 'auditoria';
  // Each role lands on its main task; the server still decides what it may see and do.
  let tab = $state<TabId>(
    untrack(() =>
      role === 'developer'
        ? 'horas'
        : ['manager', 'administrator'].includes(role)
          ? 'decidir'
          : 'preparar',
    ),
  );
  let kind = $state<EconomicKind | ''>(''),
    project = $state(''),
    cur = $state('BRL'),
    from = $state(''),
    until = $state(''),
    source = $state(''),
    previous = $state<EconomicRecord | null>(null);
  let tax = $state<number | undefined>(),
    commission = $state<number | undefined>(),
    ohRule = $state(''),
    ohRate = $state(''),
    workdays = $state([1, 2, 3, 4, 5]),
    minutesDay = $state<number | undefined>(480),
    holidays = $state('');
  let person = $state(''),
    functionRole = $state(''),
    rate = $state('');
  let contractId = $state(''),
    scopeId = $state(''),
    amount = $state(''),
    recognition = $state(''),
    recognized = $state(''),
    directComplete = $state(false),
    timeComplete = $state(false),
    included = $state<number | undefined>(),
    overage = $state('none'),
    overageRate = $state(''),
    rollover = $state('none'),
    cap = $state<number | undefined>(0),
    carry = $state<number | undefined>(0),
    priorTerms = $state(''),
    changeId = $state('');
  let terms = $state(''),
    request = $state(''),
    planned = $state<number | undefined>(),
    remaining = $state<number | undefined>(),
    expected = $state(''),
    available = $state<number | undefined>();
  let expense = $state(''),
    classification = $state(''),
    budget = $state(''),
    incurred = $state(''),
    future = $state('');
  const today = new Date().toISOString().slice(0, 10);
  let asOf = $state(today);
  let timeRequest = $state(''),
    workDate = $state(today),
    duration = $state<number | undefined>(),
    comment = $state(''),
    replaces = $state('');
  let reason = $state(''),
    reasonMissing = $state(false),
    costRole = $state('');
  let reversing = $state(''),
    reverseReason = $state(''),
    reverseMissing = $state(false);
  let projectFilter = $state(''),
    stateFilter = $state(''),
    hourLimit = $state(20),
    recordLimit = $state(4),
    showHistory = $state(false);
  let reasonInput = $state<HTMLInputElement>(),
    prepareForm = $state<HTMLElement>();

  const names: Record<EconomicKind, string> = {
    config: 'Premissas econômicas',
    rate: 'Custo por hora',
    terms: 'Termos econômicos',
    estimate: 'Estimativa de esforço',
    capacity: 'Capacidade alocada',
    direct_cost: 'Despesa externa/direta',
  };
  const kindHelp: Record<EconomicKind, string> = {
    config: 'Tributos, comissões, overhead e calendário da agência.',
    rate: 'Quanto custa a hora de uma pessoa ou função.',
    terms: 'Receita do contrato e como ela é reconhecida.',
    estimate: 'Horas previstas e restantes de uma demanda.',
    capacity: 'Horas que uma pessoa tem disponíveis para o projeto.',
    direct_cost: 'Fornecedor ou despesa ligada ao projeto.',
  };
  const roleNames: Record<string, string> = roleLabels;
  const hourStates: Record<TimeEntry['state'], string> = {
    approved: 'Aprovadas',
    pending: 'Pendentes',
    reversed: 'Revertidas',
    rejected: 'Rejeitadas',
  };
  const weekdayNames = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

  $effect(() => {
    const q = query;
    if (!q || ![...q.keys()].length) return;
    const wanted = q.get('preparar') as EconomicKind | null,
      panel = q.get('painel'),
      target = q.get('projeto') ?? '',
      demand = q.get('demanda') ?? '';
    untrack(() => {
      projectFilter = target;
      if (
        wanted &&
        wanted in names &&
        (confidential || wanted === 'estimate')
      ) {
        kind = wanted;
        previous = null;
        project = target;
        if (wanted === 'estimate' && demand) chooseDemand(demand);
        tab = 'preparar';
      } else if (panel === 'apontar') {
        timeRequest = demand;
        tab = 'horas';
      } else if (panel === 'decisoes' || panel === 'horas') {
        tab = confidential ? 'decidir' : 'horas';
      } else if (confidential && target) tab = 'rentabilidade';
    });
  });

  // Members are display-only context; authorization stays on the server.
  function who(id: unknown) {
    if (!id) return 'Sistema';
    return members.find((m) => m.id === id)?.name ?? String(id);
  }
  const projectName = (id: unknown) =>
    data.projects.find((p) => p.id === id)?.name ?? 'Projeto indisponível';
  function requestProject(id: string) {
    const r = data.requests.find((x) => x.id === id);
    return data.interactions.find((i) => i.id === r?.interaction_id)
      ?.project_id;
  }
  const requestTitle = (id: unknown) =>
    data.requests.find((r) => r.id === id)?.title ?? 'Demanda indisponível';

  const post = untrack(() => idempotentPost(api));
  async function refresh() {
    const [economics, contracts] = await Promise.all([
      api<EconomicsView>('economics'),
      role === 'developer' ? null : api<CommercialSnapshot>('commercial'),
    ]);
    view = economics;
    if (contracts) commercial = contracts;
    loaded = true;
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      await fn();
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Falha na operação';
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    if (role === 'po' && !kind) kind = 'estimate';
    void run(async () => {});
  });

  // The contract already defines currency, period and (usually) the approved scope.
  let chosenContract = $derived(
    commercial.contracts.find((c) => c.id === contractId),
  );
  let retainer = $derived(chosenContract?.kind === 'retainer');
  function chooseContract() {
    const c = chosenContract;
    if (!c) return;
    cur = c.currency;
    if (!from) from = String(c.valid_from).slice(0, 10);
    if (!until) until = String(c.valid_until).slice(0, 10);
    const approved = commercial.scopes.filter(
      (s) =>
        s.project_id === project &&
        s.contract_id === c.id &&
        s.state === 'approved',
    );
    scopeId = approved.length === 1 ? approved[0]!.id : '';
  }
  function chooseTerm(id: string) {
    const t = view.records.find((r) => r.id === id);
    if (t) {
      terms = id;
      project = t.project_id ?? '';
      cur = t.currency;
      from = t.valid_from;
      until = t.valid_until;
    }
  }
  /** A demand already says which project it belongs to and who works on it. */
  function chooseDemand(id: string) {
    request = id;
    project = requestProject(id) ?? '';
    const owner = data.requests.find((r) => r.id === id)?.owner_user_id;
    if (owner) person = owner;
  }
  let approvedTerms = $derived(
    view.records.filter((r) => r.kind === 'terms' && r.decision === 'approved'),
  );
  let projectTerms = $derived(
    approvedTerms.filter((r) => r.project_id === project),
  );
  // Only covered demands can be estimated: the server refuses the others.
  let estimable = $derived(
    data.requests.filter((r) => r.commercial_coverage === 'covered'),
  );
  let uncoveredCount = $derived(data.requests.length - estimable.length);
  const groupByProject = <T extends { id: string }>(
    list: T[],
    projectOf: (x: T) => string | undefined,
  ) =>
    data.projects
      .map((p) => ({
        name: p.name,
        items: list.filter((x) => projectOf(x) === p.id),
      }))
      .filter((g) => g.items.length);
  // A project's approved terms already define what these records must match.
  $effect(() => {
    if (!['capacity', 'estimate', 'direct_cost'].includes(kind) || !project)
      return;
    const approved = view.records.filter(
      (r) =>
        r.kind === 'terms' &&
        r.decision === 'approved' &&
        r.project_id === project,
    );
    untrack(() => {
      // Terms of another project must not linger behind the hidden period fields.
      if (terms && !approved.some((r) => r.id === terms)) terms = '';
      if (approved.length !== 1 || previous) return;
      if (kind === 'capacity') {
        if (from || until) return;
        cur = approved[0]!.currency;
        from = approved[0]!.valid_from;
        until = approved[0]!.valid_until;
      } else if (!terms) chooseTerm(approved[0]!.id);
    });
  });
  // An hourly cost usually follows the period of the approved premises; still editable.
  $effect(() => {
    if (kind !== 'rate') return;
    const config = view.records.find(
      (r) => r.kind === 'config' && r.decision === 'approved',
    );
    untrack(() => {
      if (!config || from || until || previous) return;
      cur = config.currency;
      from = config.valid_from;
      until = config.valid_until;
    });
  });
  async function loadRecord(r: EconomicRecord) {
    kind = r.kind;
    project = r.project_id ?? '';
    cur = r.currency;
    from = r.valid_from;
    until = r.valid_until;
    previous = r;
    source = '';
    const p = r.payload;
    if (kind === 'config') {
      tax = Number(p.tax_bps);
      commission = Number(p.commission_bps);
      ohRule = String(p.overhead_rule);
      ohRate =
        p.overhead_minor_per_hour == null
          ? ''
          : String(p.overhead_minor_per_hour);
      workdays = [...(p.weekdays as number[])];
      minutesDay = Number(p.minutes_per_day);
      holidays = (p.holidays as string[]).join(',');
    }
    if (kind === 'rate') {
      person = p.user_id == null ? '' : String(p.user_id);
      functionRole = p.role == null ? '' : String(p.role);
      rate = String(p.minor_per_hour);
    }
    if (kind === 'terms') {
      contractId = String(p.contract_id);
      scopeId = String(p.scope_id);
      amount = String(p.amount_minor);
      recognition = String(p.recognition_rule);
      recognized = p.recognized_minor == null ? '' : String(p.recognized_minor);
      directComplete = p.direct_costs_complete === true;
      timeComplete = p.time_entries_complete === true;
      included =
        p.included_minutes == null ? undefined : Number(p.included_minutes);
      overage = String(p.overage_rule);
      overageRate =
        p.overage_rate_minor == null ? '' : String(p.overage_rate_minor);
      rollover = String(p.rollover_rule);
      cap = Number(p.rollover_cap_minutes);
      carry = Number(p.carry_in_minutes);
      priorTerms = p.prior_terms_id == null ? '' : String(p.prior_terms_id);
      changeId = p.change_request_id == null ? '' : String(p.change_request_id);
    }
    if (kind === 'estimate') {
      terms = String(p.terms_id);
      request = String(p.request_id);
      person = String(p.user_id);
      planned = Number(p.planned_minutes);
      remaining = Number(p.remaining_minutes);
      expected = String(p.expected_on);
    }
    if (kind === 'capacity') {
      person = String(p.user_id);
      available = Number(p.available_minutes);
    }
    if (kind === 'direct_cost') {
      terms = String(p.terms_id);
      expense = String(p.expense_key);
      classification = String(p.classification);
      budget = String(p.budget_minor);
      incurred = String(p.incurred_minor);
      future = String(p.remaining_minor);
    }
    tab = 'preparar';
    await tick();
    prepareForm?.scrollIntoView({ block: 'start' });
  }
  function payload(): Record<string, unknown> {
    switch (kind) {
      case 'config':
        return {
          tax_bps: tax,
          commission_bps: commission,
          overhead_rule: ohRule,
          overhead_minor_per_hour: ohRule === 'none_explicit' ? null : ohRate,
          weekdays: [...workdays].sort((a, b) => a - b),
          minutes_per_day: minutesDay,
          holidays: holidays.trim()
            ? holidays.split(',').map((s) => s.trim())
            : [],
        };
      case 'rate':
        return {
          user_id: person || null,
          role: functionRole || null,
          minor_per_hour: rate,
        };
      case 'terms':
        return {
          contract_id: contractId,
          scope_id: scopeId,
          amount_minor: amount,
          recognition_rule: recognition,
          recognized_minor: recognition === 'manual' ? recognized : null,
          direct_costs_complete: directComplete,
          time_entries_complete: timeComplete,
          // Fixed price has no balance, overage or rollover: the server refuses them.
          included_minutes: retainer ? (included ?? null) : null,
          overage_rule: retainer ? overage : 'none',
          overage_rate_minor:
            retainer && overage === 'billable' ? overageRate : null,
          rollover_rule: retainer ? rollover : 'none',
          rollover_cap_minutes: retainer ? cap : 0,
          carry_in_minutes: retainer ? carry : 0,
          prior_terms_id: retainer ? priorTerms || null : null,
          change_request_id: changeId || null,
        };
      case 'estimate':
        return {
          terms_id: terms,
          request_id: request,
          user_id: person,
          planned_minutes: planned,
          remaining_minutes: remaining,
          expected_on: expected,
        };
      case 'capacity':
        return { user_id: person, available_minutes: available };
      case 'direct_cost':
        return {
          terms_id: terms,
          expense_key: expense,
          classification,
          budget_minor: budget,
          incurred_minor: incurred,
          remaining_minor: future,
        };
      default:
        return {};
    }
  }
  async function prepare() {
    await post('economics/records', {
      kind,
      project_id: ['config', 'rate'].includes(kind) ? null : project,
      currency: cur,
      valid_from: from,
      valid_until: until,
      source,
      payload: payload(),
      previous_id: previous?.id ?? null,
    });
    previous = null;
    source = '';
    notice =
      'Versão preparada; exige decisão independente antes de produzir efeitos.';
  }
  /** Decisions always explain what is missing instead of sitting disabled. */
  function ready() {
    reasonMissing = !reason.trim();
    if (reasonMissing) reasonInput?.focus();
    return !reasonMissing;
  }
  function decide(r: EconomicRecord, decision: 'approved' | 'rejected') {
    if (!ready()) return;
    void run(async () => {
      await post('economics/records/' + r.id + '/decide', {
        revision: r.revision,
        decision,
        reason,
        cost_role: costRole || null,
      });
      notice = `${names[r.kind]} ${decision === 'approved' ? 'aprovado' : 'rejeitado'}: decisão registrada.`;
    });
  }
  function decideHours(t: TimeEntry, action: 'approved' | 'rejected') {
    if (!ready()) return;
    void run(async () => {
      await post('economics/times/' + t.id + '/action', {
        expected_state: t.state,
        action,
        reason,
        cost_role: costRole || null,
      });
      notice = `${hoursLabel(t.minutes)} de ${who(t.user_id)} ${action === 'approved' ? 'aprovadas' : 'rejeitadas'}: decisão registrada.`;
    });
  }
  function confirmReversal(t: TimeEntry) {
    reverseMissing = !reverseReason.trim();
    if (reverseMissing) return;
    void run(async () => {
      await post('economics/times/' + t.id + '/action', {
        expected_state: t.state,
        action: 'reversed',
        reason: reverseReason,
        cost_role: null,
      });
      reversing = reverseReason = '';
      notice = `${hoursLabel(t.minutes)} de ${who(t.user_id)} revertidas: reversão registrada.`;
    });
  }
  const percent = percentLabel;

  const matches = (id: string | null) => !projectFilter || id === projectFilter;
  // Only what this reader can act on or must wait for; every decided item has its own area.
  let pendingRecords = $derived(
    view.records.filter(
      (r) => !r.decision && (r.kind !== 'terms' || confidential),
    ),
  );
  let pendingHours = $derived(view.times.filter((t) => t.state === 'pending'));
  let queueRecords = $derived(
    pendingRecords.filter((r) => !r.project_id || matches(r.project_id)),
  );
  let queueHours = $derived(pendingHours.filter((t) => matches(t.project_id)));
  let pendingCount = $derived(pendingRecords.length + pendingHours.length);
  let canDecideRecords = $derived(
    !!commercial.policy?.approval_roles.includes(
      role as 'manager' | 'administrator',
    ),
  );
  let filteredHours = $derived(
    view.times
      .filter((t) => matches(t.project_id))
      .filter((t) => !stateFilter || t.state === stateFilter)
      .slice()
      .sort(
        (a, b) =>
          Number(b.state === 'pending') - Number(a.state === 'pending') ||
          b.work_date.localeCompare(a.work_date),
      ),
  );
  // The same person and period is the same series: it needs a revision, not a new one.
  let sameRate = $derived(
    kind === 'rate' && !previous && person && from && until
      ? view.records
          .filter(
            (r) =>
              r.kind === 'rate' &&
              r.series_key === `rate:${person}:${from}:${until}`,
          )
          .sort((a, b) => b.revision - a.revision)[0]
      : undefined,
  );
  let pendingSummary = $derived(
    [
      pendingRecords.length &&
        `${pendingRecords.length} ${pendingRecords.length === 1 ? 'registro aguarda' : 'registros aguardam'}`,
      pendingHours.length &&
        `${pendingHours.length} ${pendingHours.length === 1 ? 'apontamento aguarda' : 'apontamentos aguardam'}`,
    ]
      .filter(Boolean)
      .join(' e '),
  );
  // The list follows the type being prepared: the versions a person may want to revise.
  let visibleRecords = $derived(
    view.records
      .filter(
        (r) =>
          (r.kind !== 'terms' || confidential) &&
          matches(r.project_id) &&
          (!kind || r.kind === kind),
      )
      .slice()
      .sort(
        (a: EconomicRecord, b: EconomicRecord) =>
          Number(!b.decision) - Number(!a.decision),
      ),
  );
  // The newest observation answers the question; older ones stay one click away.
  let visibleReports = $derived.by(() => {
    const seen = new Set<string>();
    return view.reports.filter((r) => {
      if (!matches(r.project_id)) return false;
      if (showHistory) return true;
      const first = !seen.has(r.terms_id);
      seen.add(r.terms_id);
      return first;
    });
  });
  let olderReports = $derived(
    view.reports.filter((r) => matches(r.project_id)).length -
      (showHistory
        ? view.reports.filter((r) => matches(r.project_id)).length
        : visibleReports.length),
  );
  let tabs = $derived.by(() => {
    const all: { id: TabId; label: string; count?: number }[] = [];
    if (confidential)
      all.push({ id: 'decidir', label: 'Para decidir', count: pendingCount });
    if (role !== 'developer') all.push({ id: 'preparar', label: 'Preparar' });
    all.push({ id: 'horas', label: 'Horas' });
    if (confidential) {
      all.push({ id: 'rentabilidade', label: 'Rentabilidade' });
      all.push({ id: 'auditoria', label: 'Auditoria' });
    }
    return all;
  });
  function tabKeys(e: KeyboardEvent) {
    const ids = tabs.map((t) => t.id),
      at = ids.indexOf(tab);
    const nextIndex =
      e.key === 'ArrowRight'
        ? (at + 1) % ids.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + ids.length) % ids.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? ids.length - 1
              : -1;
    if (nextIndex < 0) return;
    e.preventDefault();
    tab = ids[nextIndex]!;
    void tick().then(() => document.getElementById(`econ-tab-${tab}`)?.focus());
  }

  // A decision is made on the values, so they are shown as a person reads them.
  function recordValues(r: EconomicRecord): [string, string][] {
    const p = r.payload,
      money = (v: unknown) =>
        v == null ? 'Indisponível' : moneyGrouped(String(v), r.currency),
      hours = (v: unknown) =>
        v == null ? 'Indisponível' : hoursLabel(Number(v));
    switch (r.kind) {
      case 'config':
        return [
          [
            'Tributos',
            percentLabel(p.tax_bps == null ? null : String(p.tax_bps)),
          ],
          [
            'Comissões',
            percentLabel(
              p.commission_bps == null ? null : String(p.commission_bps),
            ),
          ],
          [
            'Overhead',
            p.overhead_rule === 'none_explicit'
              ? 'Sem overhead (declarado)'
              : `${money(p.overhead_minor_per_hour)} por hora`,
          ],
          [
            'Dias de trabalho',
            ((p.weekdays as number[] | undefined) ?? [])
              .map((d) => weekdayNames[d - 1])
              .join(', '),
          ],
          ['Jornada', hours(p.minutes_per_day)],
          [
            'Feriados',
            ((p.holidays as string[] | undefined) ?? []).join(', ') || 'Nenhum',
          ],
        ];
      case 'rate':
        return [
          [
            'Para',
            p.user_id
              ? who(p.user_id)
              : (roleNames[String(p.role)] ?? String(p.role)),
          ],
          ['Custo por hora', money(p.minor_per_hour)],
        ];
      case 'terms': {
        const out: [string, string][] = [
          [
            'Contrato',
            commercial.contracts.find((c) => c.id === p.contract_id)?.title ??
              'Indisponível',
          ],
          ['Valor contratado', money(p.amount_minor)],
          [
            'Reconhecimento',
            p.recognition_rule === 'manual'
              ? `Manual: ${money(p.recognized_minor)}`
              : p.recognition_rule === 'at_period_end'
                ? 'Total ao fim do período'
                : 'Sem reconhecimento configurado',
          ],
          [
            'Custos externos completos',
            p.direct_costs_complete ? 'Sim' : 'Não',
          ],
          ['Apontamentos completos', p.time_entries_complete ? 'Sim' : 'Não'],
        ];
        if (p.included_minutes != null)
          out.push(['Horas incluídas', hours(p.included_minutes)]);
        return out;
      }
      case 'estimate':
        return [
          ['Demanda', requestTitle(p.request_id)],
          ['Profissional', who(p.user_id)],
          ['Previsto', hours(p.planned_minutes)],
          ['Para concluir', hours(p.remaining_minutes)],
          ['Conclusão', dayLabel(p.expected_on as string | undefined)],
        ];
      case 'capacity':
        return [
          ['Profissional', who(p.user_id)],
          ['Capacidade', hours(p.available_minutes)],
        ];
      case 'direct_cost':
        return [
          ['Referência', String(p.expense_key)],
          [
            'Classificação',
            p.classification === 'external'
              ? 'Fornecedor externo'
              : 'Despesa direta',
          ],
          ['Orçamento', money(p.budget_minor)],
          ['Incorrido', money(p.incurred_minor)],
          ['Para concluir', money(p.remaining_minor)],
        ];
    }
  }
  function reportFacts(r: EconomicsResult): [string, string][] {
    const money = (v: string | null) => moneyGrouped(v, r.currency),
      known = (v: number | null, absent: string) =>
        v == null ? absent : hoursLabel(v);
    return [
      [
        'Margem projetada na conclusão',
        `${money(r.projected_margin)} · ${percent(r.projected_margin_bps)}`,
      ],
      [
        'Margem realizada sobre receita reconhecida',
        `${money(r.realized_margin)} · ${percent(r.realized_margin_bps)}`,
      ],
      ['Receita contratada', money(r.contracted_revenue)],
      ['Receita reconhecida', money(r.recognized_revenue)],
      ['Orçamento de custo', money(r.budget_cost)],
      ['Custo incorrido, sem deduções sobre receita', money(r.cost_incurred)],
      ['Custo para concluir (ETC)', money(r.estimate_to_complete)],
      ['Custo previsto na conclusão (EAC)', money(r.eac)],
      [
        'Horas previstas / aprovadas / pendentes / restantes',
        [
          known(r.planned_minutes, 'Desconhecidas'),
          hoursLabel(r.approved_minutes),
          hoursLabel(r.pending_minutes),
          known(r.remaining_minutes, 'Desconhecidas'),
        ].join(' / '),
      ],
      [
        'Capacidade alocada declarada',
        known(r.capacity_minutes, 'Desconhecida'),
      ],
      ...(r.included_minutes == null
        ? []
        : ([
            [
              'Retainer: incluídas / entrada / saldo / excedente',
              [
                known(r.included_minutes, 'Não aplicável'),
                hoursLabel(r.carry_in_minutes),
                known(r.balance_minutes, 'Não aplicável'),
                known(r.overage_minutes, 'Não aplicável'),
              ].join(' / '),
            ],
          ] as [string, string][])),
    ];
  }
  // Messages from the engine name projects by id; people read names.
  const readable = (items: string[]) =>
    items
      .map((text) =>
        data.projects.reduce(
          (out, p) => out.replaceAll(p.id, `“${p.name}”`),
          text,
        ),
      )
      .join('; ');
  const stateOf = (r: EconomicRecord) =>
    r.decision === 'approved'
      ? 'Aprovado'
      : r.decision === 'rejected'
        ? 'Rejeitado'
        : 'Pendente';
  const hoursFact = (t: TimeEntry) =>
    `${hoursLabel(t.minutes)} em ${dayLabel(t.work_date)}`;
  const period = (a: string, b: string) => `${dayLabel(a)} a ${dayLabel(b)}`;
</script>

{#snippet facts(list: [string, string][])}
  <dl class="econ-facts">
    {#each list as [term, value]}<div>
        <dt>{term}</dt>
        <dd>{value}</dd>
      </div>{/each}
  </dl>
{/snippet}

{#snippet recordFacts(r: EconomicRecord)}
  <dl class="econ-facts">
    {#each recordValues(r) as [term, value]}<div>
        <dt>{term}</dt>
        <dd>{value}</dd>
      </div>{/each}
    <div>
      <dt>Vigência</dt>
      <dd>{period(r.valid_from, r.valid_until)}</dd>
    </div>
    <div>
      <dt>Fonte</dt>
      <dd>{r.source}</dd>
    </div>
  </dl>
{/snippet}

{#snippet trace(r: EconomicRecord)}
  <details>
    <summary>Rastreabilidade completa</summary>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable region must be keyboard reachable, WCAG 2.1.1) -->
    <pre tabindex="0">{JSON.stringify(r, null, 2)}</pre>
  </details>
{/snippet}

{#snippet filterNotice()}
  {#if projectFilter}<p class="econ-filter">
      Mostrando apenas <strong>{projectName(projectFilter)}</strong>.
      <button
        type="button"
        class="secondary"
        onclick={() => (projectFilter = '')}>Ver todos os projetos</button
      >
    </p>{/if}
{/snippet}

<section class="panel economics" aria-label="Inteligência econômica">
  <div class="section-heading">
    <h2>Inteligência econômica</h2>
    <button
      class="secondary"
      disabled={busy}
      onclick={() =>
        void run(async () => {
          await onChanged?.();
        })}>Atualizar economia</button
    >
  </div>
  <p class="muted">
    Receita contratada não é recebimento. Projeções e realizado têm bases
    distintas; dados ausentes não viram zero.
  </p>
  {#if error}<p role="alert" class="error">{error}</p>{/if}{#if notice}<p
      role="status"
    >
      {notice}
    </p>{/if}
  {#if tabs.length > 1}
    <div
      class="econ-tabs"
      role="tablist"
      aria-label="Áreas de Economia"
      tabindex="-1"
      onkeydown={tabKeys}
    >
      {#each tabs as t}<button
          type="button"
          role="tab"
          id={`econ-tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls="econ-panel"
          tabindex={tab === t.id ? 0 : -1}
          onclick={() => (tab = t.id)}
          >{t.label}{#if t.count}{' '}<span class="count">{t.count}</span
            >{/if}</button
        >{/each}
    </div>
  {/if}

  <div
    id="econ-panel"
    role={tabs.length > 1 ? 'tabpanel' : undefined}
    aria-labelledby={tabs.length > 1 ? `econ-tab-${tab}` : undefined}
  >
    <!-- Nothing renders until the data arrives, so loading never pushes content down (CLS). -->
    {#if !loaded}<p class="empty-line">
        {error
          ? 'Dados indisponíveis: use “Atualizar economia” para tentar de novo.'
          : 'Carregando economia…'}
      </p>
    {:else if tab === 'decidir'}
      {@render filterNotice()}
      {#if pendingCount}<p class="next-step" role="note">
          <strong>Próximo passo:</strong>
          {pendingSummary} decisão independente.
        </p>{/if}
      {#if !queueHours.length && !queueRecords.length}
        <p class="econ-empty">
          Nada aguardando decisão{projectFilter ? ' neste projeto' : ''}.
          {#if confidential}<button
              type="button"
              class="secondary"
              onclick={() => (tab = 'rentabilidade')}>Ver rentabilidade</button
            >{/if}
        </p>
      {:else}
        <div class="econ-decision-bar">
          <label
            >Justificativa econômica de decisão/reversão<input
              bind:this={reasonInput}
              bind:value={reason}
              maxlength="2000"
              placeholder="O que você conferiu e em qual fonte"
              aria-invalid={reasonMissing && !reason.trim()
                ? 'true'
                : undefined}
              aria-describedby="econ-reason-note"
              oninput={() => (reasonMissing = false)}
            /></label
          >
          {#if queueHours.length}<label
              >Função de custo conferida (opcional)<select bind:value={costRole}
                ><option value="">Usar a taxa individual aprovada</option
                >{#each ['developer', 'po', 'manager', 'administrator'] as r}<option
                    value={r}>{roleNames[r] ?? r}</option
                  >{/each}</select
              ></label
            >{/if}
          <small
            id="econ-reason-note"
            class:field-error={reasonMissing}
            role={reasonMissing ? 'alert' : undefined}
            >{reasonMissing
              ? 'Escreva a justificativa para registrar a decisão.'
              : 'Vale para as próximas decisões desta lista e fica na auditoria.'}</small
          >
        </div>
        {#if queueHours.length}<h3 class="econ-group">
            Horas apontadas <span class="count">{queueHours.length}</span>
          </h3>
          {#each queueHours as t}<article class="queue-card">
              <div class="queue-body">
                <p class="eyebrow">
                  {projectName(t.project_id)} · {requestTitle(t.request_id)}
                </p>
                <h4>{t.comment}</h4>
                <p>
                  <strong>{hoursLabel(t.minutes)}</strong> em {dayLabel(
                    t.work_date,
                  )} · {who(t.user_id)} ·
                  <span class="status" data-status="submitted"
                    >{hourStates[t.state]}</span
                  >
                </p>
              </div>
              {#if t.user_id === userId}<p class="queue-blocked">
                  Você apontou estas horas. Outra pessoa com alçada precisa
                  decidir.
                </p>{:else}<div class="actions">
                  <button
                    disabled={busy}
                    aria-label={`Aprovar horas de ${who(t.user_id)}: ${hoursFact(t)}`}
                    onclick={() => decideHours(t, 'approved')}>Aprovar</button
                  ><button
                    class="secondary"
                    disabled={busy}
                    aria-label={`Rejeitar horas de ${who(t.user_id)}: ${hoursFact(t)}`}
                    onclick={() => decideHours(t, 'rejected')}>Rejeitar</button
                  >
                </div>{/if}
            </article>{/each}
        {/if}
        {#if queueRecords.length}<h3 class="econ-group">
            Registros preparados <span class="count">{queueRecords.length}</span
            >
          </h3>
          {#each queueRecords as r}<article class="queue-card">
              <div class="queue-body">
                {#if r.project_id}<p class="eyebrow">
                    {projectName(r.project_id)}
                  </p>{/if}
                <h4>{names[r.kind]} · revisão {r.revision}</h4>
                {@render recordFacts(r)}
                <p class="muted">
                  Preparado por {who(r.created_by)} em {dayLabel(r.created_at)}
                </p>
                {@render trace(r)}
              </div>
              {#if r.created_by === userId}<p class="queue-blocked">
                  Você preparou esta versão. Outra pessoa com alçada precisa
                  decidir.
                </p>{:else if !canDecideRecords}<p class="queue-blocked">
                  {commercial.policy
                    ? 'Seu papel não tem alçada para decidir registros.'
                    : 'O administrador ainda não definiu as alçadas comerciais.'}
                </p>{:else}<div class="actions">
                  <button
                    disabled={busy}
                    aria-label={`Aprovar registro: ${names[r.kind]}, revisão ${r.revision}`}
                    onclick={() => decide(r, 'approved')}>Aprovar</button
                  ><button
                    class="secondary"
                    disabled={busy}
                    aria-label={`Rejeitar registro: ${names[r.kind]}, revisão ${r.revision}`}
                    onclick={() => decide(r, 'rejected')}>Rejeitar</button
                  >
                </div>{/if}
            </article>{/each}
        {/if}
      {/if}
    {:else if tab === 'preparar'}
      <form
        bind:this={prepareForm}
        aria-label="Preparar registro econômico"
        class="commercial-form econ-prepare"
        onsubmit={(e) => {
          e.preventDefault();
          void run(prepare);
        }}
      >
        {#if confidential}<fieldset class="kind-picker">
            <legend>Tipo de registro econômico</legend>
            {#each Object.entries(names) as [k, v]}<label class="kind-option"
                ><input
                  type="radio"
                  name="econ-kind"
                  value={k}
                  bind:group={kind}
                  onchange={() => (previous = null)}
                /><span
                  ><strong>{v}</strong><small
                    >{kindHelp[k as EconomicKind]}</small
                  ></span
                ></label
              >{/each}
          </fieldset>{:else}<h3>{names.estimate}</h3>{/if}
        {#if previous}<p class="next-step span">
            Nova versão de {names[previous.kind]} · revisão {previous.revision};
            o original será preservado.
            <button
              class="secondary"
              type="button"
              onclick={() => (previous = null)}>Preparar série nova</button
            >
          </p>{/if}
        {#if !kind}<p class="empty-line span">
            Escolha acima o que você quer registrar.
          </p>{:else}
          {#if kind === 'estimate'}<label
              >Demanda a estimar<select
                value={request}
                onchange={(e) => chooseDemand(e.currentTarget.value)}
                required
                ><option value="">Selecione</option
                >{#each groupByProject( estimable, (r) => requestProject(r.id), ) as g}<optgroup
                    label={g.name}
                    >{#each g.items as r}<option value={r.id}>{r.title}</option
                      >{/each}</optgroup
                  >{/each}</select
              ></label
            >
            <p class="muted">
              {#if uncoveredCount}{uncoveredCount}
                {uncoveredCount === 1
                  ? 'demanda sem cobertura não aparece'
                  : 'demandas sem cobertura não aparecem'}: vincule em Comercial
                antes de estimar.{:else}Projeto e responsável vêm da demanda.{/if}
            </p>
          {:else if !['config', 'rate'].includes(kind)}<label
              >Projeto econômico<select bind:value={project} required
                ><option value="">Selecione</option
                >{#each data.projects as p}<option value={p.id}>{p.name}</option
                  >{/each}</select
              ></label
            >{/if}
          {#if ['estimate', 'direct_cost'].includes(kind)}
            {#if project && projectTerms.length === 0}<p
                class="commercial-coverage span"
              >
                Este projeto ainda não tem termos aprovados. Eles são exigidos
                antes deste registro.
              </p>
            {:else if projectTerms.length !== 1}<label
                >Termos aprovados para planejamento<select
                  bind:value={terms}
                  onchange={() => chooseTerm(terms)}
                  required
                  ><option value="">Selecione</option
                  >{#each approvedTerms.filter((r) => !project || r.project_id === project) as t}<option
                      value={t.id}
                      >{projectName(t.project_id)} · {period(
                        t.valid_from,
                        t.valid_until,
                      )} · revisão {t.revision}</option
                    >{/each}</select
                ></label
              >{:else if terms && from}<p class="muted span">
                Moeda {cur} e competência {period(from, until)} herdadas dos termos
                aprovados.
              </p>{/if}
          {/if}

          {#if kind === 'config'}
            <UnitField
              label="Tributos (%)"
              kind="percent"
              bind:value={tax}
              hint="Sobre a receita. Ex.: 8 ou 8,5"
            />
            <UnitField
              label="Comissões (%)"
              kind="percent"
              bind:value={commission}
              hint="Sobre a receita. Ex.: 2"
            />
            <label
              >Regra de overhead<select bind:value={ohRule} required
                ><option value="">Selecione explicitamente</option><option
                  value="none_explicit"
                  >Sem overhead por declaração explícita</option
                ><option value="per_labor_minute"
                  >Rateio por hora de trabalho</option
                ></select
              ></label
            >
            {#if ohRule === 'per_labor_minute'}<UnitField
                label={`Overhead por hora (${cur})`}
                kind="money"
                currency={cur}
                bind:value={ohRate}
              />{/if}
            <fieldset class="check-group span">
              <legend>Dias de trabalho</legend>
              {#each weekdayNames as day, i}<label class="check-option"
                  ><input
                    type="checkbox"
                    value={i + 1}
                    bind:group={workdays}
                  />{day}</label
                >{/each}
            </fieldset>
            <UnitField
              label="Horas de trabalho por dia"
              kind="hours"
              bind:value={minutesDay}
            />
            <label
              >Feriados (AAAA-MM-DD, separados por vírgula; vazio declara
              nenhum)<input bind:value={holidays} /></label
            >
          {:else if kind === 'rate'}
            {#if sameRate}<p class="commercial-coverage span">
                {who(person)} já tem custo nesta vigência ({moneyGrouped(
                  String(sameRate.payload.minor_per_hour),
                  sameRate.currency,
                )}).
                {#if sameRate.decision}Revise a versão existente ou mude a
                  vigência.
                  <button
                    type="button"
                    class="secondary"
                    onclick={() => sameRate && void loadRecord(sameRate)}
                    >Revisar a versão existente</button
                  >{:else}A versão pendente precisa ser decidida antes.{/if}
              </p>{/if}
            {#if !functionRole}<label
                >Profissional econômico<select bind:value={person}
                  ><option value="">Usar função em vez de profissional</option
                  >{#each members as m}<option value={m.id}
                      >{m.name} · {m.email}</option
                    >{/each}</select
                ></label
              >{/if}
            {#if !person}<label
                >Função para custo/hora<select bind:value={functionRole}
                  ><option value="">Usar profissional em vez de função</option
                  >{#each ['developer', 'po', 'manager', 'administrator'] as r}<option
                      value={r}>{roleNames[r] ?? r}</option
                    >{/each}</select
                ></label
              >{/if}
            <UnitField
              label={`Custo por hora (${cur})`}
              kind="money"
              currency={cur}
              bind:value={rate}
              hint="Ex.: 125,00"
            />
          {:else if kind === 'estimate' || kind === 'capacity'}
            <label
              >Profissional econômico<select bind:value={person} required
                ><option value="">Selecione</option>{#each members as m}<option
                    value={m.id}>{m.name} · {m.email}</option
                  >{/each}</select
              ></label
            >
            {#if kind === 'capacity'}<UnitField
                label="Capacidade alocada (horas)"
                kind="hours"
                bind:value={available}
                hint="Disponibilidade para este projeto e período; não é hora contratada ou consumida."
              />
            {:else}<UnitField
                label="Horas previstas"
                kind="hours"
                bind:value={planned}
                hint="Baseline da demanda. Ex.: 10 ou 1h30"
              /><UnitField
                label="Horas para concluir"
                kind="hours"
                bind:value={remaining}
                hint="Quanto ainda falta hoje."
              /><UnitField
                label="Data prevista de conclusão"
                kind="date"
                bind:value={expected}
                min={from}
                max={until}
              />{/if}
          {:else if kind === 'terms'}
            <label
              >Contrato econômico<select
                bind:value={contractId}
                onchange={chooseContract}
                required
                ><option value="">Selecione</option
                >{#each commercial.contracts.filter((c) => c.project_id === project) as c}<option
                    value={c.id}
                    >{c.title} · {c.kind === 'fixed_price'
                      ? 'Preço fechado'
                      : 'Retainer'}</option
                  >{/each}</select
              ></label
            >
            <label
              >Escopo aprovado dos termos<select bind:value={scopeId} required
                ><option value="">Selecione</option
                >{#each commercial.scopes.filter((s) => s.project_id === project && s.contract_id === contractId && s.state === 'approved') as s}<option
                    value={s.id}>V{s.number} · {s.title}</option
                  >{/each}</select
              ></label
            >
            <UnitField
              label={`Valor contratado na competência (${cur})`}
              kind="money"
              currency={cur}
              bind:value={amount}
            />
            <label
              >Regra de reconhecimento<select bind:value={recognition} required
                ><option value="">Selecione explicitamente</option><option
                  value="none">Sem reconhecimento configurado</option
                ><option value="at_period_end"
                  >Total contratado ao fim do período</option
                ><option value="manual"
                  >Valor reconhecido explícito e aprovado</option
                ></select
              ></label
            >{#if recognition === 'manual'}<UnitField
                label={`Receita reconhecida (${cur})`}
                kind="money"
                currency={cur}
                bind:value={recognized}
              />{/if}
            <label class="span"
              ><input type="checkbox" bind:checked={directComplete} /> Custos externos
              estão completos, inclusive ausência explicitamente declarada</label
            ><label class="span"
              ><input type="checkbox" bind:checked={timeComplete} /> Apontamentos
              estão completos para a observação aprovada</label
            >
            {#if retainer}
              <UnitField
                label="Horas incluídas no retainer"
                kind="hours"
                bind:value={included}
                required={false}
              />
              <label
                >Regra de excedente<select bind:value={overage} required
                  ><option value="">Selecione</option><option value="none"
                    >Sem receita adicional por excedente</option
                  ><option value="billable">Excedente faturável por hora</option
                  ></select
                ></label
              >{#if overage === 'billable'}<UnitField
                  label={`Preço por hora excedente (${cur})`}
                  kind="money"
                  currency={cur}
                  bind:value={overageRate}
                />{/if}
              <details class="span">
                <summary>Avançado: saldo entre períodos (rollover)</summary>
                <label
                  >Regra de rollover<select bind:value={rollover} required
                    ><option value="">Selecione</option><option value="none"
                      >Sem transferência entre períodos</option
                    ><option value="carry_capped"
                      >Transferência com teto e origem aprovada</option
                    ></select
                  ></label
                ><UnitField
                  label="Teto de rollover (horas; 0 explícito sem rollover)"
                  kind="hours"
                  bind:value={cap}
                /><UnitField
                  label="Entrada de rollover (horas; 0 explícito sem saldo)"
                  kind="hours"
                  bind:value={carry}
                />
                <label
                  >Origem aprovada do rollover<select bind:value={priorTerms}
                    ><option value="">Sem entrada de saldo</option
                    >{#each approvedTerms as t}<option value={t.id}
                        >{projectName(t.project_id)} · {period(
                          t.valid_from,
                          t.valid_until,
                        )} · revisão {t.revision}</option
                      >{/each}</select
                  ></label
                >
              </details>
            {/if}
            <label
              >Change request aprovado para aditivo<select bind:value={changeId}
                ><option value="">Sem mudança de escopo</option
                >{#each commercial.changes.filter((c) => c.project_id === project && c.state === 'approved') as c}<option
                    value={c.id}>{c.reason}</option
                  >{/each}</select
              ></label
            >
          {:else if kind === 'direct_cost'}<label
              >Referência única da despesa<input
                bind:value={expense}
                maxlength="100"
                required
              /></label
            ><label
              >Classificação de despesa<select
                bind:value={classification}
                required
                ><option value="">Selecione</option><option value="external"
                  >Fornecedor externo</option
                ><option value="expense">Despesa direta relacionada</option
                ></select
              ></label
            ><UnitField
              label={`Orçamento da despesa (${cur})`}
              kind="money"
              currency={cur}
              bind:value={budget}
            /><UnitField
              label={`Parcela incorrida (${cur})`}
              kind="money"
              currency={cur}
              bind:value={incurred}
            /><UnitField
              label={`Parcela para concluir (${cur})`}
              kind="money"
              currency={cur}
              bind:value={future}
            />
            <p class="muted span">
              Uma despesa por referência; trabalho e overhead não entram aqui.
              Não é saída de caixa.
            </p>{/if}

          {#if !['estimate', 'direct_cost'].includes(kind)}<label
              >Moeda econômica<select bind:value={cur}
                >{#each currencies as c}<option value={c}>{c}</option
                  >{/each}</select
              ></label
            >
            <UnitField
              label="Início da competência/vigência"
              kind="date"
              bind:value={from}
            /><UnitField
              label="Fim da competência/vigência"
              kind="date"
              bind:value={until}
              min={from}
            />{/if}
          <label class="span"
            >Fonte das premissas<input
              bind:value={source}
              maxlength="2000"
              required
              placeholder="Onde o aprovador confere este valor: planilha, contrato, ata"
            /></label
          >
          <div class="actions">
            <button disabled={busy}>Preparar versão econômica</button>
          </div>
        {/if}
      </form>
      <div class="m3-block">
        <h3>
          Versões registradas{kind ? ` de ${names[kind]}` : ''}
          <span class="count">{visibleRecords.length}</span>
        </h3>
        {@render filterNotice()}
        {#each visibleRecords.slice(0, recordLimit) as r}<article
            class="queue-card"
          >
            <div class="queue-body">
              {#if r.project_id}<p class="eyebrow">
                  {projectName(r.project_id)}
                </p>{/if}
              <h4>{names[r.kind]} · revisão {r.revision}</h4>
              <p>
                <span class="status" data-status={r.decision ?? 'submitted'}
                  >{stateOf(r)}</span
                >
                · preparado por {who(r.created_by)} em {dayLabel(r.created_at)}
              </p>
              {@render recordFacts(r)}
              {@render trace(r)}
            </div>
            {#if r.decision && (r.kind === 'estimate' || confidential)}<div
                class="actions"
              >
                <button
                  class="secondary"
                  disabled={busy}
                  onclick={() => void loadRecord(r)}>Revisar esta versão</button
                >
              </div>{/if}
          </article>{:else}<p class="empty-line">
            Nenhuma versão econômica.
          </p>{/each}
        {#if visibleRecords.length > recordLimit}<button
            type="button"
            class="secondary"
            onclick={() => (recordLimit += 20)}
            >Mostrar mais ({visibleRecords.length - recordLimit} restantes)</button
          >{/if}
      </div>
    {:else if tab === 'horas'}
      <form
        aria-label="Apontar horas próprias"
        class="commercial-form"
        onsubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await post('economics/times', {
              project_id: requestProject(timeRequest),
              request_id: timeRequest,
              work_date: workDate,
              minutes: duration,
              comment,
              replaces_id: replaces || null,
            });
            comment = '';
            duration = undefined;
            replaces = '';
            notice =
              'Horas pendentes de decisão; nenhum custo exposto ao desenvolvedor.';
          });
        }}
      >
        <h3>Apontar horas próprias</h3>
        <label class="span"
          >Demanda das horas<select bind:value={timeRequest} required
            ><option value="">Selecione</option>
            {#if data.requests.some((r) => r.owner_user_id === userId)}<optgroup
                label="Minhas demandas"
                >{#each data.requests.filter((r) => r.owner_user_id === userId) as r}<option
                    value={r.id}
                    >{r.title} · {projectName(requestProject(r.id))}</option
                  >{/each}</optgroup
              >{/if}
            {#each groupByProject( data.requests.filter((r) => r.owner_user_id !== userId), (r) => requestProject(r.id), ) as g}<optgroup
                label={g.name}
                >{#each g.items as r}<option value={r.id}>{r.title}</option
                  >{/each}</optgroup
              >{/each}</select
          ></label
        ><UnitField
          label="Data trabalhada"
          kind="date"
          bind:value={workDate}
          max={today}
        /><UnitField
          label="Duração (horas)"
          kind="hours"
          bind:value={duration}
          hint="Ex.: 2, 1,5 ou 1h30"
        /><label class="span"
          >Comentário do apontamento<textarea
            bind:value={comment}
            required
            maxlength="2000"
          ></textarea></label
        >
        {#if view.times.some((t) => t.user_id === userId && ['reversed', 'rejected'].includes(t.state))}<label
            class="span"
            >Apontamento revertido/rejeitado a corrigir<select
              bind:value={replaces}
              ><option value="">Novo apontamento</option
              >{#each view.times.filter((t) => t.user_id === userId && ['reversed', 'rejected'].includes(t.state)) as t}<option
                  value={t.id}
                  >{dayLabel(t.work_date)} · {hoursLabel(t.minutes)} · {t.comment}</option
                >{/each}</select
            ></label
          >{/if}
        <div class="actions">
          <button disabled={busy}>Registrar horas</button>
        </div>
      </form>
      <div class="m3-block">
        <h3>
          {role === 'developer' ? 'Minhas horas' : 'Horas apontadas'}
          <span class="count">{filteredHours.length}</span>
        </h3>
        {@render filterNotice()}
        <label class="field-narrow"
          >Filtrar por estado<select bind:value={stateFilter}
            ><option value="">Todos</option
            >{#each Object.entries(hourStates) as [state, label]}<option
                value={state}>{label}</option
              >{/each}</select
          ></label
        >
        {#each filteredHours.slice(0, hourLimit) as t}<article class="hour-row">
            <h4>{t.comment}</h4>
            <p>
              <strong>{hoursLabel(t.minutes)}</strong>
              em {dayLabel(t.work_date)} · {who(t.user_id)} · {requestTitle(
                t.request_id,
              )}
            </p>
            <span
              class="status"
              data-status={t.state === 'pending'
                ? 'submitted'
                : t.state === 'approved'
                  ? 'approved'
                  : 'rejected'}>{hourStates[t.state]}</span
            >
            {#if reversing === t.id}<div class="hour-reverse">
                <label
                  >{t.user_id === userId
                    ? 'Motivo para reverter minhas horas'
                    : 'Justificativa da reversão'}<input
                    bind:value={reverseReason}
                    maxlength="2000"
                    aria-invalid={reverseMissing && !reverseReason.trim()
                      ? 'true'
                      : undefined}
                  /></label
                >
                {#if reverseMissing && !reverseReason.trim()}<small
                    class="field-error"
                    role="alert"
                    >Escreva o motivo para registrar a reversão.</small
                  >{/if}
                <div class="actions">
                  <button disabled={busy} onclick={() => confirmReversal(t)}
                    >Confirmar reversão</button
                  ><button
                    class="secondary"
                    type="button"
                    onclick={() => {
                      reversing = reverseReason = '';
                      reverseMissing = false;
                    }}>Cancelar</button
                  >
                </div>
              </div>
            {:else if (confidential && t.user_id !== userId && t.state === 'approved') || (t.user_id === userId && t.state === 'pending')}<button
                class="secondary"
                disabled={busy}
                aria-label={`Reverter horas de ${who(t.user_id)}: ${hoursFact(t)}`}
                onclick={() => {
                  reversing = t.id;
                  reverseReason = '';
                  reverseMissing = false;
                }}>Reverter</button
              >{/if}
          </article>{:else}<p class="empty-line">Nenhum apontamento.</p>{/each}
        {#if filteredHours.length > hourLimit}<button
            type="button"
            class="secondary"
            onclick={() => (hourLimit += 50)}
            >Mostrar mais ({filteredHours.length - hourLimit} restantes)</button
          >{/if}
      </div>
    {:else if tab === 'rentabilidade'}
      <form
        aria-label="Calcular observação econômica"
        class="econ-calc"
        onsubmit={(e) => e.preventDefault()}
      >
        <h3>Calcular observação econômica</h3>
        <div class="field-narrow">
          <UnitField
            label="Data de corte das horas"
            kind="date"
            bind:value={asOf}
          />
        </div>
        {#each approvedTerms.filter((t) => matches(t.project_id)) as t}<div
            class="calc-row"
          >
            <p>
              <strong>{projectName(t.project_id)}</strong>
              {period(t.valid_from, t.valid_until)} · revisão {t.revision}
            </p>
            <button
              disabled={busy || !asOf}
              aria-label={`Calcular e preservar ${projectName(t.project_id)}, revisão ${t.revision}`}
              onclick={() =>
                void run(async () => {
                  await post('economics/reports', {
                    terms_id: t.id,
                    as_of: asOf,
                  });
                  notice =
                    'Observação econômica preservada com fontes e versão do motor.';
                })}>Calcular</button
            >
          </div>{:else}<p class="empty-line">
            Sem termos aprovados{projectFilter ? ' neste projeto' : ''}: não há
            base para calcular.
          </p>{/each}
      </form>
      <div class="m3-block">
        <h3>Observações por projeto · orçamento, incorrido e conclusão</h3>
        {@render filterNotice()}
        {#each visibleReports as report}<article
            class="request economic-report"
            aria-label={'Relatório econômico ' + report.id}
          >
            <h4>
              {projectName(report.project_id)} · {period(
                report.result.period_from,
                report.result.period_until,
              )}
            </h4>
            <p class="muted">
              Moeda {report.result.currency} · corte {dayLabel(
                report.result.as_of,
              )} · observado em {dayLabel(report.created_at)}
            </p>
            {@render facts(reportFacts(report.result))}
            {#each report.result.alerts as alert}<p class="commercial-coverage">
                {alert}
              </p>{/each}
            {#if report.result.projection_missing.length}<p>
                Projeção incompleta: {readable(
                  report.result.projection_missing,
                )}
              </p>{/if}{#if report.result.actual_missing.length}<p>
                Realizado incompleto: {readable(report.result.actual_missing)}
              </p>{/if}
            <details>
              <summary>Fórmulas, premissas e fontes desta observação</summary>
              <p>
                EAC = trabalho aprovado + custos externos incorridos + overhead
                incorrido + ETC de trabalho/externos/overhead +
                tributos/comissões sobre receita projetada. Margem = (receita
                relevante − custo relevante) / receita relevante. Não é markup
                ou caixa.
              </p>
              <p>
                Motor {report.result.engine_version} · hash {report.input_hash}
              </p>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable region must be keyboard reachable, WCAG 2.1.1) -->
              <pre tabindex="0">{JSON.stringify(report.inputs, null, 2)}</pre>
            </details>
          </article>{:else}<p class="empty-line">
            Nenhuma observação calculada; não há indicadores financeiros sem
            dados aprovados.
          </p>{/each}
        {#if olderReports > 0}<button
            type="button"
            class="secondary"
            onclick={() => (showHistory = true)}
            >Ver {olderReports}
            {olderReports === 1
              ? 'observação anterior'
              : 'observações anteriores'}</button
          >{/if}
      </div>
      <div class="m3-block">
        <h3>Consolidação por cliente e competência</h3>
        <p class="muted">
          Última observação de cada projeto; moedas e competências separadas.
          Não soma revisões ou observações históricas repetidas.
        </p>
        {#each view.clients ?? [] as c}<article class="request">
            <h4>
              {data.clients.find((x) => x.id === c.client_id)?.name} · {period(
                c.period_from,
                c.period_until,
              )} · {c.currency}
            </h4>
            <p>
              Receita contratada no recorte observado: {moneyGrouped(
                c.contracted_revenue,
                c.currency,
              )} · EAC:
              {moneyGrouped(c.eac, c.currency)} · Margem projetada: {moneyGrouped(
                c.projected_margin,
                c.currency,
              )} · {percent(c.projected_margin_bps)}
            </p>
            <p>
              Margem realizada: {moneyGrouped(c.realized_margin, c.currency)}
            </p>
            {#if c.projection_missing.length}<p>
                Consolidação projetada incompleta: {readable(
                  c.projection_missing,
                )}
              </p>{/if}
            {#if c.actual_missing.length}<p>
                Consolidação realizada incompleta: {readable(c.actual_missing)}
              </p>{/if}
            <details>
              <summary>Observações de origem</summary>
              <p class="muted">{c.report_ids.join(', ')}</p>
            </details>
          </article>{/each}
      </div>
    {:else}
      <h3>Auditoria econômica</h3>
      {#each view.events as e}<p class="audit-line">
          {timeLabel(e.created_at)} · {e.entity_type}
          {e.entity_id} · {e.action} · {who(e.actor_user_id)} ({e.actor_role})
        </p>{:else}<p class="empty-line">Nenhum evento econômico.</p>{/each}
    {/if}
  </div>
</section>
