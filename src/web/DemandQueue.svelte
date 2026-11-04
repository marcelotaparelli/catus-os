<script lang="ts">
  import { onMount } from 'svelte';
  import { dayText, dayFromText, statusLabels } from '../shared/domain';
  import type { Interaction, Project } from '../shared/domain';
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
    WaitingOn,
  } from '../shared/followup';
  import type { Member, SessionView } from '../shared/identity';
  import { href } from './routes';

  let {
    api,
    session,
    members,
    interactions,
    projects,
    onchange,
  }: {
    api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
    session: SessionView;
    members: Member[];
    interactions: Interaction[];
    projects: Project[];
    onchange: () => Promise<void>;
  } = $props();

  let queue = $state<FollowupQueue | null>(null);
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);
  let adding = $state(false);
  let openId = $state('');
  let mode = $state<'block' | 'later' | 'assign'>('later');
  let reason = $state('');
  let waiting = $state<WaitingOn>('client');
  let day = $state('');
  let person = $state('');
  let title = $state('');
  let description = $state('');
  let template = $state<TemplateId>('manutencao');
  let origin = $state('');
  let owner = $state('');

  const developer = $derived(session.role === 'developer');
  const mine = $derived(queue?.items.filter((i) => i.for_me) ?? []);
  const team = $derived(queue?.items.filter((i) => !i.for_me) ?? []);
  const originId = $derived(origin || interactions[0]?.id || '');
  const stageTimes = $derived(queue?.stage_times ?? []);

  async function load() {
    queue = await api<FollowupQueue>('followup');
  }
  async function run(done: string, action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = notice = '';
    try {
      await action();
      await Promise.all([load(), onchange()]);
      notice = done;
      openId = '';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Falha inesperada';
      // A lost race shows the current data instead of retrying over it.
      if ((e as { status?: number }).status === 409) await load();
    } finally {
      busy = false;
    }
  }
  const patch = (i: QueueItem, changes: Record<string, unknown>) =>
    api(`requests/${i.id}`, 'PATCH', {
      status: i.status,
      owner_user_id: i.owner_user_id ?? session.user.id,
      next_action: i.next_action,
      version: i.version,
      ...changes,
    });
  function canAdvance(i: QueueItem, to: string) {
    return !developer || ['in_progress', 'done'].includes(to);
  }
  function panel(i: QueueItem, next: typeof mode) {
    if (openId === i.id && mode === next) {
      openId = '';
      return;
    }
    openId = i.id;
    mode = next;
    reason = i.blocked_reason ?? '';
    waiting = i.waiting_on ?? 'client';
    person = i.owner_user_id ?? '';
    day = dayText(defaultFollowUp(queue!.as_of, i.template));
  }
  function submitPanel(i: QueueItem) {
    if (mode === 'assign') {
      void run(`${i.title}: responsável definido.`, () =>
        patch(i, { owner_user_id: person }),
      );
      return;
    }
    const follow = dayFromText(day);
    if (!follow) {
      error = 'Informe a data em DD/MM/AAAA.';
      return;
    }
    void run(
      mode === 'block' ? `${i.title}: bloqueio registrado.` : `${i.title}: novo compromisso em ${day}.`,
      () =>
        patch(i, {
          follow_up_on: follow,
          ...(mode === 'block'
            ? { status: 'blocked', blocked_reason: reason, waiting_on: waiting }
            : {}),
        }),
    );
  }
  function register(e: SubmitEvent) {
    e.preventDefault();
    const t = title;
    void run(`Demanda registrada: ${t}.`, async () => {
      await api('requests', 'POST', {
        interaction_id: originId,
        title: t,
        description: description || t,
        owner_user_id: owner || session.user.id,
        next_action: templates[template].nextAction,
        template,
      });
      title = description = '';
      adding = false;
    });
  }
  const originLabel = (i: Interaction) =>
    `${projects.find((p) => p.id === i.project_id)?.name ?? ''} · ${i.summary.slice(0, 60)}`;
  const minutes = (m: number) =>
    m < 60
      ? `${m} min`
      : m < 1440
        ? `${Math.round(m / 60)} h`
        : `${Math.round(m / 1440)} d`;

  onMount(() => {
    load().catch((e) => {
      error = e instanceof Error ? e.message : 'Falha inesperada';
    });
  });
