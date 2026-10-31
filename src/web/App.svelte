<script lang="ts">
  import { onMount } from 'svelte';
  import { statuses, transitions } from '../shared/domain';
  import type { Snapshot, Status, WorkRequest } from '../shared/domain';
  import './style.css';
  let token = $state('');
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
  let visible = $derived(
    data.requests.filter((r) => !filter || r.status === filter),
  );
  onMount(() => {
    const now = new Date();
    occurred = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  });
  async function api<T>(
    path: string,
    method = 'GET',
    body: unknown = undefined,
  ): Promise<T> {
    const res = await fetch(`/api/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error ?? 'Falha na requisição');
    return result as T;
  }
  async function refresh() {
    data = await api<Snapshot>('mission-control');
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
  async function connect() {
    await execute(async () => {
      await refresh();
      connected = true;
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
    editOwner = r.owner;
    editAction = r.next_action;
  }
  async function save() {
    if (!editing) return;
    const r = editing;
    await execute(async () => {
      await api(`requests/${r.id}`, 'PATCH', {
        status: editStatus,
        owner: editOwner,
        next_action: editAction,
        version: r.version,
      });
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
    <div class="nav active">◉ &nbsp; Mission Control</div>
    <p class="aside-note">Operação conectada.<br />Decisões rastreáveis.</p>
    <div class="local">● Ambiente local · M0</div>
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
      <span class="badge">Extração por IA: não implementada</span>
    </header>
    {#if !connected}
      <section class="panel access">
        <h2>Acesse seu ambiente local</h2>
        <p>
          Informe o DEV_TOKEN configurado no servidor. Ele permanece apenas na
          memória desta página.
        </p>
        <form
          onsubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <label
            >Token de desenvolvimento<input
              type="password"
              bind:value={token}
              required
              minlength="32"
              autocomplete="off"
            /></label
          ><button disabled={busy}>Conectar</button>
        </form>
      </section>
    {:else}
      <div class="toolbar">
        <span class="muted"
          >Dados cadastrados neste banco de desenvolvimento</span
        ><button
          class="secondary"
          disabled={busy}
          onclick={() => execute(refresh)}>Atualizar dados</button
        ><button
          class="secondary"
          onclick={() => {
            connected = false;
            token = '';
            data = {
              clients: [],
              projects: [],
              interactions: [],
              requests: [],
            };
            editing = null;
          }}>Sair</button
        >
      </div>
      <section class="stats" aria-label="Resumo operacional">
        <div><span>Clientes</span><strong>{data.clients.length}</strong></div>
        <div><span>Projetos</span><strong>{data.projects.length}</strong></div>
        <div>
          <span>Solicitações carregadas</span><strong
            >{data.requests.length}</strong
          >
        </div>
        <div>
          <span>Bloqueadas</span><strong
            >{data.requests.filter((r) => r.status === 'blocked')
              .length}</strong
          >
        </div>
      </section>
      <section class="panel">
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
                >{#each data.clients as c}<option value={c.id}>{c.name}</option
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
                ><option value="meeting">Reunião</option><option value="service"
                  >Atendimento</option
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
                  owner,
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
              >Atendimento de origem<select bind:value={interactionId} required
                ><option value="">Selecione</option
                >{#each data.interactions as i}<option value={i.id}
                    >{data.projects.find((p) => p.id === i.project_id)?.name} · {i.summary.slice(
                      0,
                      60,
                    )}</option
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
              >Responsável<input
                bind:value={owner}
                required
                maxlength="200"
              /></label
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
      <section class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">ACOMPANHAMENTO</p>
            <h2>Solicitações</h2>
          </div>
          <label
            >Filtrar estado<select bind:value={filter}
              ><option value="">Todos os estados</option
              >{#each statuses as s}<option value={s}>{labels[s]}</option
                >{/each}</select
            ></label
          >
        </div>
        <p class="muted">
          Até 500 solicitações mais recentes. Novas solicitações entram em
          “Nova”; estados seguintes exigem triagem.
        </p>
        {#if !visible.length}<div class="empty">
            <h3>Nenhuma solicitação neste recorte</h3>
            <p>
              Registre um atendimento e sua primeira solicitação para começar.
            </p>
          </div>{:else}<div class="cards">
            {#each visible as r}<article class="request">
                <div class="card-top">
                  <span class="status" data-status={r.status}
                    >{labels[r.status]}</span
                  ><span class="muted">v{r.version}</span>
                </div>
                <p class="eyebrow">{r.client_name} / {r.project_name}</p>
                <h3>{r.title}</h3>
                <p class="description">{r.description}</p>
                <dl>
                  <dt>Responsável</dt>
                  <dd>{r.owner}</dd>
                  <dt>Próxima ação</dt>
                  <dd>{r.next_action}</dd>
                  <dt>Atendimento de origem</dt>
                  <dd>
                    {data.interactions.find((i) => i.id === r.interaction_id)
                      ?.summary ?? r.interaction_id}
                  </dd>
                </dl>
                <button
                  class="secondary"
                  disabled={busy}
                  onclick={() => edit(r)}>Atualizar solicitação</button
                >
              </article>{/each}
          </div>{/if}
      </section>
      {#if editing}<section class="panel edit" aria-label="Editar solicitação">
          <h2>Atualizar: {editing.title}</h2>
          <form
            onsubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label
              >Estado<select bind:value={editStatus}
                ><option value={editing.status}>{labels[editing.status]}</option
                >{#each transitions[editing.status] as s}<option value={s}
                    >{labels[s]}</option
                  >{/each}</select
              ></label
            ><label
              >Responsável<input
                bind:value={editOwner}
                required
                maxlength="200"
              /></label
            ><label
              >Próxima ação<textarea
                bind:value={editAction}
                required
                maxlength="2000"
              ></textarea></label
            ><button disabled={busy}>Salvar atualização</button><button
              type="button"
              class="secondary"
              onclick={() => (editing = null)}>Cancelar</button
            >
          </form>
        </section>{/if}
    {/if}
    {#if error}<p class="feedback error" role="alert">
        {error}
      </p>{/if}{#if notice}<p class="feedback" role="status">{notice}</p>{/if}
  </main>
</div>
