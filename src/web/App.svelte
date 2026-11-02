<script lang="ts">
  import { onMount } from 'svelte';
  import { statuses, transitions } from '../shared/domain';
  import type { Snapshot, Status, WorkRequest } from '../shared/domain';
  import './style.css';
  import DeliveryControl from './DeliveryControl.svelte';
  import EconomicsControl from './EconomicsControl.svelte';
  import CommercialControl from './CommercialControl.svelte';
  import IntelligentIntake from './IntelligentIntake.svelte';
  import AccessAdmin from './AccessAdmin.svelte';
  import AuditLog from './AuditLog.svelte';
  import type { SessionView, Member, Role } from '../shared/identity';
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
  let interactionId = $state('');
  let title = $state('');
  let description = $state('');
  let owner = $state('');
  let nextAction = $state('');
  let filter = $state('');
  let ownerFilter = $state('');
  let editing = $state<WorkRequest | null>(null);
  let editStatus = $state<Status>('new');
  let editOwner = $state('');
  let editAction = $state('');
  const labels: Record<Status, string> = {
    new: 'Nova',
    triage: 'Em triagem',
    ready: 'Pronta',
    in_progress: 'Em execução',
    blocked: 'Bloqueada',
    done: 'Concluída',
  };
  const roleLabels: Record<Role, string> = {
    administrator: 'Administrador',
    manager: 'Gestor',
    po: 'PO',
    developer: 'Desenvolvedor',
  };
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
  // Navigation is role-aware but never a security boundary: the API authorizes every call.
  let sections = $derived(
    session
      ? [
          { id: 'solicitacoes', label: 'Solicitações' },
          ...(session.role !== 'developer'
            ? [{ id: 'registro', label: 'Registrar atendimento' }]
            : []),
          { id: 'clientes', label: 'Clientes e projetos' },
          { id: 'comercial', label: 'Contratos e escopos' },
          { id: 'economia', label: 'Horas e economia' },
          ...(session.role !== 'developer'
            ? [{ id: 'ia', label: 'Atendimento inteligente' }]
            : []),
          ...(session.role === 'administrator'
            ? [{ id: 'acesso', label: 'Acesso' }]
            : []),
          ...(['administrator', 'manager'].includes(session.role)
            ? [{ id: 'auditoria', label: 'Auditoria' }]
            : []),
          { id: 'entrega', label: 'Entrega agêntica (experimental)' },
        ]
      : [],
  );
  function when(iso: string) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }
  function focusFirst(node: HTMLElement) {
    node.scrollIntoView({ block: 'nearest' });
    node.querySelector<HTMLElement>('select,textarea,input')?.focus();
  }
  onMount(() => {
    const now = new Date();
    occurred = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    void execute(initialize);
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
  async function refresh() {
    data = await api<Snapshot>('mission-control');
    members = await api<Member[]>('members');
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
      interactionId =
      title =
      description =
      owner =
      nextAction =
      editOwner =
      editAction =
        '';
    connected = false;
    session = null;
    editing = null;
    ownerFilter = '';
    members = [];
    data = { clients: [], projects: [], interactions: [], requests: [] };
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
    await refresh();
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
  async function create(path: string, body: unknown, clear: () => void) {
    await execute(async () => {
      await api(path, 'POST', body);
      clear();
      await refresh();
      notice = 'Registro salvo.';
    });
  }
  function edit(r: WorkRequest) {
    editing = r;
    editStatus = r.status;
    editOwner = r.owner_user_id ?? '';
    editAction = r.next_action;
  }
  async function save() {
    if (!editing) return;
    const r = editing;
    await execute(async () => {
      try {
        await api(`requests/${r.id}`, 'PATCH', {
          status: editStatus,
          owner_user_id: editOwner,
          next_action: editAction,
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
      notice = 'Solicitação atualizada.';
    });
  }
</script>

<svelte:head
  ><meta
    name="description"
    content="Operação da agência: clientes, projetos, atendimentos e solicitações."
  /></svelte:head
>
<div class="shell">
  <aside>
    <a class="brand" href="/">CATUS<span>OS</span></a>
    <p class="eyebrow">WORKSPACE DA AGÊNCIA</p>
    <nav aria-label="Módulos">
      {#if connected && sections.length}
        {#each sections as s}<a class="nav" href={'#' + s.id}>{s.label}</a
          >{/each}
      {:else}<span class="nav active">Mission Control</span>{/if}
    </nav>
    <p class="aside-note">Operação conectada.<br />Decisões rastreáveis.</p>
    <div class="local">● Ambiente local</div>
  </aside>
  <main>
    <header>
      <div>
        <p class="eyebrow">OPERAÇÃO / VISÃO GERAL</p>
        <h1>Mission Control</h1>
        <p class="muted">
          Da conversa à próxima ação, com contexto e responsabilidade.
        </p>
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
          <a class="login-button" href="/api/auth/login"
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
        {#each sections as s}<a href={'#' + s.id}>{s.label}</a>{/each}
      </nav>
      <section class="stats" aria-label="Resumo operacional">
        <div><span>Clientes</span><strong>{data.clients.length}</strong></div>
        <div><span>Projetos</span><strong>{data.projects.length}</strong></div>
        <div>
          <span>Solicitações carregadas</span><strong
            >{data.requests.length}</strong
          >
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
      <section class="panel" id="solicitacoes" aria-label="Solicitações">
        <div class="section-heading">
          <div>
            <p class="eyebrow">ACOMPANHAMENTO</p>
            <h2>Solicitações</h2>
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
        <p class="muted">
          Até 500 solicitações mais recentes. Novas solicitações entram em
          “Nova”; estados seguintes exigem triagem. Cada cartão mostra o
          responsável e a próxima ação.
        </p>
        {#if !visible.length}<div class="empty">
            <h3>Nenhuma solicitação neste recorte</h3>
            <p>
              {#if data.requests.length}Ajuste os filtros para ver as demais
                solicitações.{:else if session.role === 'developer'}Nenhum
                trabalho registrado ainda; o PO atribuirá solicitações a você.{:else}Registre
                um atendimento e sua primeira solicitação para começar.{/if}
            </p>
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
                      >{/if}{#if !r.owner_user_id}<span class="muted">
                        · legado, vinculação pendente</span
                      >{/if}
                  </dd>
                  <dt>Próxima ação</dt>
                  <dd>{r.next_action}</dd>
                  <dt>Atendimento de origem</dt>
                  <dd>
                    {data.interactions.find((i) => i.id === r.interaction_id)
                      ?.summary ?? r.interaction_id}
                  </dd>
                </dl>
                {#if editing?.id === r.id}<section
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
                          ><option value={editing.status}
                            >{labels[editing.status]}</option
                          >{#each transitions[editing.status].filter((s) => session?.role !== 'developer' || ['in_progress', 'blocked', 'done'].includes(s)) as s}<option
                              value={s}>{labels[s]}</option
                            >{/each}</select
                        ></label
                      ><label
                        >Responsável<select
                          bind:value={editOwner}
                          required
                          disabled={session.role === 'developer'}
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
                      ><button disabled={busy}>Salvar atualização</button
                      ><button
                        type="button"
                        class="secondary"
                        onclick={() => (editing = null)}>Cancelar</button
                      >
                    </form>
                  </section>{:else}<button
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
      {#if session.role !== 'developer'}
        <section class="panel" id="registro" aria-label="Registrar contexto">
          <div class="section-heading">
            <div>
              <p class="eyebrow">ENTRADA MANUAL</p>
              <h2>Registrar contexto</h2>
            </div>
            <span class="muted"
              >Cliente → Projeto → Atendimento → Solicitação</span
            >
          </div>
          <div class="forms">
            <form
              onsubmit={(e) => {
                e.preventDefault();
                void create(
                  'clients',
                  { name: clientName },
                  () => (clientName = ''),
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
                  () => (projectName = ''),
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
                void create(
                  'interactions',
                  {
                    project_id: projectId,
                    kind,
                    summary,
                    occurred_at: new Date(occurred).toISOString(),
                  },
                  () => (summary = ''),
                );
              }}
            >
              <h3>03 · Atendimento</h3>
              <label
                >Projeto<select bind:value={projectId} required
                  ><option value="">Selecione</option
                  >{#each data.projects as p}<option value={p.id}
                      >{data.clients.find((c) => c.id === p.client_id)?.name} / {p.name}</option
                    >{/each}</select
                ></label
              ><label
                >Tipo<select bind:value={kind}
                  ><option value="meeting">Reunião</option><option
                    value="service">Atendimento</option
                  ></select
                ></label
              ><label
                >Data e hora local<input
                  type="datetime-local"
                  bind:value={occurred}
                  required
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
            <form
              onsubmit={(e) => {
                e.preventDefault();
                void create(
                  'requests',
                  {
                    interaction_id: interactionId,
                    title,
                    description,
                    owner_user_id: owner,
                    next_action: nextAction,
                  },
                  () => {
                    title = '';
                    description = '';
                    owner = '';
                    nextAction = '';
                  },
                );
              }}
            >
              <h3>04 · Solicitação</h3>
              <label
                >Atendimento de origem<select
                  bind:value={interactionId}
                  required
                  ><option value="">Selecione</option
                  >{#each data.interactions as i}<option value={i.id}
                      >{data.projects.find((p) => p.id === i.project_id)?.name} ·
                      {i.summary.slice(0, 60)}</option
                    >{/each}</select
                ></label
              ><label
                >Título<input
                  bind:value={title}
                  required
                  maxlength="200"
                /></label
              ><label
                >Descrição<textarea
                  bind:value={description}
                  required
                  maxlength="10000"
                ></textarea></label
              ><label
                >Responsável<select bind:value={owner} required
                  ><option value="">Selecione um membro</option
                  >{#each members as m}<option value={m.id}
                      >{m.name} · {m.email}</option
                    >{/each}</select
                ></label
              ><label
                >Próxima ação<textarea
                  bind:value={nextAction}
                  required
                  maxlength="2000"
                ></textarea></label
              ><button disabled={busy || !data.interactions.length}
                >Criar solicitação</button
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
                          Date.parse(b.occurred_at) - Date.parse(a.occurred_at),
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
      <div id="comercial" class="anchor">
        <CommercialControl
          {api}
          {data}
          role={session.role}
          userId={session.user.id}
          {members}
          onChanged={refresh}
        />
      </div>
      <div id="economia" class="anchor">
        <EconomicsControl
          {api}
          {data}
          {members}
          role={session.role}
          userId={session.user.id}
        />
      </div>
      {#if session.role !== 'developer'}<div id="ia" class="anchor">
          <IntelligentIntake
            {api}
            interactions={data.interactions}
            projects={data.projects}
            {members}
            role={session.role}
            onCreated={refresh}
          />
        </div>{/if}
      {#if session.role === 'administrator'}<div id="acesso" class="anchor">
          <AccessAdmin
            {members}
            currentUserId={session.user.id}
            {busy}
            onProvision={(body) =>
              execute(async () => {
                await api('memberships', 'POST', body);
                await refresh();
                notice = 'Acesso atualizado.';
              })}
            onRevoke={(id) =>
              execute(async () => {
                await api(`memberships/${id}/revoke`, 'POST', {});
                await refresh();
                notice = 'Acesso revogado.';
              })}
          />
        </div>{/if}
      {#if ['administrator', 'manager'].includes(session.role)}<div
          id="auditoria"
          class="anchor"
        >
          <AuditLog {api} {members} />
        </div>{/if}
      <div id="entrega" class="anchor">
        <DeliveryControl {api} {data} role={session.role} />
      </div>
    {/if}
    {#if error}<p class="feedback error" role="alert">
        {error}
      </p>{/if}{#if notice}<p class="feedback" role="status">{notice}</p>{/if}
  </main>
</div>