</script>

{#snippet card(i: QueueItem)}
  <li class="request">
    <div class="card-top">
      <span class="status" data-status={i.status}>{statusLabels[i.status]}</span>
      {#if i.template}<span class="muted">{templates[i.template].label}</span>{/if}
    </div>
    <p class="eyebrow">{i.client_name} / {i.project_name}</p>
    <h3>{i.title}</h3>
    {#each i.signals as s (s.kind)}<p class="signal">
        <strong>⚠ {s.label}{#if s.is_new}<span class="mine-tag"> · novo</span>{/if}</strong>
        {s.reason}
      </p>{/each}
    <dl>
      <dt>Próxima ação</dt>
      <dd>{i.next_action}</dd>
      <dt>Responsável</dt>
      <dd>{i.owner}{#if i.owner_user_id === session.user.id}<span class="mine-tag"> · você</span>{/if}</dd>
      <dt>Compromisso</dt>
      <dd>{i.follow_up_on ? dayText(i.follow_up_on) : 'Sem data'}</dd>
      {#if i.waiting_on}<dt>Depende de</dt>
        <dd>{waitingLabels[i.waiting_on]}</dd>{/if}
    </dl>
    <div class="queue-actions">
      {#if i.signals.some((s) => s.kind === 'no_owner') && !developer}
        <button disabled={busy} onclick={() => run(`${i.title}: agora é sua.`, () => patch(i, { owner_user_id: session.user.id }))}>Assumir</button>
      {/if}
      {#if nextStep(i.status, i.template)}
        {@const step = nextStep(i.status, i.template)!}
        {#if canAdvance(i, step.to)}<button class:secondary={i.signals.some((s) => s.kind === 'no_owner')} disabled={busy} onclick={() => run(`${i.title}: ${statusLabels[step.to]}.`, () => patch(i, { status: step.to }))}>{step.label}</button>{/if}
      {/if}
      <button class="secondary" disabled={busy} onclick={() => panel(i, 'later')}>Novo compromisso</button>
      {#if i.status !== 'blocked' && (!developer || i.status === 'ready' || i.status === 'in_progress')}<button class="secondary" disabled={busy} onclick={() => panel(i, 'block')}>Bloquear</button>{/if}
      {#if !developer}<button class="secondary" disabled={busy} onclick={() => panel(i, 'assign')}>Trocar responsável</button>
        {#if i.signals.some((s) => s.kind === 'no_coverage')}<a class="button-link secondary" href={href('comercial', { demanda: i.id })}>Analisar cobertura</a>{/if}
      {/if}
      {#if i.status === 'in_progress' && i.owner_user_id === session.user.id}<a class="text-link" href={href('economia', { painel: 'apontar', projeto: i.project_id, demanda: i.id })}>Apontar horas</a>{/if}
    </div>
    {#if openId === i.id}
      <form class="edit" aria-label="Detalhar ação" onsubmit={(e) => { e.preventDefault(); submitPanel(i); }}>
        {#if mode === 'assign'}
          <label>Novo responsável<select bind:value={person} required><option value="">Selecione</option>{#each members as m (m.id)}<option value={m.id}>{m.name}</option>{/each}</select></label>
        {:else}
          {#if mode === 'block'}
            <label>Motivo do bloqueio<input bind:value={reason} required maxlength="2000" /></label>
            <label>Depende de<select bind:value={waiting}>{#each Object.entries(waitingLabels) as [k, v] (k)}<option value={k}>{v}</option>{/each}</select></label>
          {/if}
          <label>{mode === 'block' ? 'Cobrar em (DD/MM/AAAA)' : 'Verificar em (DD/MM/AAAA)'}<input bind:value={day} required inputmode="numeric" autocomplete="off" /></label>
        {/if}
        <button disabled={busy}>Confirmar</button>
      </form>
    {/if}
  </li>
{/snippet}

<section class="panel" aria-label="Fila de ações">
  <div class="section-heading">
    <div>
      <p class="eyebrow">NENHUMA DEMANDA ESQUECIDA</p>
      <h2>Fila de ações</h2>
    </div>
    <div class="queue-actions">
      {#if queue?.new_alerts}<button class="secondary" disabled={busy} onclick={() => run('Avisos marcados como vistos.', () => api('followup/alerts/ack', 'POST', {}))}>Marcar {queue.new_alerts} {queue.new_alerts === 1 ? 'aviso' : 'avisos'} como {queue.new_alerts === 1 ? 'visto' : 'vistos'}</button>{/if}
      {#if !developer}<button aria-expanded={adding} onclick={() => (adding = !adding)}>Registrar demanda</button>{/if}
    </div>
  </div>
  {#if error}<p class="attention" role="alert">{error}</p>{/if}
  {#if notice}<p class="muted" role="status">{notice}</p>{/if}
  {#if queue?.automation && (queue.automation.late || queue.automation.failed || queue.automation.retrying)}
    <p class="attention" role="status">
      <strong>Automação com atraso.</strong>
      A fila abaixo continua correta, porque é calculada a cada leitura; avisos novos podem demorar.
      {queue.automation.retrying} em nova tentativa, {queue.automation.failed} com falha.
    </p>
  {/if}
  {#each queue?.overloaded ?? [] as p (p.name)}<p class="attention"><strong>Excesso de trabalho:</strong> {p.name} tem {p.in_progress} demandas em execução ao mesmo tempo.</p>{/each}
  {#if adding}
    <form class="edit" aria-label="Registrar demanda" onsubmit={register}>
      <label>Título<input bind:value={title} required maxlength="200" /></label>
      <label>Modelo<select bind:value={template}>{#each templateIds as t (t)}<option value={t}>{templates[t].label}</option>{/each}</select></label>
      <label>Atendimento de origem<select value={originId} onchange={(e) => (origin = e.currentTarget.value)} required>{#each interactions as i (i.id)}<option value={i.id}>{originLabel(i)}</option>{/each}</select></label>
      <label>Responsável<select bind:value={owner}><option value="">Eu</option>{#each members as m (m.id)}<option value={m.id}>{m.name}</option>{/each}</select></label>
      <label>Detalhes (opcional)<textarea bind:value={description} maxlength="10000"></textarea></label>
      <p class="muted">Próxima ação: {templates[template].nextAction}. Compromisso em {dayText(defaultFollowUp(queue?.as_of ?? new Date().toISOString().slice(0, 10), template))}.</p>
      <button disabled={busy || !originId}>Criar demanda</button>
    </form>
  {/if}
  {#if !queue && !error}<p class="muted" role="status">Carregando a fila…</p>
  {:else if queue}
    <h3 id="queue-mine">Com você ({mine.length})</h3>
    {#if mine.length}<ol class="cards" aria-labelledby="queue-mine">{#each mine as i (i.id)}{@render card(i)}{/each}</ol>
    {:else}<p class="muted">Nada aguarda você agora.</p>{/if}
    {#if team.length}<h3 id="queue-team">Da equipe, com pendência ({team.length})</h3>
      <ol class="cards" aria-labelledby="queue-team">{#each team as i (i.id)}{@render card(i)}{/each}</ol>{/if}
    {#if stageTimes.length}<p class="muted">Tempo mediano por etapa, nas demandas registradas: {stageTimes.map((s) => `${statusLabels[s.status]} ${minutes(s.median_minutes)} (${s.count})`).join(' · ')}.</p>{/if}
  {/if}
</section>

<style>
  ol {
    list-style: none;
    padding: 0;
  }
  .queue-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .signal {
    border-left: 3px solid var(--warning, #b45309);
    padding-left: 8px;
    margin: 6px 0;
  }
  .signal strong {
    display: block;
  }
</style>
