<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snapshot } from '../shared/domain';
  import type { Member } from '../shared/identity';
  import type {
    EconomicKind,
    EconomicRecord,
    EconomicsView,
  } from '../shared/economics';
  import { moneyLabel } from '../shared/economics';
  import type { CommercialSnapshot } from '../shared/commercial';
  import { currencies } from '../shared/commercial';
  let {
    api,
    data,
    members,
    role,
    userId,
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
    error = $state(''),
    notice = $state('');
  let confidential = $derived(['manager', 'administrator'].includes(role));
  let kind = $state<EconomicKind>('config'),
    project = $state(''),
    cur = $state('BRL'),
    from = $state(''),
    until = $state(''),
    source = $state(''),
    previous = $state('');
  let tax = $state<number | undefined>(),
    commission = $state<number | undefined>(),
    ohRule = $state(''),
    ohRate = $state(''),
    weekdays = $state(''),
    minutesDay = $state<number | undefined>(),
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
    overage = $state(''),
    overageRate = $state(''),
    rollover = $state(''),
    cap = $state<number | undefined>(),
    carry = $state<number | undefined>(),
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
  let reportTerms = $state(''),
    asOf = $state(new Date().toISOString().slice(0, 10));
  let timeProject = $state(''),
    timeRequest = $state(''),
    workDate = $state(new Date().toISOString().slice(0, 10)),
    duration = $state<number | undefined>(),
    comment = $state(''),
    replaces = $state('');
  let reason = $state('');
  let costRole = $state('');
  const names: Record<EconomicKind, string> = {
    config: 'Premissas econômicas',
    rate: 'Custo por hora',
    terms: 'Termos econômicos',
    estimate: 'Estimativa de esforço',
    capacity: 'Capacidade alocada',
    direct_cost: 'Despesa externa/direta',
  };
  const roleNames: Record<string, string> = {
    developer: 'Desenvolvedor',
    po: 'PO',
    manager: 'Gestor',
    administrator: 'Administrador',
  };
  // Members are display-only context; authorization stays on the server.
  function who(id: string | null | undefined) {
    if (!id) return 'Sistema';
    return members.find((m) => m.id === id)?.name ?? id;
  }
  // Shows what an integer minor-unit entry means before it is submitted.
  function preview(value: string) {
    return /^(0|[1-9][0-9]{0,17})$/.test(value.trim())
      ? `= ${moneyLabel(value.trim(), cur)}`
      : '';
  }
  const attempts = new Map<string, { json: string; key: string }>();
  async function post<T>(path: string, body: unknown) {
    const json = JSON.stringify(body);
    let a = attempts.get(path);
    if (!a || a.json !== json) {
      a = { json, key: crypto.randomUUID() };
      attempts.set(path, a);
    }
    const res = await api<T>(path, 'POST', body, a.key);
    attempts.delete(path);
    return res;
  }
  async function refresh() {
    view = await api<EconomicsView>('economics');
    if (role !== 'developer')
      commercial = await api<CommercialSnapshot>('commercial');
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
    if (role === 'po') kind = 'estimate';
    void run(async () => {});
  });
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
  function loadRecord(r: EconomicRecord) {
    kind = r.kind;
    project = r.project_id ?? '';
    cur = r.currency;
    from = r.valid_from;
    until = r.valid_until;
    previous = r.id;
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
      weekdays = (p.weekdays as number[]).join(',');
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
  }
  function payload(): Record<string, unknown> {
    switch (kind) {
      case 'config':
        return {
          tax_bps: tax,
          commission_bps: commission,
          overhead_rule: ohRule,
          overhead_minor_per_hour: ohRule === 'none_explicit' ? null : ohRate,
          weekdays: weekdays.split(',').map(Number),
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
          included_minutes: included ?? null,
          overage_rule: overage,
          overage_rate_minor: overage === 'billable' ? overageRate : null,
          rollover_rule: rollover,
          rollover_cap_minutes: cap,
          carry_in_minutes: carry,
          prior_terms_id: priorTerms || null,
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
      previous_id: previous || null,
    });
    previous = '';
    source = '';
    notice =
      'Versão preparada; exige decisão independente antes de produzir efeitos.';
  }
  async function decide(r: EconomicRecord, decision: string) {
    await post('economics/records/' + r.id + '/decide', {
      revision: r.revision,
      decision,
      reason,
      cost_role: costRole || null,
    });
    notice = 'Decisão econômica registrada.';
  }
  async function act(id: string, state: string, action: string) {
    await post('economics/times/' + id + '/action', {
      expected_state: state,
      action,
      reason,
      cost_role: costRole || null,
    });
    notice = 'Decisão/reversão de horas registrada.';
  }
  const percent = (bps: string | null) =>
    bps === null
      ? 'Indisponível'
      : `${BigInt(bps) < 0n && BigInt(bps) > -100n ? '-' : ''}${BigInt(bps) / 100n},${(BigInt(bps) < 0n ? -BigInt(bps) % 100n : BigInt(bps) % 100n).toString().padStart(2, '0')}%`;
