<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { Component } from 'svelte';
  import {
    dayFromText,
    dayText,
    instantFromText,
    statuses,
    statusLabels,
    timeLabel,
    transitions,
  } from '../shared/domain';
  import type { Snapshot, Status, WorkRequest } from '../shared/domain';
  import './style.css';
  import {
    allowed,
    href,
    parse,
    rememberReturn,
    routeById,
    routes,
    takeReturn,
  } from './routes';
  import type { Location, RouteId } from './routes';
  import { roleLabels } from '../shared/identity';
  import type { SessionView, Member } from '../shared/identity';
  import type { OverviewWithFollowup as OverviewData } from '../shared/overview';
  // Module screens load on first visit (separate chunks), then stay mounted while
  // hidden so drafts, selections and scroll survive switching between modules.
  const loaders = {
    comercial: () => import('./CommercialControl.svelte'),
    economia: () => import('./EconomicsControl.svelte'),
    'atendimento-inteligente': () => import('./IntelligentIntake.svelte'),
    acesso: () => import('./AccessAdmin.svelte'),
    auditoria: () => import('./AuditLog.svelte'),
    entrega: () => import('./DeliveryControl.svelte'),
  };
  // Role reading of the Mission Control. Awaited with the first data load so the page
  // does not shift when it appears; separate chunk to keep the initial bundle small.
  const loadOverview = () => import('./Overview.svelte');
  let Queue = $state.raw<Component<any> | null>(null);
  let Reading = $state.raw<Component<any> | null>(null);
  let readingFailed = $state(false);
  async function ensureReading() {
    if (Reading) return;
    try {
      Reading = (await loadOverview()).default as Component<any>;
      readingFailed = false;
    } catch {
      readingFailed = true;
    }
  }
  let overview = $state<OverviewData | null>(null);
  let overviewError = $state('');
  type LazyId = keyof typeof loaders;
  const lazyIds = Object.keys(loaders) as LazyId[];
  /** Props per module screen; identical to the former single-page wiring. */
  function moduleProps(id: LazyId, s: SessionView): Record<string, unknown> {
    const role = s.role;
    switch (id) {
      case 'comercial':
        return {
          api,
          data,
          role,
          userId: s.user.id,
          members,
          onChanged: refresh,
          query: route.query,
        };
      case 'economia':
        return {
          api,
          data,
          members,
          role,
          userId: s.user.id,
          query: route.query,
          onChanged: refresh,
        };
      case 'atendimento-inteligente':
        return {
          api,
          interactions: data.interactions,
          projects: data.projects,
          members,
          role,
          onCreated: refresh,
        };
      case 'acesso':
        return {
          members,
          currentUserId: s.user.id,
          busy,
          onProvision: (body: unknown) =>
            execute(async () => {
              await api('memberships', 'POST', body);
              await refresh();
              notice = 'Acesso atualizado.';
            }),
          onRevoke: (memberId: string) =>
            execute(async () => {
              await api(`memberships/${memberId}/revoke`, 'POST', {});
              await refresh();
              notice = 'Acesso revogado.';
            }),
        };
      case 'auditoria':
        return { api, members };
      case 'entrega':
        return { api, data, role };
    }
  }
  const chunks = new Map<LazyId, Promise<unknown>>();
  function load(id: LazyId) {
    let chunk = chunks.get(id);
    if (!chunk) {
      chunk = loaders[id]().catch((e: unknown) => {
        chunks.delete(id);
        throw e;
      });
      chunks.set(id, chunk);
    }
    return chunk as Promise<{ default: unknown }>;
  }
  function prefetch(id: RouteId) {
    if (id in loaders) load(id as LazyId).catch(() => {});
  }
  let session = $state<SessionView | null>(null);
  let members = $state<Member[]>([]);
  let configured = $state(false);
  let loaded = $state(false);
  let connected = $state(false);
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let data = $state<Snapshot>({
    clients: [],
    projects: [],
    interactions: [],
    requests: [],
  });
  let clientName = $state('');
  let projectName = $state('');
  let clientId = $state('');
  let projectId = $state('');
  let kind = $state('meeting');
  let summary = $state('');
  let occurred = $state('');
  let filter = $state('');
  let ownerFilter = $state('');
  let editing = $state<WorkRequest | null>(null);
  let editStatus = $state<Status>('new');
  let editOwner = $state('');
  let editAction = $state('');
  let editFollowUp = $state('');
  let changes = $state(0);
  let editInQueue = $state(false);
  let editReason = $state('');
  let editWaiting = $state('client');
  const labels = statusLabels;
  const kindLabels: Record<string, string> = {
    meeting: 'Reunião',
    service: 'Atendimento',
    conversation: 'Conversa',
    observation: 'Observação',
  };
  let visible = $derived(
    data.requests.filter(
      (r) =>
        (!filter || r.status === filter) &&
        (!ownerFilter ||
          (ownerFilter === 'me'
            ? r.owner_user_id === session?.user.id
            : ownerFilter === 'unassigned'
              ? !r.owner_user_id
              : r.owner_user_id === ownerFilter)),
    ),
  );
  let mine = $derived(
    data.requests.filter(
      (r) => r.owner_user_id === session?.user.id && r.status !== 'done',
    ).length,
  );
  let open = $derived(data.requests.filter((r) => r.status !== 'done').length);
  const urgency: Record<Status, number> = {
    blocked: 0,
    in_progress: 1,
    ready: 2,
    triage: 3,
    new: 4,
    done: 5,
  };
  let priorities = $derived(
    data.requests
      .filter(
        (r) => r.owner_user_id === session?.user.id && r.status !== 'done',
      )
      .sort((a, b) => urgency[a.status] - urgency[b.status]),
  );
  // Navigation is role-aware but never a security boundary: the API authorizes every call.
  let route = $state<Location>(parse(location.hash));
  let visited = $state<Partial<Record<RouteId, boolean>>>({});
  let heading = $state<HTMLHeadingElement>();
  const scrollTops = new Map<RouteId, number>();
  let nav = $derived(
    session ? routes.filter((r) => allowed(r.id, session!.role)) : [],
  );
  let permitted = $derived(
    !!session && !!route.id && allowed(route.id, session.role),
  );
  let page = $derived(
    !route.id
      ? {
          eyebrow: 'NAVEGAÇÃO',
          title: 'Página não encontrada',
          description: 'O endereço não corresponde a nenhum módulo.',
        }
      : session && !permitted
        ? {
            eyebrow: 'NAVEGAÇÃO',
            title: 'Acesso restrito',
            description: 'Este módulo não está disponível para o seu papel.',
          }
        : routeById[route.id],
  );
  function show(id: RouteId) {
    return route.id === id && permitted;
  }
  /** Applies the current hash: canonical URL, filters from the query, module mount. */
  function applyRoute(next: Location) {
    if (next.canonical) history.replaceState(history.state, '', next.canonical);
    route = next;
    if (next.id === 'solicitacoes' && [...next.query.keys()].length) {
      const estado = next.query.get('estado') ?? '';
      filter = (statuses as readonly string[]).includes(estado) ? estado : '';
      ownerFilter = next.query.get('responsavel') ?? '';
    }
    if (next.id && session && allowed(next.id, session.role))
      visited[next.id] = true;
    if (next.id === 'mission-control' && session) void ensureReading();
    if (next.id === 'solicitacoes' && session && !Queue)
      void import('./DemandQueue.svelte').then(
        (m) => (Queue = m.default as Component<any>),
      );
  }
  async function navigated() {
    if (route.id) scrollTops.set(route.id, window.scrollY);
    applyRoute(parse(location.hash));
    error = notice = '';
    // Decisions taken in other modules must show here without a manual refresh.
    if (route.id === 'mission-control' && session) void refreshOverview();
    if (route.id === 'solicitacoes' && session) void refresh();
    await tick();
    window.scrollTo({
      top: (route.id && scrollTops.get(route.id)) || 0,
      behavior: 'instant',
    });
    heading?.focus({ preventScroll: true });
  }
  // Filters live in the URL so a filtered list can be shared, reloaded or revisited.
  $effect(() => {
    const target = href('solicitacoes', {
      estado: filter,
      responsavel: ownerFilter,
    });
    if (route.id === 'solicitacoes' && connected)
      untrack(() => {
        if (location.hash !== target)
          history.replaceState(history.state, '', target);
      });
  });
  $effect(() => {
    document.title = `Catus OS · ${connected ? page.title : 'Mission Control'}`;
  });
  const when = timeLabel;
  function focusFirst(node: HTMLElement) {
    node.scrollIntoView({ block: 'nearest' });
    node.querySelector<HTMLElement>('select,textarea,input')?.focus();
  }
  onMount(() => {
    const now = new Date();
    const local = new Date(
      now.getTime() - now.getTimezoneOffset() * 60000,
    ).toISOString();
    occurred = `${dayText(local)} ${local.slice(11, 16)}`;
    applyRoute(route);
    void execute(initialize);
    addEventListener('hashchange', navigated);
    return () => removeEventListener('hashchange', navigated);
  });
  const creationAttempts = new Map<string, { payload: string; key: string }>();
  async function api<T>(
    path: string,
    method = 'GET',
    body: unknown = undefined,
    key?: string,
  ): Promise<T> {
    const payload = JSON.stringify(body);
    const creation =
      method === 'POST' &&
      ['clients', 'projects', 'interactions', 'requests'].includes(path);
    let attempt = creationAttempts.get(path);
    if (creation && attempt?.payload !== payload) {
      attempt = { payload, key: crypto.randomUUID() };
      creationAttempts.set(path, attempt);
    }
    const res = await fetch(`/api/${path}`, {
      method,
      headers: {
        ...(creation ? { 'Idempotency-Key': attempt!.key } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(session ? { 'X-CSRF-Token': session.csrfToken } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let result: { error?: string } = {};
    try {
      result = await res.json();
    } catch {
      // Proxies or outages may return non-JSON; never surface a parser error to users.
      if (res.ok) throw new Error('Resposta inválida do servidor');
    }
    if (res.status === 401) {
      disconnect();
    }
    if (!res.ok)
      throw Object.assign(
        new Error(
          result.error ??
            (res.status >= 500
              ? 'Serviço indisponível; tente novamente em instantes'
              : 'Falha na requisição'),
        ),
        { status: res.status },
      );
    if (creation) creationAttempts.delete(path);
    return result as T;
  }
  async function refreshOverview() {
    try {
      overview = await api<OverviewData>('overview');
      overviewError = '';
    } catch (e) {
      // The operational screen stays usable; nothing is shown as if it were a value.
      overview = null;
      overviewError = e instanceof Error ? e.message : 'Falha inesperada';
    }
  }
  async function refresh() {
    data = await api<Snapshot>('mission-control');
    members = await api<Member[]>('members');
    await refreshOverview();
  }
  async function execute(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      await action();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Falha inesperada';
    } finally {
      busy = false;
    }
  }
  function disconnect() {
    creationAttempts.clear();
    clientName =
      projectName =
      clientId =
      projectId =
      summary =
      editOwner =
      editAction =
        '';
    connected = false;
    session = null;
    editing = null;
    ownerFilter = '';
    members = [];
    overview = null;
    overviewError = '';
    data = { clients: [], projects: [], interactions: [], requests: [] };
    // Unmount module screens so nothing from this session or organization lingers.
    visited = {};
  }
  async function initialize() {
    configured = (await api<{ configured: boolean }>('auth/config')).configured;
    if (!configured) {
      disconnect();
      loaded = true;
      return;
    }
    const res = await fetch('/api/session');
    if (res.status === 401) {
      disconnect();
      loaded = true;
      return;
    }
    if (!res.ok) throw new Error('Não foi possível verificar a sessão');
    session = (await res.json()) as SessionView;
    await Promise.all([
      refresh(),
      parse(location.hash).id === 'mission-control'
        ? ensureReading()
        : undefined,
    ]);
    const back = takeReturn();
    if (back && !location.hash.replace(/^#\/?/, ''))
      history.replaceState(history.state, '', back);
    applyRoute(parse(location.hash));
    connected = true;
    loaded = true;
  }
  async function logout(all = false) {
    await execute(async () => {
      await api(all ? 'session/revoke-all' : 'session/logout', 'POST', {});
      disconnect();
    });
  }
  async function switchOrganization(id: string) {
    await execute(async () => {
      await api('session/organization', 'POST', { organization_id: id });
      disconnect();
      await initialize();
    });
  }
  // Each saved record preselects itself in the next form, so nobody retypes the chain.
  async function create(
    path: string,
    body: unknown,
    clear: (id: string) => void,
    next: string,
  ) {
    await execute(async () => {
      const saved = await api<{ id: string }>(path, 'POST', body);
      clear(saved.id);
      await refresh();
      notice = `Registro salvo. ${next}`;
    });
  }
  async function openEdit(id: string, to?: Status) {
    // The queue is read fresher than this snapshot: edit what is current now.
    await execute(refresh);
    const r = data.requests.find((x) => x.id === id);
    if (!r) return;
    edit(r);
    editInQueue = true;
    if (to) editStatus = to;
  }
  function edit(r: WorkRequest) {
    editInQueue = false;
    editing = r;
    editStatus = r.status;
    editOwner = r.owner_user_id ?? '';
    editAction = r.next_action;
    editFollowUp = dayText(r.follow_up_on);
    editReason = r.blocked_reason ?? '';
    editWaiting = r.waiting_on ?? 'client';
  }
  async function save() {
    if (!editing) return;
    const r = editing;
    const followUp = editFollowUp && dayFromText(editFollowUp);
    if (followUp === null) {
      error = 'Informe o compromisso em DD/MM/AAAA.';
      return;
    }
    await execute(async () => {
      try {
        await api(`requests/${r.id}`, 'PATCH', {
          status: editStatus,
          owner_user_id: editOwner,
          next_action: editAction,
          ...(editStatus === 'blocked'
            ? { blocked_reason: editReason, waiting_on: editWaiting }
            : {}),
          // Untouched, the server keeps it or renews one that lapsed when the stage moves.
          ...(followUp && followUp !== r.follow_up_on
            ? { follow_up_on: followUp }
            : {}),
          version: r.version,
        });
      } catch (e) {
        if ((e as { status?: number }).status === 409) {
          // Optimistic lock lost: show the current record instead of resubmitting stale input.
          await refresh();
          const current = data.requests.find((x) => x.id === r.id);
          if (current) edit(current);
          else editing = null;
          throw new Error(
            'Outra pessoa alterou esta solicitação. Os dados atuais foram carregados; revise e salve novamente.',
          );
        }
        throw e;
      }
      editing = null;
      await refresh();
      changes++;
      notice = 'Solicitação atualizada.';
    });
  }
</script>

{#snippet editForm()}{#if editing}<section
      class="edit"
      aria-label="Editar solicitação"
      use:focusFirst
    >
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label
          >Estado<select bind:value={editStatus}
            ><option value={editing.status}>{labels[editing.status]}</option
            >{#each [...transitions[editing.status], ...(editing.status === 'new' && editing.template === 'manutencao' ? (['ready'] as const) : [])].filter((s) => session?.role !== 'developer' || ['in_progress', 'blocked', 'done'].includes(s)) as s}<option
                value={s}>{labels[s]}</option
              >{/each}</select
          ></label
        ><label
          >Responsável<select
            bind:value={editOwner}
            required
            disabled={session?.role === 'developer'}
            ><option value="">Vincule um membro</option
            >{#each members as m}<option value={m.id}
                >{m.name} · {m.email}</option
              >{/each}</select
          ></label
        ><label
          >Próxima ação<textarea
            bind:value={editAction}
            required
            maxlength="2000"
          ></textarea></label
        ><label
          >Compromisso (DD/MM/AAAA)<input
            bind:value={editFollowUp}
            inputmode="numeric"
            autocomplete="off"
          /></label
        >{#if editStatus === 'blocked'}<label
            >Motivo do bloqueio<input
              bind:value={editReason}
              required
              maxlength="2000"
            /></label
          ><label
            >Depende de<select bind:value={editWaiting}
              ><option value="client">Cliente</option><option value="internal"
                >Equipe interna</option
              ><option value="third_party">Terceiro</option></select
            ></label
          >{/if}<button disabled={busy}>Salvar atualização</button><button
          type="button"
          class="secondary"
          onclick={() => (editing = null)}>Cancelar</button
        >
      </form>
    </section>{/if}{/snippet}
{#snippet chunkFailed()}<div class="panel route-message" role="alert">
    <h2>Não foi possível carregar este módulo</h2>
    <p class="muted">A conexão falhou ou o Catus OS foi atualizado.</p>
    <button type="button" onclick={() => location.reload()}
      >Recarregar página</button
    >
  </div>{/snippet}
<svelte:head
  ><meta
    name="description"
    content="Operação da agência: clientes, projetos, atendimentos e solicitações."
  /></svelte:head
>
<div class="shell">
  <aside>
    <a class="brand" href="#/">CATUS<span>OS</span></a>
    <p class="eyebrow">WORKSPACE DA AGÊNCIA</p>
    <nav aria-label="Módulos">
      {#if connected && nav.length}
        {#each nav as r (r.id)}<a
            class="nav"
            href={href(r.id)}
            aria-current={route.id === r.id ? 'page' : undefined}
            onpointerenter={() => prefetch(r.id)}
            onfocus={() => prefetch(r.id)}>{r.label}</a
          >{/each}
      {:else}<span class="nav active">Mission Control</span>{/if}
    </nav>
    <p class="aside-note">Operação conectada.<br />Decisões rastreáveis.</p>
    <div class="local">● Ambiente local</div>
  </aside>
  <main>
    <header>
      <div>
        {#if connected}
          <p class="eyebrow">{page.eyebrow}</p>
          <h1 tabindex="-1" bind:this={heading}>{page.title}</h1>
          <p class="muted">{page.description}</p>
        {:else}
          <p class="eyebrow">OPERAÇÃO / VISÃO GERAL</p>
          <h1>Mission Control</h1>
          <p class="muted">
            Da conversa à próxima ação, com contexto e responsabilidade.
          </p>
        {/if}
      </div>
      <span class="badge">IA assistida · revisão humana obrigatória</span>
    </header>
    {#if !connected}
      <section class="panel access">
        <h2>Entre no Catus OS</h2>
        {#if !loaded}<p>Verificando sessão…</p>{:else if configured}
          <p>
            Use sua conta corporativa previamente autorizada. O acesso depende
            dos vínculos da sua organização.
          </p>
          <a
            class="login-button"
            href="/api/auth/login"
            onclick={() => rememberReturn(location.hash)}
            >Entrar com conta corporativa</a
          >
        {:else}<p role="status">
            OIDC não configurado. O acesso está bloqueado; configure o provedor
            no ambiente.
          </p>{/if}
      </section>
    {:else if session}
      <div class="toolbar">
        <span class="muted"
          >{session.user.name} · {session.user.email} · {roleLabels[
            session.role
          ] ?? session.role}<br />{session.organization.name}</span
        >
        {#if session.organizations.length > 1}<label
            >Organização<select
              value={session.organization.id}
              onchange={(e) => switchOrganization(e.currentTarget.value)}
              >{#each session.organizations as o}<option value={o.id}
                  >{o.name}</option
                >{/each}</select
            ></label
          >{/if}
        <button
          class="secondary"
          disabled={busy}
          onclick={() => execute(refresh)}>Atualizar dados</button
        >
        <button class="secondary" disabled={busy} onclick={() => logout()}
          >Sair</button
        >
        <button class="secondary" disabled={busy} onclick={() => logout(true)}
          >Encerrar todas as sessões</button
        >
      </div>
      <nav class="mobile-nav" aria-label="Módulos (compacto)">
        {#each nav as r (r.id)}<a
            href={href(r.id)}
            aria-current={route.id === r.id ? 'page' : undefined}>{r.label}</a
          >{/each}
      </nav>
      {#if !route.id || !permitted}
        <section class="panel route-message" aria-label={page.title}>
          <h2>
            {route.id
              ? 'Você não tem acesso a este módulo'
              : 'Não encontramos este endereço'}
          </h2>
          <p class="muted">
            {route.id
              ? 'O menu mostra apenas os módulos do seu papel, e o servidor recusa operações fora dele. Peça acesso a um administrador, se necessário.'
              : 'Ele pode ter sido digitado incorretamente ou ser de uma versão anterior.'}
          </p>
          <a class="button-link" href={href('mission-control')}
            >Ir para o Mission Control</a
          >
        </section>
      {/if}
      {#if show('mission-control')}
        <!-- Ready before the first paint (see initialize), so nothing shifts when it appears. -->
        {#if Reading}<Reading
            {overview}
            error={overviewError}
            requests={data.requests}
            userId={session.user.id}
          />{:else if readingFailed}{@render chunkFailed()}{/if}
        {#if overview?.followup?.for_me}<p class="attention">
            <strong>{overview.followup.for_me}</strong>
            na sua <a href={href('solicitacoes')}>fila de ações</a>
          </p>{/if}
        <section class="stats" aria-label="Resumo operacional">
          <div><span>Clientes</span><strong>{data.clients.length}</strong></div>
          <div>
            <span>Projetos</span><strong>{data.projects.length}</strong>
          </div>
          <div>
            <span>Solicitações</span><strong>{data.requests.length}</strong>
          </div>
          <div><span>Em aberto</span><strong>{open}</strong></div>
          <div>
            <span>Atribuídas a mim (abertas)</span><strong>{mine}</strong>
          </div>
          <div>
            <span>Bloqueadas</span><strong
              >{data.requests.filter((r) => r.status === 'blocked')
                .length}</strong
            >
          </div>
        </section>
        <div class="overview">
          <section class="panel" aria-labelledby="mc-mine">
            <div class="section-heading">
              <div>
                <p class="eyebrow">PRIORIDADES</p>
                <h2 id="mc-mine">Minhas prioridades</h2>
              </div>
              {#if priorities.length}<a
                  class="text-link"
                  href={href('solicitacoes', { responsavel: 'me' })}
                  >Abrir minhas solicitações</a
                >{/if}
            </div>
            {#if priorities.length}<ol class="work-list">
                {#each priorities.slice(0, 5) as r (r.id)}<li>
                    <span class="status" data-status={r.status}
                      >{labels[r.status]}</span
                    >
                    <div>
                      <strong>{r.title}</strong>
                      <p class="muted">{r.client_name} / {r.project_name}</p>
                      <p>
                        <span class="muted">Próxima ação:</span>
                        {r.next_action}
                      </p>
                      <a
                        class="text-link"
                        href={href('economia', {
                          painel: 'apontar',
                          projeto: r.project_id ?? '',
                          demanda: r.id,
                        })}>Apontar horas nesta demanda</a
                      >
                    </div>
                  </li>{/each}
              </ol>
              {#if priorities.length > 5}<p class="muted">
                  E mais {priorities.length - 5} em aberto.
                </p>{/if}
            {:else}<div class="empty compact">
                <h3>Nada atribuído a você</h3>
                <a class="button-link secondary" href={href('solicitacoes')}
                  >Ver solicitações</a
                >
              </div>{/if}
          </section>
        </div>
      {/if}
      {#if show('solicitacoes')}
        {#if Queue}<Queue
            {api}
            {session}
            {members}
            {changes}
            interactions={data.interactions}
            projects={data.projects}
            editingId={editInQueue ? editing?.id : undefined}
            form={editForm}
            onedit={openEdit}
            onsaved={async () => {
              await refresh();
              changes++;
            }}
          />{/if}
        <section class="panel" id="solicitacoes" aria-label="Solicitações">
          <div class="section-heading">
            <div>
              <p class="eyebrow">ACOMPANHAMENTO</p>
              <h2>Fila de solicitações</h2>
            </div>
            <div class="filters">
              <label
                >Filtrar responsável<select bind:value={ownerFilter}
                  ><option value="">Todos os responsáveis</option><option
                    value="me">Atribuídas a mim</option
                  ><option value="unassigned">Sem vínculo de responsável</option
                  >{#each members as m}<option value={m.id}>{m.name}</option
                    >{/each}</select
                ></label
              ><label
                >Filtrar estado<select bind:value={filter}
                  ><option value="">Todos os estados</option
                  >{#each statuses as s}<option value={s}>{labels[s]}</option
                    >{/each}</select
                ></label
              >
            </div>
          </div>
          {#if !visible.length}<div class="empty">
              <h3>Nenhuma solicitação neste recorte</h3>
              <p>Ajuste os filtros ou registre uma demanda acima.</p>
            </div>{:else}<div class="cards">
              {#each visible as r (r.id)}<article
                  class="request"
                  class:editing={editing?.id === r.id}
                >
                  <div class="card-top">
                    <span class="status" data-status={r.status}
                      >{labels[r.status]}</span
                    ><span class="muted">v{r.version}</span>
                  </div>
                  <p class="eyebrow">{r.client_name} / {r.project_name}</p>
                  <h3>{r.title}</h3>
                  <p
                    class="commercial-coverage"
                    data-coverage={r.commercial_coverage}
                  >
                    {r.commercial_coverage === 'covered'
                      ? 'Cobertura comercial aprovada'
                      : 'Pendente de análise comercial'}{#if r.scope_item_id}
                      · Escopo V{r.scope_number} · {r.contract_title}{/if}
                  </p>
                  <p class="description">{r.description}</p>
                  {#if r.origin_proposal_id}<p class="muted">
                      Origem IA revisada por humano · proposta {r.origin_proposal_id}
                    </p>{/if}
                  {#if r.suggested_acceptance_criteria?.length}<details>
                      <summary>Critérios revisados</summary>
                      <ul>
                        {#each r.suggested_acceptance_criteria as c}<li>
                            {c.text}
                          </li>{/each}
                      </ul>
                    </details>{/if}
                  <dl>
                    <dt>Responsável</dt>
                    <dd>
                      {r.owner}{#if r.owner_user_id === session.user.id}<span
                          class="mine-tag">· você</span
                        >{/if}
                    </dd>
                    {#if r.status !== 'done'}<dt>Próxima ação</dt>
                      <dd>{r.next_action}</dd>{/if}
                    <dt>Atendimento de origem</dt>
                    <dd>
                      {data.interactions.find((i) => i.id === r.interaction_id)
                        ?.summary ?? r.interaction_id}
                    </dd>
                  </dl>
                  {#if editing?.id === r.id && !editInQueue}{@render editForm()}{:else}<button
                      class="secondary"
                      disabled={busy ||
                        (session.role === 'developer' &&
                          r.owner_user_id !== session.user.id)}
                      title={session.role === 'developer' &&
                      r.owner_user_id !== session.user.id
                        ? 'Somente o responsável atribuído pode atualizar'
                        : undefined}
                      onclick={() => edit(r)}>Atualizar solicitação</button
                    >{/if}
                </article>{/each}
            </div>{/if}
        </section>
      {/if}
      {#if show('clientes')}
        {#if session.role !== 'developer'}
          <section class="panel" id="registro" aria-label="Registrar contexto">
            <div class="section-heading">
              <div>
                <p class="eyebrow">ENTRADA MANUAL</p>
                <h2>Registrar contexto</h2>
              </div>
            </div>
            <p class="next-step" role="note">
              <strong>Próximo passo:</strong>
              {#if !data.clients.length}cadastre o cliente em 01.{:else if !data.projects.length}crie
                o projeto em 02.{:else}registre o atendimento em 03 e a demanda
                em Solicitações.{/if}
            </p>
            <div class="forms">
              <form
                onsubmit={(e) => {
                  e.preventDefault();
                  void create(
                    'clients',
                    { name: clientName },
                    (id) => {
                      clientName = '';
                      clientId = id;
                    },
                    'Próximo passo: 02 · Projeto.',
                  );
                }}
              >
                <h3>01 · Cliente</h3>
                <label
                  >Nome do cliente<input
                    bind:value={clientName}
                    required
                    maxlength="200"
                  /></label
                ><button disabled={busy}>Cadastrar cliente</button>
              </form>
              <form
                onsubmit={(e) => {
                  e.preventDefault();
                  void create(
                    'projects',
                    { client_id: clientId, name: projectName },
                    (id) => {
                      projectName = '';
                      projectId = id;
                    },
                    'Próximo passo: 03 · Atendimento.',
                  );
                }}
              >
                <h3>02 · Projeto</h3>
                <label
                  >Cliente<select bind:value={clientId} required
                    ><option value="">Selecione</option
                    >{#each data.clients as c}<option value={c.id}
                        >{c.name}</option
                      >{/each}</select
                  ></label
                ><label
                  >Nome do projeto<input
                    bind:value={projectName}
                    required
                    maxlength="200"
                  /></label
                ><button disabled={busy || !data.clients.length}
                  >Criar projeto</button
                >
              </form>
              <form
                onsubmit={(e) => {
                  e.preventDefault();
                  const occurredAt = instantFromText(occurred);
                  if (!occurredAt) {
                    error =
                      'Informe uma data e hora válidas em DD/MM/AAAA HH:MM.';
                    return;
                  }
                  void create(
                    'interactions',
                    {
                      project_id: projectId,
                      kind,
                      summary,
                      occurred_at: occurredAt,
                    },
                    () => {
                      summary = '';
                    },
                    'Próximo passo: registre a demanda em Solicitações.',
                  );
                }}
              >
                <h3>03 · Atendimento</h3>
                <label
                  >Projeto<select bind:value={projectId} required
                    ><option value="">Selecione</option
                    >{#each data.projects as p}<option value={p.id}
                        >{data.clients.find((c) => c.id === p.client_id)?.name} /
                        {p.name}</option
                      >{/each}</select
                  ></label
                ><label
                  >Tipo<select bind:value={kind}
                    ><option value="meeting">Reunião</option><option
                      value="service">Atendimento</option
                    ></select
                  ></label
                ><label
                  >Data e hora local (DD/MM/AAAA HH:MM)<input
                    bind:value={occurred}
                    required
                    inputmode="numeric"
                    autocomplete="off"
                  /></label
                ><label
                  >Resumo e contexto<textarea
                    bind:value={summary}
                    required
                    maxlength="10000"
                  ></textarea></label
                ><button disabled={busy || !data.projects.length}
                  >Registrar atendimento</button
                >
              </form>
            </div>
          </section>
        {/if}
        <section class="panel" id="clientes" aria-label="Clientes e projetos">
          <div class="section-heading">
            <div>
              <p class="eyebrow">CONSULTA</p>
              <h2>Clientes, projetos e atendimentos</h2>
            </div>
          </div>
          <p class="muted">
            Atendimentos e reuniões mais recentes (até 500) por projeto, com a
            quantidade de solicitações abertas.
          </p>
          {#if !data.clients.length}<div class="empty">
              <h3>Nenhum cliente cadastrado</h3>
              <p>
                {session.role === 'developer'
                  ? 'O PO ou gestor cadastra clientes e projetos.'
                  : 'Use “Registrar contexto” para cadastrar o primeiro cliente.'}
              </p>
            </div>{:else}<ul class="directory">
              {#each data.clients as c (c.id)}<li>
                  <strong>{c.name}</strong>
                  {#if !data.projects.some((p) => p.client_id === c.id)}<p
                      class="muted"
                    >
                      Sem projetos.
                    </p>{/if}
                  <ul>
                    {#each data.projects.filter((p) => p.client_id === c.id) as p (p.id)}
                      {@const meetings = data.interactions
                        .filter((i) => i.project_id === p.id)
                        .sort(
                          (a, b) =>
                            Date.parse(b.occurred_at) -
                            Date.parse(a.occurred_at),
                        )}
                      {@const active = data.requests.filter(
                        (r) => r.project_id === p.id && r.status !== 'done',
                      ).length}
                      <li>
                        <details>
                          <summary
                            >{p.name}
                            <span class="muted"
                              >· {meetings.length} atendimento(s) · {active} solicitação(ões)
                              aberta(s)</span
                            ></summary
                          >
                          {#if meetings.length}<ol class="timeline">
                              {#each meetings as i (i.id)}<li>
                                  <span class="muted"
                                    >{when(i.occurred_at)} · {kindLabels[
                                      i.kind
                                    ] ?? i.kind}</span
                                  >
                                  <p>{i.summary}</p>
                                </li>{/each}
                            </ol>{:else}<p class="muted">
                              Nenhum atendimento registrado.
                            </p>{/if}
                        </details>
                      </li>
                    {/each}
                  </ul>
                </li>{/each}
            </ul>{/if}
        </section>
      {/if}
      {#each lazyIds as id (id)}{#if visited[id]}<div
            class="route-view"
            hidden={!show(id)}
          >
            {#await load(id)}<p class="loading" role="status">
                Carregando módulo…
              </p>{:then mod}{@const Screen =
                mod.default as Component<any>}<Screen
                {...moduleProps(id, session)}
              />{:catch}{@render chunkFailed()}{/await}
          </div>{/if}{/each}
    {/if}
    {#if error}<p class="feedback error" role="alert">
        {error}
      </p>{/if}{#if notice}<p class="feedback" role="status">{notice}</p>{/if}
  </main>
</div>
