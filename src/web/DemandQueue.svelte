<script lang="ts">
  import type { Snippet } from 'svelte';
  import { dayText, statusLabels } from '../shared/domain';
  import type {
    Interaction,
    Project,
    Status,
    WorkRequest,
  } from '../shared/domain';
  import {
    defaultFollowUp,
    nextStep,
    templateIds,
    templates,
    waitingLabels,
  } from '../shared/followup';
  import type {
    FollowupQueue,
    QueueItem,
    TemplateId,
  } from '../shared/followup';
  import type { Member, SessionView } from '../shared/identity';
  import { href } from './routes';

  let {
    api,
    session,
    members,
    interactions,
    projects,
    changes,
    editingId,
    form,
    onedit,
    busy,
    run,
  }: {
    api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
    session: SessionView;
    members: Member[];
    interactions: Interaction[];
    projects: Project[];
    /** Grows whenever the app saved something, so the queue reads again. */
    changes: number;
    editingId?: string;
    form: Snippet;
    onedit: (item: WorkRequest, status?: Status) => void;
    busy: boolean;
    run: (done: string, action: () => Promise<unknown>) => Promise<void>;
  } = $props();

  let queue = $state<FollowupQueue | null>(null);
  let adding = $state(false);
  let shown = $state(60);
  let title = $state('');
  let details = $state('');
  let action = $state('');
  let template = $state<TemplateId>('manutencao');
  let origin = $state('');
  let owner = $state('');

  // One small form per card: which answer is being recorded, and on which demand.
  type Step = 'agreement' | 'confirmation' | 'accepted' | 'rejected';
  let acting = $state<{ id: string; step: Step } | null>(null);
  let criteria = $state('');
  let highRisk = $state(false);
  let reason = $state('');
  let said = $state('');
  let trail = $state<Record<string, { text: string }[]>>({});

  const stepLabels: Record<Step, string> = {
    agreement: 'Salvar combinado',
    confirmation: 'Registrar confirmação',
    accepted: 'Registrar aceite',
    rejected: 'Registrar recusa',
  };

  const developer = $derived(session.role === 'developer');
  const authorizer = $derived(
    session.role === 'manager' || session.role === 'administrator',
  );
  const mine = $derived(queue?.items.filter((i) => i.for_me) ?? []);
  const team = $derived(queue?.items.filter((i) => !i.for_me) ?? []);
  const today = $derived(queue?.as_of ?? new Date().toISOString().slice(0, 10));

  async function load() {
    queue = await api<FollowupQueue>('followup');
  }
  $effect(() => {
    void changes;
    load().catch((e) => run('', () => Promise.reject(e)));
  });
  const patch = (i: QueueItem, changes: Record<string, unknown>) =>
    api(`requests/${i.id}`, 'PATCH', {
      status: i.status,
      owner_user_id: i.owner_user_id ?? session.user.id,
      next_action: i.next_action,
      version: i.version,
      ...changes,
    });
  const align = (i: QueueItem, body: Record<string, unknown>) =>
    api(`requests/${i.id}/alignment`, 'POST', {
      version: i.version,
      ...body,
    });
  /** What can stand as the client's answer: an acceptance must come after the delivery. */
  const answers = (i: QueueItem, step: Step) =>
    interactions
      .filter(
        (x) =>
          x.project_id === i.project_id &&
          (step === 'confirmation' ||
            (!!i.alignment?.delivered_at &&
              x.occurred_at >= i.alignment.delivered_at)),
      )
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  function act(i: QueueItem, step: Step) {
    acting = { id: i.id, step };
    criteria = i.alignment?.criteria ?? i.suggested_criteria ?? '';
    highRisk = !!i.alignment?.high_risk;
    reason = said = '';
  }
  function submit(e: SubmitEvent, i: QueueItem, step: Step) {
    e.preventDefault();
    void run(`${i.title}: ${stepLabels[step]} ok.`, async () => {
      if (step === 'agreement')
        await align(i, {
          kind: step,
          criteria,
          high_risk: highRisk,
          reason: i.alignment ? reason : undefined,
        });
      else {
        const id = said
          ? (
              await api<{ id: string }>('interactions', 'POST', {
                project_id: i.project_id,
                kind: 'service',
                summary: said,
                occurred_at: new Date().toISOString(),
              })
            ).id
          : answers(i, step)[0]?.id;
        await align(i, { kind: step, evidence_interaction_id: id, reason });
      }
      acting = null;
    });
  }
  const lacksOwner = (i: QueueItem) =>
    i.signals.some((s) => s.kind === 'no_owner');
  /** Every button of a card, in order: [label, what it does, is it secondary]. */
  function actions(i: QueueItem) {
    const al = i.alignment,
      running = i.status === 'in_progress',
      delivered = !!al?.delivered_at && running,
      step = al && running ? null : nextStep(i.status, i.template),
      told = (done: string, what: () => Promise<unknown>) => () =>
        run(`${i.title}: ${done}.`, what),
      edit = (to?: Status) => () => onedit(i as unknown as WorkRequest, to);
    const list: [string, () => void, boolean?][] = [];
    const add = (when: unknown, ...b: (typeof list)[number]) => {
      if (when) list.push(b);
    };
    add(
      al?.high_risk && !al.authorized && authorizer,
      'Autorizar alto risco',
      told('alto risco autorizado', () =>
        align(i, { kind: 'risk_authorization' }),
      ),
    );
    if (!developer && delivered) {
      list.push(
        ['Registrar aceite', () => act(i, 'accepted')],
        ['Registrar recusa', () => act(i, 'rejected'), true],
        [
          'Concluir sem aceite',
          told('concluída sem aceite', () => patch(i, { status: 'done' })),
          true,
        ],
      );
    }
    add(
      al && running && !delivered,
      'Marcar como entregue',
      told('entregue, aguardando o cliente', () =>
        align(i, { kind: 'delivered' }),
      ),
    );
    add(
      lacksOwner(i) && !developer,
      'Assumir',
      told('assumida', () => patch(i, { owner_user_id: session.user.id })),
    );
    add(
      step && (!developer || ['in_progress', 'done'].includes(step.to)),
      step?.label ?? '',
      () => advance(i, step!.to),
      lacksOwner(i),
    );
    add(
      ['triage', 'ready', 'in_progress'].includes(i.status),
      'Bloquear',
      edit('blocked'),
      true,
    );
    list.push(['Atualizar', edit(), true]);
    if (!developer && !delivered) {
      list.push([
        al ? 'Mudar combinado' : 'Combinado',
        () => act(i, 'agreement'),
        true,
      ]);
      add(
        al && !al.confirmed,
        'Cliente confirmou',
        () => act(i, 'confirmation'),
        true,
      );
    }
    return list;
  }
  function advance(i: QueueItem, to: Status) {
    // Closing has no next action. Any other stage shows it first: it may no longer apply.
    if (to === 'done')
      void run(`${i.title}: concluída.`, () => patch(i, { status: to }));
    else onedit(i as unknown as WorkRequest, to);
  }
  function register(e: SubmitEvent) {
    e.preventDefault();
    void run(`Demanda registrada: ${title}`, async () => {
      await api('requests', 'POST', {
        interaction_id: origin || interactions[0]?.id,
        title,
        description: details || title,
        owner_user_id: owner || session.user.id,
        next_action: action || templates[template].nextAction,
        template,
      });
      title = details = action = '';
      adding = false;
    });
  }
