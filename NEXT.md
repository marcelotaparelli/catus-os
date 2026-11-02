# Próximas etapas — piloto controlado M0–M4

Branch `feat/pilot-readiness` (base `feat/m5-acceptance @ b4fc3cf`). Runbook: [docs/PILOT.md](docs/PILOT.md). Não iniciar M6. M2 (LLM) e M5 (agentes) permanecem desligados no piloto.

## P0 — Bloqueios do proprietário (sem eles não há piloto com pessoas)

1. **Host privado de homologação (G2):** opção preferida do proprietário: Docker Compose no Arch — `deploy/catus.sh install` e `verify --recreate` com `0 FAIL`, CA em perfil Firefox dedicado ([docs/DOCKER.md](docs/DOCKER.md) §7). Alternativa nativa: executar [docs/G2_HOST.md](docs/G2_HOST.md) num host Linux persistente com systemd (não na VM efêmera de desenvolvimento) até `scripts/g2-preflight.sh` terminar com `0 FAIL`; registrar itens HUMAN e testes negativos. Ensaio na VM descartável aprovado exceto os itens do próprio host.
2. **Google Workspace real (G3):** cliente OAuth Web de homologação, `OIDC_HOSTED_DOMAIN`, redirect exato `https://localhost:3443/api/auth/callback`, egress para `accounts.google.com`, `oauth2.googleapis.com` e `www.googleapis.com`, CA local confiada em perfis dedicados. Login Google real continua **NOT_VERIFIED**.
3. **Aceite A/B/C (G4):** checklist de HOMOLOGATION.md §4 com contas reais (admin, desenvolvedor, usuário do domínio não convidado), registrando evidências sem cookies/segredos.
4. **Backup/restore no host (G5):** `backup:key`, backup e restore descartável; chave em cofre separado.

## P0 — Engenharia antes do primeiro dia de uso

5. CI verde observado no `783f19f` (85/85 Bun, 6/6 Playwright, incluindo Docker). Conferir o CI de cada novo HEAD antes do primeiro dia de uso.
6. Revisar o PR `feat/pilot-readiness` → `feat/m5-acceptance` (ou base definida pelo proprietário). Nenhum merge automático.

## P1 — Durante as primeiras semanas do piloto

7. Cota de API é por peer TCP: atrás de um único túnel SSH, toda a equipe divide 300 req/min. Medir 429 nos primeiros dias; se ocorrer, decidir entre túneis por pessoa ou cota por sessão autenticada (mudança de segurança que exige revisão).
8. Correção de cadastro: não há renomeação/arquivamento de clientes, projetos e atendimentos. Se o piloto mostrar necessidade, implementar edição versionada e auditada (sem exclusão física).
9. Paginação/busca acima de 500 atendimentos, solicitações e eventos de auditoria.
10. Atualização automática (polling leve) do Mission Control ou aviso de dados desatualizados; hoje o usuário usa **Atualizar dados**.

## P2 — Após o piloto, somente com autorização

11. Aceite LLM M2 real e runner/Codex M5 real seguem os guias AI_INTAKE.md, AGENTIC_DELIVERY.md e REAL_AGENT_ACCEPTANCE.md; continuam NOT_VERIFIED.
12. M6 (gestão e melhoria contínua) só com dados reais coletados no piloto e instrução explícita.

Preservar `.env`, dados, migrations 001–009 e histórico. Rodar `npm test` antes de `npm run test:e2e`, sequencialmente, em bancos descartáveis locais.
