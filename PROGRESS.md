# Progresso

## M1 — Identidade, segurança e preparação multiusuário · 31/10/2026

Baseline verificado: checkout limpo em `824c1e7`, descendente do M0 `369161a`; branch de trabalho `feat/m1-identity-security`. Preservados arquivos locais, `.env` e banco. Sem main, troca de default, merge, deploy ou credenciais reais.

### Implementado

- OIDC configurável com `openid-client`, direcionado a Google Workspace: Code + PKCE S256, nonce/state de uso único, assinatura JWS/JWKS, issuer/audience/expiração, email verificado e `hd` opcional. Sem OIDC completo, login e APIs protegidas são bloqueados; DEV_TOKEN removido da autenticação.
- Identidades individuais previamente provisionadas, vinculadas a issuer/sub após primeira verificação de email. Não há signup automático, papel vindo do IdP/frontend nem bypass de desenvolvimento.
- Cookies HttpOnly/SameSite/Secure sob HTTPS; sessão opaca com digest no PostgreSQL, expiração absoluta de 8h/inatividade de 30min, revogação, logout em todos os dispositivos e rotação na troca autorizada de organização. CSRF ligado à sessão e origem exata em escritas.
- Organizações e papéis administrador, gestor, PO e desenvolvedor; contexto de autorização no servidor em todas as operações. Administração não pode mudar o próprio papel/revogar a si mesma; desenvolvedor só executa solicitações atribuídas a si.
- Migration incremental `002_identity.sql`: preserva entidades M0 em organização Catus; FKs compostas impedem vínculos entre organizações; responsável real por membership da mesma organização; texto legado preservado como snapshot, sem inferência por nome.
- Auditoria individual e atômica de todas as escritas de negócio/acesso. Eventos M0 e bootstrap offline permanecem claramente identificados, sem autoria retroativa fictícia.
- UI de login/sessão/organização, responsáveis reais e administração mínima de membros; entrada manual e Mission Control mantidos.
- Banco de testes separado com guardas, provedor OIDC simulado só em testes, testes negativos/positivos, harness de browser isolado, CI atualizado e procedimento seguro de main em `docs/GIT_REVIEW.md`.

### Evidências verificadas