</script>

<section class="panel economics" aria-label="Inteligência econômica">
  <div class="section-heading">
    <div>
      <p class="eyebrow">M4 · HORAS E ECONOMIA</p>
      <h2>Inteligência econômica</h2>
    </div>
    <button class="secondary" disabled={busy} onclick={() => void run(refresh)}
      >Atualizar economia</button
    >
  </div>
  <p class="muted">
    Valores em unidades mínimas da moeda e durações em minutos inteiros. Receita
    contratada não é recebimento. Projeções e realizado têm bases distintas;
    dados ausentes não viram zero.
  </p>
  {#if error}<p role="alert" class="error">{error}</p>{/if}{#if notice}<p
      role="status"
    >
      {notice}
    </p>{/if}
  {#if role !== 'developer'}<details>
      <summary>Preparar premissas e estimativas</summary>
      <form
        aria-label="Preparar registro econômico"
        class="commercial-form"
        onsubmit={(e) => {
          e.preventDefault();
          void run(prepare);
        }}
      >
        <label
          >Tipo de registro econômico<select
            bind:value={kind}
            onchange={() => (previous = '')}
            >{#each Object.entries(names).filter(([k]) => confidential || k === 'estimate') as [k, v]}<option
                value={k}>{v}</option
              >{/each}</select
          ></label
        >
        {#if previous}<p>
            Nova versão de {previous}; o original será preservado.
          </p>
          <button
            class="secondary"
            type="button"
            onclick={() => (previous = '')}>Preparar série nova</button
          >{/if}
        {#if !['config', 'rate'].includes(kind)}<label
            >Projeto econômico<select bind:value={project} required
              ><option value="">Selecione</option
              >{#each data.projects as p}<option value={p.id}>{p.name}</option
                >{/each}</select
            ></label
          >{/if}
        {#if ['estimate', 'direct_cost'].includes(kind)}<label
            >Termos aprovados para planejamento<select
              bind:value={terms}
              onchange={() => chooseTerm(terms)}
              required
              ><option value="">Selecione</option
              >{#each view.records.filter((r) => r.kind === 'terms' && r.decision === 'approved') as t}<option
                  value={t.id}
                  >{data.projects.find((p) => p.id === t.project_id)?.name} · {t.valid_from}
                  a {t.valid_until} · {t.id}</option
                >{/each}</select
            ></label
          >{/if}
        <label
          >Moeda econômica<select bind:value={cur}
            >{#each currencies as c}<option value={c}>{c}</option
              >{/each}</select
          ></label
        >
        <label
          >Início da competência/vigência<input
            type="date"
            bind:value={from}
            required
          /></label
        ><label
          >Fim da competência/vigência<input
            type="date"
            bind:value={until}
            min={from}
            required
          /></label
        >
        <label
          >Fonte das premissas<input
            bind:value={source}
            maxlength="2000"
            required
            placeholder="Documento sintético ou referência autorizada"
          /></label
        >
        {#if kind === 'config'}
          <label
            >Tributos em pontos-base<input
              type="number"
              min="0"
              max="10000"
              step="1"
              bind:value={tax}
              required
            /></label
          ><label
            >Comissões em pontos-base<input
              type="number"
              min="0"
              max="10000"
              step="1"
              bind:value={commission}
              required
            /></label
          >
          <label
            >Regra de overhead<select bind:value={ohRule} required
              ><option value="">Selecione explicitamente</option><option
                value="none_explicit"
                >Sem overhead por declaração explícita</option
              ><option value="per_labor_minute"
                >Rateio por minutos de trabalho</option
              ></select
            ></label
          >
          {#if ohRule === 'per_labor_minute'}<label
              >Overhead por hora em unidades mínimas<input
                bind:value={ohRate}
                pattern="0|[1-9][0-9]*"
                required
              /></label
            ><small class="money-preview" aria-live="polite"
              >{preview(ohRate)}</small
            >{/if}
          <label
            >Dias de trabalho ISO separados por vírgula<input
              bind:value={weekdays}
              required
              placeholder="1=segunda até 7=domingo"
            /></label
          ><label
            >Minutos de trabalho por dia<input
              type="number"
              min="1"
              max="1440"
              step="1"
              bind:value={minutesDay}
              required
            /></label
          ><label
            >Feriados ISO separados por vírgula (vazio declara nenhum)<input
              bind:value={holidays}
            /></label
          >
        {:else if kind === 'rate' || kind === 'estimate' || kind === 'capacity'}
          <label
            >Profissional econômico<select
              bind:value={person}
              required={kind !== 'rate'}
              ><option value=""
                >{kind === 'rate'
                  ? 'Usar função em vez de profissional'
                  : 'Selecione'}</option
              >{#each members as m}<option value={m.id}
                  >{m.name} · {m.email}</option
                >{/each}</select
            ></label
          >
          {#if kind === 'rate'}<label
              >Função para custo/hora<select bind:value={functionRole}
                ><option value="">Usar profissional em vez de função</option
                >{#each ['developer', 'po', 'manager', 'administrator'] as r}<option
                    value={r}>{roleNames[r] ?? r}</option
                  >{/each}</select
              ></label
            ><label
              >Custo por hora em unidades mínimas<input
                bind:value={rate}
                pattern="0|[1-9][0-9]*"
                required
              /></label
            ><small class="money-preview" aria-live="polite"
              >{preview(rate)}</small
            >
          {:else if kind === 'capacity'}<label
              >Capacidade disponível alocada em minutos<input
                type="number"
                min="0"
                max="10000000"
                step="1"
                bind:value={available}
                required
              /></label
            >
            <p class="muted">
              Disponibilidade declarada deste profissional para este
              projeto/período; não é hora contratada ou consumida.
            </p>
          {:else}<label
              >Demanda a estimar<select bind:value={request} required
                ><option value="">Selecione</option
                >{#each data.requests.filter((r) => data.interactions.find((i) => i.id === r.interaction_id)?.project_id === project) as r}<option
                    value={r.id}>{r.title}</option
                  >{/each}</select
              ></label
            ><label
              >Baseline prevista em minutos<input
                type="number"
                min="0"
                step="1"
                bind:value={planned}
                required
              /></label
            ><label
              >Minutos para concluir<input
                type="number"
                min="0"
                step="1"
                bind:value={remaining}
                required
              /></label
            ><label
              >Data prevista de conclusão<input
                type="date"
                bind:value={expected}
                required
              /></label
            >{/if}
        {:else if kind === 'terms'}
          <label
            >Contrato econômico<select bind:value={contractId} required
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
          <label
            >Valor contratado na competência em unidades mínimas<input
              bind:value={amount}
              pattern="0|[1-9][0-9]*"
              required
            /></label
          ><small class="money-preview" aria-live="polite"
            >{preview(amount)}</small
          ><label
            >Regra de reconhecimento<select bind:value={recognition} required
              ><option value="">Selecione explicitamente</option><option
                value="none">Sem reconhecimento configurado</option
              ><option value="at_period_end"
                >Total contratado ao fim do período</option
              ><option value="manual"
                >Valor reconhecido explícito e aprovado</option
              ></select
            ></label
          >{#if recognition === 'manual'}<label
              >Receita reconhecida em unidades mínimas<input
                bind:value={recognized}
                pattern="0|[1-9][0-9]*"
                required
              /></label
            ><small class="money-preview" aria-live="polite"
              >{preview(recognized)}</small
            >{/if}
          <label
            ><input type="checkbox" bind:checked={directComplete} /> Custos externos
            estão completos, inclusive ausência explicitamente declarada</label
          ><label
            ><input type="checkbox" bind:checked={timeComplete} /> Apontamentos estão
            completos para a observação aprovada</label
          >
          <label
            >Minutos incluídos no retainer (vazio para preço fechado)<input
              type="number"
              min="0"
              step="1"
              bind:value={included}
            /></label
          ><label
            >Regra de excedente<select bind:value={overage} required
              ><option value="">Selecione</option><option value="none"
                >Sem receita adicional por excedente</option
              ><option value="billable">Excedente faturável por hora</option
              ></select
            ></label
          >{#if overage === 'billable'}<label
              >Preço por hora excedente em unidades mínimas<input
                bind:value={overageRate}
                required
              /></label
            ><small class="money-preview" aria-live="polite"
              >{preview(overageRate)}</small
            >{/if}
          <label
            >Regra de rollover<select bind:value={rollover} required
              ><option value="">Selecione</option><option value="none"
                >Sem transferência entre períodos</option
              ><option value="carry_capped"
                >Transferência com teto e origem aprovada</option
              ></select
            ></label
          ><label
            >Teto de rollover em minutos (0 explícito sem rollover)<input
              type="number"
              min="0"
              step="1"
              bind:value={cap}
              required
            /></label
          ><label
            >Entrada de rollover em minutos (0 explícito sem saldo)<input
              type="number"
              min="0"
              step="1"
              bind:value={carry}
              required
            /></label
          >
          <label
            >Origem aprovada do rollover<select bind:value={priorTerms}
              ><option value="">Sem entrada de saldo</option
              >{#each view.records.filter((r) => r.kind === 'terms' && r.decision === 'approved') as t}<option
                  value={t.id}>{t.id} · {t.valid_from} a {t.valid_until}</option
                >{/each}</select
            ></label
          >
          <label
            >Change request M3 aprovado para aditivo<select
              bind:value={changeId}
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
          ><label
            >Orçamento da despesa em unidades mínimas<input
              bind:value={budget}
              required
            /></label
          ><small class="money-preview" aria-live="polite"
            >{preview(budget)}</small
          ><label
            >Parcela incorrida em unidades mínimas<input
              bind:value={incurred}
              required
            /></label
          ><small class="money-preview" aria-live="polite"
            >{preview(incurred)}</small
          ><label
            >Parcela para concluir em unidades mínimas<input
              bind:value={future}
              required
            /></label
          ><small class="money-preview" aria-live="polite"
            >{preview(future)}</small
          >
          <p class="muted">
            Uma despesa por referência; trabalho e overhead não entram aqui. Não
            é saída de caixa.
          </p>{/if}
        <button disabled={busy}>Preparar versão econômica</button>
      </form>
    </details>{/if}
  {#if confidential}<label
      >Função de custo explicitamente conferida (opcional)<select
        bind:value={costRole}
        ><option value=""
          >Usar somente taxa individual; sem inferência por papel</option
        >{#each ['developer', 'po', 'manager', 'administrator'] as r}<option
            value={r}>{roleNames[r] ?? r}</option
          >{/each}</select
      ></label
    ><label
      >Justificativa econômica de decisão/reversão<input
        bind:value={reason}
        maxlength="2000"
        placeholder="Conferência independente e fonte"
      /></label
    >{/if}
  {#if role !== 'developer'}<details>
      <summary>Versões e decisões econômicas</summary
      >{#each view.records.filter((r) => r.kind !== 'terms' || confidential) as r}<article
          class="request"
        >
          <h3>{names[r.kind]} · revisão {r.revision}</h3>
          {#if r.project_id}<p class="eyebrow">
              {data.projects.find((p) => p.id === r.project_id)?.name ??
                r.project_id}
            </p>{/if}
          <p>
            {r.valid_from} a {r.valid_until} · {r.decision === 'approved'
              ? 'Aprovado'
              : r.decision === 'rejected'
                ? 'Rejeitado'
                : 'Pendente'} · fonte: {r.source}
          </p>
          <p class="muted">Autor: {who(r.created_by)} · {r.created_at}</p>
          <details>
            <summary>Valores e rastreabilidade</summary>
            <pre>{JSON.stringify(r, null, 2)}</pre>
          </details>
          {#if r.decision && ((r.kind === 'estimate' && role !== 'developer') || confidential)}<button
              class="secondary"
              disabled={busy}
              onclick={() => loadRecord(r)}>Revisar esta versão</button
            >{/if}{#if confidential && !r.decision}<button
              disabled={busy || !reason.trim() || r.created_by === userId}
              onclick={() => void run(() => decide(r, 'approved'))}
              >Aprovar registro {r.id}</button
            ><button
              class="secondary"
              disabled={busy || !reason.trim() || r.created_by === userId}
              onclick={() => void run(() => decide(r, 'rejected'))}
              >Rejeitar registro {r.id}</button
            >{/if}
        </article>{:else}<p>Nenhuma versão econômica.</p>{/each}
    </details>{/if}
  <details>
    <summary>Apontar horas próprias</summary>
    <form
      aria-label="Apontar horas próprias"
      class="commercial-form"
      onsubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await post('economics/times', {
            project_id: timeProject,
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
      <label
        >Projeto das horas<select bind:value={timeProject} required
          ><option value="">Selecione</option>{#each data.projects as p}<option
              value={p.id}>{p.name}</option
            >{/each}</select
        ></label
      ><label
        >Demanda das horas<select bind:value={timeRequest} required
          ><option value="">Selecione</option
          >{#each data.requests.filter((r) => data.interactions.find((i) => i.id === r.interaction_id)?.project_id === timeProject) as r}<option
              value={r.id}>{r.title}</option
            >{/each}</select
        ></label
      ><label
        >Data trabalhada<input
          type="date"
          bind:value={workDate}
          max={asOf}
          required
        /></label
      ><label
        >Duração em minutos<input
          type="number"
          min="1"
          max="1440"
          step="1"
          bind:value={duration}
          required
        /></label
      ><label
        >Comentário do apontamento<textarea
          bind:value={comment}
          required
          maxlength="2000"
        ></textarea></label
      ><label
        >Apontamento revertido/rejeitado a corrigir<select bind:value={replaces}
          ><option value="">Novo apontamento</option
          >{#each view.times.filter((t) => t.user_id === userId && ['reversed', 'rejected'].includes(t.state)) as t}<option
              value={t.id}>{t.work_date} · {t.minutes} min · {t.comment}</option
            >{/each}</select
        ></label
      ><button disabled={busy}>Registrar minutos</button>
    </form>
  </details>
  <details>
    <summary>Horas e decisões</summary>{#each view.times as t}<article
        class="request"
      >
        <h3>{t.comment}</h3>
        <p>
          {t.work_date} · {t.minutes} minutos · {t.state === 'approved'
            ? 'Aprovadas'
            : t.state === 'pending'
              ? 'Pendentes'
              : t.state === 'reversed'
                ? 'Revertidas'
                : 'Rejeitadas'} · {who(t.user_id)}
        </p>
        {#if confidential && t.user_id !== userId && t.state === 'pending'}<button
            disabled={busy || !reason.trim()}
            onclick={() => void run(() => act(t.id, t.state, 'approved'))}
            >Aprovar horas {t.id}</button
          ><button
            class="secondary"
            disabled={busy || !reason.trim()}
            onclick={() => void run(() => act(t.id, t.state, 'rejected'))}
            >Rejeitar horas {t.id}</button
          >{/if}{#if confidential && t.user_id !== userId && t.state === 'approved'}<button
            class="secondary"
            disabled={busy || !reason.trim()}
            onclick={() => void run(() => act(t.id, t.state, 'reversed'))}
            >Reverter horas {t.id}</button
          >{/if}{#if t.user_id === userId && t.state === 'pending'}<label
            >Motivo para reverter horas pendentes<input
              bind:value={reason}
            /></label
          ><button
            class="secondary"
            disabled={busy || !reason.trim()}
            onclick={() => void run(() => act(t.id, t.state, 'reversed'))}
            >Reverter minhas horas {t.id}</button
          >{/if}
      </article>{:else}<p>Nenhum apontamento.</p>{/each}
  </details>
  {#if confidential}<form
      aria-label="Calcular observação econômica"
      class="commercial-form"
      onsubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await post('economics/reports', {
            terms_id: reportTerms,
            as_of: asOf,
          });
          notice =
            'Observação econômica preservada com fontes e versão do motor.';
        });
      }}
    >
      <h3>Calcular observação econômica</h3>
      <label
        >Termos para relatório<select bind:value={reportTerms} required
          ><option value="">Selecione</option
          >{#each view.records.filter((r) => r.kind === 'terms' && r.decision === 'approved') as t}<option
              value={t.id}
              >{data.projects.find((p) => p.id === t.project_id)?.name} · {t.valid_from}
              a {t.valid_until} · revisão {t.revision}</option
            >{/each}</select
        ></label
      ><label
        >Data de corte das horas<input
          type="date"
          bind:value={asOf}
          required
        /></label
      ><button disabled={busy}>Calcular e preservar</button>
    </form>
    <h3>Observações por projeto · orçamento, incorrido e conclusão</h3>
    {#each view.reports as report}<article
        class="request economic-report"
        aria-label={'Relatório econômico ' + report.id}
      >
        <h3>
          {data.projects.find((p) => p.id === report.project_id)?.name} · {report
            .result.period_from} a {report.result.period_until}
        </h3>
        <p>
          Moeda {report.result.currency} · corte {report.result.as_of} · observado
          {report.created_at}
        </p>
        <dl>
          <dt>Receita contratada</dt>
          <dd>
            {moneyLabel(
              report.result.contracted_revenue,
              report.result.currency,
            )}
          </dd>
          <dt>Receita reconhecida</dt>
          <dd>
            {moneyLabel(
              report.result.recognized_revenue,
              report.result.currency,
            )}
          </dd>
          <dt>Orçamento de custo</dt>
          <dd>
            {moneyLabel(report.result.budget_cost, report.result.currency)}
          </dd>
          <dt>Custo incorrido, sem deduções sobre receita</dt>
          <dd>
            {moneyLabel(report.result.cost_incurred, report.result.currency)}
          </dd>
          <dt>Custo para concluir (ETC)</dt>
          <dd>
            {moneyLabel(
              report.result.estimate_to_complete,
              report.result.currency,
            )}
          </dd>
          <dt>Custo previsto na conclusão (EAC)</dt>
          <dd>{moneyLabel(report.result.eac, report.result.currency)}</dd>
          <dt>Margem projetada na conclusão</dt>
          <dd>
            {moneyLabel(report.result.projected_margin, report.result.currency)} ·
            {percent(report.result.projected_margin_bps)}
          </dd>
          <dt>Margem realizada sobre receita reconhecida</dt>
          <dd>
            {moneyLabel(report.result.realized_margin, report.result.currency)} ·
            {percent(report.result.realized_margin_bps)}
          </dd>
          <dt>Minutos previstos / aprovados / pendentes / restantes</dt>
          <dd>
            {report.result.planned_minutes ?? 'Desconhecidos'} / {report.result
              .approved_minutes} / {report.result.pending_minutes} / {report
              .result.remaining_minutes ?? 'Desconhecidos'}
          </dd>
          <dt>Capacidade alocada declarada</dt>
          <dd>{report.result.capacity_minutes ?? 'Desconhecida'} minutos</dd>
          <dt>Retainer: incluídos / entrada / saldo / excedente</dt>
          <dd>
            {report.result.included_minutes ?? 'Não aplicável'} / {report.result
              .carry_in_minutes} / {report.result.balance_minutes ??
              'Não aplicável'} / {report.result.overage_minutes ??
              'Não aplicável'}
          </dd>
        </dl>
        {#each report.result.alerts as alert}<p class="commercial-coverage">
            {alert}
          </p>{/each}
        {#if report.result.projection_missing.length}<p>
            Projeção incompleta: {report.result.projection_missing.join('; ')}
          </p>{/if}{#if report.result.actual_missing.length}<p>
            Realizado incompleto: {report.result.actual_missing.join('; ')}
          </p>{/if}
        <details>
          <summary>Fórmulas, premissas e fontes desta observação</summary>
          <p>
            EAC = trabalho aprovado + custos externos incorridos + overhead
            incorrido + ETC de trabalho/externos/overhead + tributos/comissões
            sobre receita projetada. Margem = (receita relevante − custo
            relevante) / receita relevante. Não é markup ou caixa.
          </p>
          <p>Motor {report.result.engine_version} · hash {report.input_hash}</p>
          <pre>{JSON.stringify(report.inputs, null, 2)}</pre>
        </details>
      </article>{:else}<p>
        Nenhuma observação calculada; não há indicadores financeiros sem dados
        aprovados.
      </p>{/each}
    <h3>Consolidação por cliente e competência</h3>
    <p class="muted">
      Última observação de cada projeto; moedas e competências separadas. Não
      soma revisões ou observações históricas repetidas.
    </p>
    {#each view.clients ?? [] as c}<article class="request">
        <h4>
          {data.clients.find((x) => x.id === c.client_id)?.name} · {c.period_from}
          a {c.period_until} · {c.currency}
        </h4>
        <p>
          Receita contratada no recorte observado: {moneyLabel(
            c.contracted_revenue,
            c.currency,
          )} · EAC:
          {moneyLabel(c.eac, c.currency)} · Margem projetada: {moneyLabel(
            c.projected_margin,
            c.currency,
          )} · {percent(c.projected_margin_bps)}
        </p>
        <p>Margem realizada: {moneyLabel(c.realized_margin, c.currency)}</p>
        {#if c.projection_missing.length}<p>
            Consolidação projetada incompleta: {c.projection_missing.join('; ')}
          </p>{/if}
        {#if c.actual_missing.length}<p>
            Consolidação realizada incompleta: {c.actual_missing.join('; ')}
          </p>{/if}
        <p class="muted">Fontes: {c.report_ids.join(', ')}</p>
      </article>{/each}
    <details>
      <summary>Auditoria econômica</summary>{#each view.events as e}<p>
          {e.created_at} · {e.entity_type}
          {e.entity_id} · {e.action} · {who(e.actor_user_id)} ({e.actor_role})
        </p>{/each}
    </details>
  {/if}
</section>