</script>

{#snippet card(i: QueueItem)}
  {@const al = i.alignment}
  <li class="request">
    <span class="status" data-status={i.status}>{statusLabels[i.status]}</span>
    <p class="eyebrow">{i.client_name} / {i.project_name}</p>
    <p><strong>{i.title}</strong></p>
    {#each i.signals as s (s.kind)}<p class="attention">
        <strong>⚠ {s.label}{s.is_new ? ' · novo' : ''}</strong><br />
        {s.reason}
      </p>{/each}
    <dl>
      <dt>Próxima ação</dt>
      <dd>{i.next_action}</dd>
      <dt>Responsável</dt>
      <dd>{i.owner}</dd>
      <dt>Compromisso</dt>
      <dd>
        {#if i.follow_up_on}<time>{dayText(i.follow_up_on)}</time>{:else}Sem
          data{/if}
      </dd>
      {#if i.waiting_on}<dt>Depende de</dt>
        <dd>{waitingLabels[i.waiting_on]}</dd>{/if}
      {#if al}<dt>Critérios de aceite · v{al.version}</dt>
        <dd>
          {al.criteria}<br /><span class="muted"
            >{al.confirmed
              ? 'Confirmado pelo cliente'
              : 'Sem confirmação do cliente'}{al.high_risk
              ? ' · Alto risco'
              : ''}</span
          >
        </dd>{/if}
    </dl>
    {#if al}<details
        ontoggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open)
            api<{ text: string }[]>(`requests/${i.id}/alignment`).then(
              (rows) => (trail[i.id] = rows),
            );
        }}
      >
        <summary>Histórico do combinado</summary>
        <ul>
          {#each trail[i.id] ?? [] as t}<li>{t.text}</li>{/each}
        </ul>
      </details>{/if}
    {#if acting?.id === i.id}
      {@const s = acting.step}
      {@const known = answers(i, s)}
      <form
        class="edit"
        aria-label={stepLabels[s]}
        onsubmit={(e) => submit(e, i, s)}
      >
        {#if s === 'agreement'}
          <label
            >Critérios de aceite<textarea
              bind:value={criteria}
              required
              maxlength="4000"
            ></textarea></label
          >
          <label
            ><input type="checkbox" bind:checked={highRisk} /> Alto risco: exige autorização
            de um gestor</label
          >
        {:else}
          <label
            >{known[0]
              ? `Evidência: ${known[0].summary.slice(0, 60)}. Se houver resposta mais nova, escreva aqui`
              : 'O que o cliente disse'}<input
              bind:value={said}
              required={!known[0]}
              maxlength="2000"
            /></label
          >
        {/if}
        {#if s === 'rejected' || (al && s === 'agreement')}<label
            >Motivo {s === 'rejected' ? 'da recusa' : 'da mudança'}<input
              bind:value={reason}
              required
              maxlength="2000"
            /></label
          >{/if}
        <button disabled={busy}>{stepLabels[s]}</button>
        <button type="button" class="secondary" onclick={() => (acting = null)}
          >Cancelar</button
        >
      </form>
    {:else if editingId === i.id}{@render form()}{:else}
      <div class="row-actions">
        {#each actions(i) as [label, onclick, secondary] (label)}<button
            class:secondary
            disabled={busy}
            aria-label={`${label}: ${i.title}`}
            {onclick}>{label}</button
          >{/each}
        {#if !developer && i.signals.some((s) => s.kind === 'no_coverage')}<a
            class="button-link secondary"
            href={href('comercial', { demanda: i.id })}>Analisar cobertura</a
          >{/if}
      </div>
    {/if}
  </li>
{/snippet}

<section class="panel" aria-label="Fila de ações">
  <div class="section-heading">
    <div>
      <p class="eyebrow">O QUE FAZER AGORA</p>
      <h2>Fila de ações</h2>
    </div>
    <div class="row-actions">
      {#if queue?.new_alerts}<button
          class="secondary"
          disabled={busy}
          onclick={() =>
            run('Avisos vistos.', () => api('followup/alerts/ack', 'POST', {}))}
          >Marcar avisos como vistos ({queue.new_alerts})</button
        >{/if}
      {#if !developer}<button
          aria-expanded={adding}
          onclick={() => (adding = !adding)}>Registrar demanda</button
        >{/if}
    </div>
  </div>
  {#if queue?.automation && (queue.automation.late || queue.automation.failed || queue.automation.retrying)}
    <p class="attention" role="status">
      <strong>Automação com atraso.</strong> A fila continua correta; avisos
      novos podem demorar. {queue.automation.retrying} em nova tentativa, {queue
        .automation.failed} com falha.
    </p>
  {/if}
  {#each queue?.overloaded ?? [] as p (p.name)}<p class="attention">
      <strong>Excesso de trabalho:</strong>
      {p.name} tem {p.in_progress} demandas em execução
    </p>{/each}
  {#if adding}
    <form class="edit" aria-label="Registrar demanda" onsubmit={register}>
      <label>Título<input bind:value={title} required maxlength="200" /></label>
      <label
        >Modelo<select bind:value={template}
          >{#each templateIds as t (t)}<option value={t}
              >{templates[t].label}</option
            >{/each}</select
        ></label
      >
      <label
        >Atendimento de origem<select bind:value={origin}
          ><option value="">Mais recente</option
          >{#each interactions as i (i.id)}<option value={i.id}
              >{projects.find((p) => p.id === i.project_id)?.name} · {i.summary.slice(
                0,
                60,
              )}</option
            >{/each}</select
        ></label
      >
      <label
        >Responsável<select bind:value={owner}
          ><option value="">Eu</option>{#each members as m (m.id)}<option
              value={m.id}>{m.name} · {m.email}</option
            >{/each}</select
        ></label
      >
      <label
        >Próxima ação<input
          bind:value={action}
          maxlength="2000"
          placeholder={templates[template].nextAction}
        /></label
      >
      <label
        >Detalhes<textarea bind:value={details} maxlength="10000"
        ></textarea></label
      >
      <p class="muted">
        Compromisso: {dayText(defaultFollowUp(today, template))}
      </p>
      <button disabled={busy || !interactions.length}>Criar demanda</button>
    </form>
  {/if}
  {#if queue}
    <h3 id="queue-mine">Com você ({mine.length})</h3>
    {#if mine.length}<ol class="cards plain" aria-labelledby="queue-mine">
        {#each mine.slice(0, shown) as i (i.id)}{@render card(i)}{/each}
      </ol>
    {:else}<p class="muted">Nada para você agora.</p>{/if}
    {#if team.length}<h3 id="queue-team">Da equipe ({team.length})</h3>
      <ol class="cards plain" aria-labelledby="queue-team">
        {#each team.slice(0, shown) as i (i.id)}{@render card(i)}{/each}
      </ol>{/if}
    {#if mine.length > shown || team.length > shown}<button
        class="secondary"
        onclick={() => (shown += 60)}>Mostrar mais</button
      >{/if}
  {/if}
</section>
