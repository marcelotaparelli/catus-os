<script lang="ts">
  import type { Snippet } from 'svelte';
  import { dayText, statusLabels } from '../shared/domain';
  import type { Interaction, Project, Status } from '../shared/domain';
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
    onsaved,
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
    onedit: (id: string, status?: Status) => void;
    onsaved: () => Promise<void>;
  } = $props();

  let queue = $state<FollowupQueue | null>(null);
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);
  let adding = $state(false);
  let title = $state('');
  let details = $state('');
  let action = $state('');
  let template = $state<TemplateId>('manutencao');
  let origin = $state('');
  let owner = $state('');

  const developer = $derived(session.role === 'developer');
  const mine = $derived(queue?.items.filter((i) => i.for_me) ?? []);
  const team = $derived(queue?.items.filter((i) => !i.for_me) ?? []);
  const today = $derived(queue?.as_of ?? new Date().toISOString().slice(0, 10));

  async function load() {
    try {
      queue = await api<FollowupQueue>('followup');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Falha inesperada';
    }
  }
  $effect(() => {
    void changes;
    void load();
  });
  async function run(done: string, action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = notice = '';
    try {
      await action();
      await onsaved();
      notice = done;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Falha inesperada';
      // A lost race shows the current data instead of retrying over it.
      await load();
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
  const lacksOwner = (i: QueueItem) =>
    i.signals.some((s) => s.kind === 'no_owner');
  function advance(i: QueueItem, to: Status) {
    // Closing has no next action. Any other stage shows it first: it may no longer apply.
    if (to === 'done')
      void run(`${i.title}: concluída.`, () => patch(i, { status: to }));
    else onedit(i.id, to);
  }
  function register(e: SubmitEvent) {
    e.preventDefault();
    void run(`Demanda registrada: ${title}.`, async () => {
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
  {@const step = nextStep(i.status, i.template)}
  <li class="request">
    <span class="status" data-status={i.status}>{statusLabels[i.status]}</span>
    <p class="eyebrow">{i.client_name} / {i.project_name}</p>
    <p><strong>{i.title}</strong></p>
    {#each i.signals as s (s.kind)}<p class="signal">
        <strong>⚠ {s.label}{s.is_new ? ' · novo' : ''}</strong>
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
    </dl>
    {#if editingId === i.id}{@render form()}{:else}
      <div class="queue-actions">
        {#if lacksOwner(i) && !developer}<button
            disabled={busy}
            onclick={() =>
              run(`${i.title}: agora é sua.`, () =>
                patch(i, { owner_user_id: session.user.id }),
              )}>Assumir</button
          >{/if}
        {#if step && (!developer || ['in_progress', 'done'].includes(step.to))}<button
            class:secondary={lacksOwner(i)}
            disabled={busy}
            aria-label={`${step.label}: ${i.title}`}
            onclick={() => advance(i, step.to)}>{step.label}</button
          >{/if}
        {#if ['triage', 'ready', 'in_progress'].includes(i.status)}<button
            class="secondary"
            disabled={busy}
            aria-label={`Bloquear: ${i.title}`}
            onclick={() => onedit(i.id, 'blocked')}>Bloquear</button
          >{/if}
        <button
          class="secondary"
          disabled={busy}
          aria-label={`Atualizar: ${i.title}`}
          onclick={() => onedit(i.id)}>Atualizar</button
        >
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
      <p class="eyebrow">NENHUMA DEMANDA ESQUECIDA</p>
      <h2>Fila de ações</h2>
    </div>
    <div class="queue-actions">
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
  {#if error}<p class="attention" role="alert">{error}</p>{/if}
  {#if notice}<p class="muted" role="status">{notice}</p>{/if}
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
    {#if mine.length}<ol class="cards" aria-labelledby="queue-mine">
        {#each mine as i (i.id)}{@render card(i)}{/each}
      </ol>
    {:else}<p class="muted">Nada aguarda você agora.</p>{/if}
    {#if team.length}<h3 id="queue-team">Da equipe ({team.length})</h3>
      <ol class="cards" aria-labelledby="queue-team">
        {#each team as i (i.id)}{@render card(i)}{/each}
      </ol>{/if}
  {/if}
</section>

<style>
  ol {
    list-style: none;
    padding: 0;
  }
  .queue-actions {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .signal {
    border-left: 3px solid currentColor;
    padding-left: 8px;
  }
  .signal strong {
    display: block;
  }
</style>
