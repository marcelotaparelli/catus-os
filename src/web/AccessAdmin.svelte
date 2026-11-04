<script lang="ts">
  import { roleLabels, roles } from '../shared/identity';
  import type { Member, Role } from '../shared/identity';
  let {
    members,
    currentUserId,
    busy,
    onProvision,
    onRevoke,
  }: {
    members: Member[];
    currentUserId: string;
    busy: boolean;
    onProvision: (body: {
      email: string;
      name: string;
      role: Role;
    }) => Promise<void>;
    onRevoke: (id: string) => Promise<void>;
  } = $props();
  let email = $state('');
  let name = $state('');
  let role = $state<Role>('po');
</script>

<section class="panel" aria-label="Administrar acesso">
  <h2>Acesso à organização</h2>
  <p class="muted">
    Somente contas corporativas autorizadas podem entrar. Papéis são verificados
    no servidor; não é permitido alterar ou revogar seu próprio acesso.
  </p>
  <form
    class="access-form"
    onsubmit={(e) => {
      e.preventDefault();
      void onProvision({ email, name, role });
    }}
  >
    <label
      >Email corporativo<input
        type="email"
        bind:value={email}
        required
        maxlength="254"
      /></label
    >
    <label
      >Nome do membro<input bind:value={name} required maxlength="200" /></label
    >
    <label
      >Papel<select bind:value={role}
        >{#each roles as r}<option value={r}>{roleLabels[r] ?? r}</option
          >{/each}</select
      ></label
    >
    <button disabled={busy}>Autorizar ou atualizar membro</button>
  </form>
  <ul>
    {#each members as member}<li>
        {member.name} · {member.email} · {roleLabels[member.role] ??
          member.role}
        <button
          class="secondary"
          disabled={busy || member.id === currentUserId}
          onclick={() => onRevoke(member.id)}
          >Revogar acesso de {member.name}</button
        >
      </li>{/each}
  </ul>
</section>