| Verificação                                    | Resultado observado                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` / `npm run env:init`                  | Instalação congelada aprovada; `.env` existente preservado                                                                                                                                                     |
| `npm run check`                                | Svelte 0 erros/avisos e TypeScript aprovado                                                                                                                                                                    |
| `npm test`                                     | **17 testes aprovados, 0 falhas, 199 assertions**                                                                                                                                                              |
| `npm run build`                                | Bundle Vite gerado                                                                                                                                                                                             |
| `npm run format:check`                         | Todos os arquivos aprovados                                                                                                                                                                                    |
| `npm audit --omit=dev`                         | 0 vulnerabilidades reportadas                                                                                                                                                                                  |
| `CHROMIUM_PATH=/tmp/chromium npm run test:e2e` | **1 teste aprovado** com PO, desenvolvedor e usuário de outra organização, contextos isolados, reload, execução permitida/negada, layout móvel e logout revogado no servidor                                   |
| Servidor normal, sem OIDC                      | `/api/auth/config` 200 com `configured:false`; login e Mission Control 503, sem fallback                                                                                                                       |
| Migration M0 com dados preenchidos             | Schema de teste contendo cliente/projeto/atendimento/solicitação/evento legado preservado; responsável original e autor legado não inventados                                                                  |
| Banco local M0                                 | Migration aplicada/repetida; todos os campos/contagens comparados com snapshot anterior. O banco estava vazio (0 registros nas 5 tabelas), portanto a prova de preservação não vazia vem do teste de migration |

A suíte cobre assinatura inválida, nonce/state/PKCE, replay, expiração, email não verificado, domínio incorreto, usuário não provisionado, subject trocado, cookie duplicado, CSRF/origem, payloads inválidos, campos de identidade forjados, papéis distintos, tentativa de autoelevação, desativação/revogação imediata, isolamento de leituras/vínculos/atribuições/updates/auditoria, troca de organização autorizada com rotação, concorrência 200/409 e auditoria por autor. As regras/transições e o fluxo M0 continuam exercitados; as verificações antigas foram adaptadas à nova autenticação, sem removê-las para forçar aprovação.

Screenshot `test-results/mission-control-m1.png` inspecionado; dados e contas são sintéticos exclusivos de testes. Browser: Chromium 143 via distribuição npm externa já instalada, pois CDN Playwright é bloqueada nesta máquina. Modo multiprocesso corrigiu isolamento de contextos do browser usado no ambiente. Nenhuma verificação TLS/assinatura foi desabilitada.

Antes da migration local foi salvo `.local/backups/m0-before.json`. A tentativa de dump SQL falhou por ausência de `pg_dump` na distribuição; a sequência continuou para a migration. Nenhum dump SQL concluído é alegado. Não houve perda de registros; a comparação confirmou 0 linhas preexistentes. O snapshot/arquivos de controle obsoletos ficam ignorados pelo Git. Na restauração do ambiente, foi necessário arquivar locks/PID de PostgreSQL comprovadamente zumbi antes de reiniciar o mesmo cluster.

### CI e impedimentos externos

Workflow `Validate M1`: instalação congelada, PostgreSQL, migrations, test DB isolado, typecheck, testes, build, formatação e browser. Runner fixado em Ubuntu 24.04 (Playwright suportado); actions atualizadas para runtime Node 24. A página pública mostrou que o run M0 `41203424635` falhou na instalação Chromium; esse resultado não é apresentado como sucesso anterior.

A API `api.github.com` recebeu bloqueio CONNECT 403 do proxy, mas leitura pública de `github.com` funcionou. **CI M1 aprovado no GitHub Actions**, confirmado pela página pública do [run 41220332080](https://github.com/marcelotaparelli/catus-os/actions/runs/41220332080), commit `502222388d3f04fdc992166d83fa280283796421`, com conclusão `completed successfully`. A branch foi publicada em `origin/feat/m1-identity-security`; main segue inexistente e default continua `feat/m0-mission-control`. O status foi observado no GitHub, não inferido pelos checks locais; logs completos pela API continuam inacessíveis.

`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` e `OIDC_HOSTED_DOMAIN` foram verificados apenas por presença: ausentes; nenhum valor foi lido/exposto. Login Google real não foi exercitado. Faltam configuração de cliente de desenvolvimento, domínios de rede apropriados, primeiro administrador e aceite com funcionários autorizados. As identidades simuladas existem somente nos testes, nunca no servidor normal.

### Limites e retomada

Base implementada e validada automaticamente; aceite corporativo real depende dos pré-requisitos OIDC. Não é autorização de exposição/produção. Sem RLS (isolamento no serviço + constraints), conta DB local é privilegiada, sem rate limit/limpeza agendada de sessões/backup restaurado. Eventos indicam autor/ação, sem diffs completos. POST sem idempotência e listagens com 500 itens recentes permanecem limitações M0. Nenhuma IA, contrato, finanças ou execução agêntica implementada. Retomar `NEXT.md` sem iniciar M2.

---

## M0 + primeira fatia — 31/10/2026

Repositório inspecionado: checkout sem arquivos/commits, remoto acessível e sem refs, inclusive sem `main`. Nenhum trabalho anterior substituído. Implementação na branch `feat/m0-mission-control`.

### Implementado

- Svelte 5 + Vite e backend Bun com TypeScript strict; lock npm e versões diretas fixadas.
- PostgreSQL real persistente em loopback, inicialização local sem root/Docker e opção de banco externo.
- Migration transacional com lock e registro de aplicação; tabelas, constraints e índices relacionais.
- Clientes, projetos vinculados, reuniões/atendimentos manuais e solicitações ligadas à origem.
- Estado inicial e transições validadas; responsável e próxima ação obrigatórios; atualização com versão e auditoria atômicas.
- Mission Control responsivo com dados reais, filtros por estado, cartões, formulário de atualização e estados vazios.
- Token local aleatório, origem restrita, validação, limites de payload, queries parametrizadas, tratamento de erros e graceful shutdown.
- Porta tipada de extração com capability indisponível. Nenhuma simulação de IA ou dado pré-carregado.
- Testes de regras, integração PostgreSQL, navegador e workflow de CI; documentação e backlog.

### Evidências executadas

- `npm run check`: Svelte sem erros/avisos e TypeScript sem erros.
- `npm test`: **6 testes aprovados**, 0 falhas, **69 assertions**. Casos: validação, pares de transição, autenticação/origem, JSON/payload, vínculos, ciclo persistente, SQL injection como texto, auditoria e concorrência (200/409).
- `npm run build`: bundle real gerado pelo Vite.
- Instalação limpa com `npm ci` verificada; `env:init` preservou `.env`; PostgreSQL parado e reiniciado sem recriar o cluster. `npm run format:check` passou.
- Migration aplicada e repetida sem reaplicação; readiness confirmado com query real ao PostgreSQL.
- `CHROMIUM_PATH=/tmp/chromium npm run test:e2e`: **1 teste aprovado**. Cliente → projeto → reunião → solicitação → cartão → atualização → reload/reconexão; estado, responsável e próxima ação persistidos. Layout de 390px sem overflow e nenhum `pageerror`. Screenshot inspecionado em `test-results/mission-control.png` (artefato local ignorado); dados sintéticos removidos após teste.
- Download padrão Chromium via Playwright recebeu 403 da política de rede; teste realizado com Chromium 143 da distribuição npm `@sparticuz/chromium@143.0.4` instalada fora do checkout. Sem desativar TLS/checksums.
- Auditoria motivou atualização de Svelte para 5.57.3, Vite para 7.3.7 e esbuild transitivo corrigido. `npm audit --omit=dev`: **0 vulnerabilidades**. Auditoria completa: **3 achados baixos** relacionados a deepmerge/plugin Svelte de desenvolvimento, sem correção publicada. Não há merge de configuração fornecida por usuário; servidor limitado a loopback. Reavaliar atualização do tooling antes de expor desenvolvimento a terceiros.

### Limitações explícitas

Acesso atual é de desenvolvedor local com token compartilhado; sem usuários, papéis, isolamento por organização ou autenticação individual. Responsáveis são texto. Não pronto para produção ou piloto compartilhado. POST não tem idempotência, listagens recentes têm limite de 500 atendimentos/solicitações e auditoria não tem UI. Sem edição/exclusão de clientes/projetos/atendimentos nesta fatia.

Não implementados: inferência real, escopo e aprovação comercial, contratos, horas, economia, execução de agentes, integrações de comunicação e dashboards financeiros. Build do frontend não significa deploy. Nenhuma credencial real, produção ou merge utilizados.

CI foi preparada, mas execução no GitHub ainda não foi observada. Commit de implementação `369161a` publicado em `origin/feat/m0-mission-control`; nenhuma main foi criada ou modificada. Não há outra branch remota para servir como base de PR. O Playwright também validou a inicialização automática de API e frontend após parar os serviços anteriores. Ambiente atual validado não comprova restauração de snapshot em nova tarefa. Ver próximos critérios em `NEXT.md`.
