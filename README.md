# CATUS OS — M5

Monólito modular para operação de uma agência de e-commerce: clientes → projetos → atendimentos/reuniões → solicitações com responsável, estado e próxima ação no Mission Control. Svelte 5 + Vite + TypeScript strict; backend Bun; PostgreSQL real. Identidades, sessões, organizações e papéis substituem o token compartilhado do M0. Atendimento inteligente via adaptador LLM configurável, fila persistente e revisão humana. Sem credenciais/política, inferência indisponível; nenhum mock no aplicativo. Contratos, escopos versionados, change requests e cobertura comercial exigem revisão e autorização humanas explícitas.

## Instalação reproduzível

Node.js >=22.12, npm, Linux/macOS compatível com os binários PostgreSQL. Bun 1.4.4 é instalado localmente pelo npm. Não execute PostgreSQL como root; Windows requer WSL2 ou PostgreSQL externo.

```sh
cd /workspace/catus-os # ou seu checkout
npm ci
npm run env:init
npm run db
```

O PostgreSQL 18.3 local usa `127.0.0.1:5432`, banco `catus`, senha exclusivamente de desenvolvimento `catus_local_only` e dados em `.local/postgres`. Mantenha em terminal próprio; Ctrl+C encerra sem apagar dados. Pode substituir por banco exclusivo de desenvolvimento configurando `DATABASE_URL` e pulando `npm run db`. Nunca use produção. Não apague locks/cluster como rotina: se uma restauração interromper processos, comprove ausência de serviço vivo e preserve os arquivos antes da recuperação.

Em outros terminais:

```sh
npm run db:roles
npm run migrate
npm run dev
```

```sh
npm run web
```

Frontend: porta local 5173; API: porta 3000. Ambos escutam em loopback. `env:init` preserva `.env` existente. O `DEV_TOKEN` legado é ignorado: não há fallback nem login falso no aplicativo. Sem OIDC, a página informa bloqueio e as operações protegidas retornam 503. Não exponha o servidor Vite à Internet. O build gera bundle, não realiza deploy.

## Configurar OIDC / Google Workspace

Use um projeto/cliente **de desenvolvimento** no provedor, nunca credenciais de produção. Guarde segredos apenas no ambiente ou `.env` ignorado; não os envie no chat nem os inclua no Git. Configure juntos:

- `APP_ORIGIN`: origem exata, por exemplo `http://127.0.0.1:5173` localmente; HTTPS é obrigatório fora de loopback e quando `NODE_ENV=production`.
- `OIDC_ISSUER`: para Google, `https://accounts.google.com`; outro issuer HTTPS também pode ser usado.
- `OIDC_CLIENT_ID` e `OIDC_CLIENT_SECRET`: cliente confidencial configurado no provedor.
- `OIDC_HOSTED_DOMAIN`: domínio Workspace autorizado, recomendado com Google; valida o claim assinado `hd`, não apenas o sufixo do email.

Cadastre no provedor o redirect URI **exato** `${APP_ORIGIN}/api/auth/callback`. O app usa Authorization Code, PKCE S256, state, nonce e scopes `openid email profile`; exige email verificado e verifica assinatura JWS/JWKS, issuer, audience, nonce e expiração sem tolerância adicional de relógio. Sincronize o relógio do host. O secret usa `client_secret_post`; não há refresh token, senha local ou persistência de tokens do provedor.

A rede precisa alcançar discovery, authorization, token e JWKS. No Google: `accounts.google.com`, `oauth2.googleapis.com` e `www.googleapis.com`; a descoberta determina os endpoints finais. Não desligue TLS. Neste ambiente não há credenciais OIDC e os domínios do Google ainda precisam de configuração na política de rede: login real não foi validado.

## Primeiro administrador e membros

A migration `002_identity.sql` coloca todos os dados do M0 na organização **Catus**, ID `00000000-0000-4000-8000-000000000001`. Não há usuário automaticamente criado ou vinculado por nome do responsável legado.

Com OIDC configurado e migrations aplicadas, um operador com acesso administrativo ao banco provisiona o primeiro administrador:

```sh
npm run bootstrap:admin -- --email admin@seu-dominio.example --name 'Administrador Catus'
```

Esse comando não faz login: cria uma autorização pendente vinculada a issuer/email. É offline, exige banco privilegiado, registra `offline-bootstrap` e recusa execução se já houver administrador ativo na organização. Não é um endpoint público. Na primeira autenticação válida, o email verificado provisionado é vinculado ao `sub`; depois a identidade é identificada por issuer/sub, sem religação automática por email. Ninguém recebe acesso apenas por pertencer ao domínio.

Após entrar, o administrador usa **Acesso à organização** para autorizar/atualizar membros e revogar acesso. Papéis: `administrator`, `manager`, `po`, `developer`. O servidor recusa alteração do próprio papel e autorrevogação; PO/desenvolvedor/gestor não gerenciam membros. Para outra organização, um operador deve criar a organização e provisionar seu primeiro administrador por procedimento administrativo revisado; não existe cadastro público de empresas. Use `--organization <uuid>` no bootstrap para uma organização existente.

## Sessão, autorização e fluxo

Cookie de sessão opaco, HttpOnly, SameSite=Lax, Path=/; Secure e prefixo `__Host-` sob HTTPS. Somente digest SHA-256 fica no banco. Expiração absoluta: 8h; inatividade: 30min. Papéis e vínculos ativos são consultados em cada operação. Sair revoga a sessão no banco; “Encerrar todas as sessões” revoga todos os dispositivos. Revogação de membro invalida suas sessões na organização. Troca de organização requer vínculo existente e rotaciona cookie e token CSRF. Remover OIDC bloqueia inclusive sessões existentes.

Escritas exigem JSON, origem exata e header `X-CSRF-Token`, fornecido por `GET /api/session` após autenticação. Sem CORS aberto. Cookies/tokens não são guardados em localStorage. O backend ignora headers de identidade e recusa campos de identidade nos payloads operacionais. Organização e autor vêm exclusivamente da sessão e do banco.

| Capacidade                                       | Administrador        | Gestor | PO  | Desenvolvedor                                                  |
| ------------------------------------------------ | -------------------- | ------ | --- | -------------------------------------------------------------- |
| Ler operação/membros da própria organização      | Sim                  | Sim    | Sim | Sim                                                            |
| Criar cliente, projeto, atendimento, solicitação | Sim                  | Sim    | Sim | Não                                                            |
| Triar/repriorizar/reabrir/atribuir solicitações  | Sim                  | Sim    | Sim | Não                                                            |
| Executar solicitação atribuída a si              | Sim                  | Sim    | Sim | Sim, sem reatribuir; estados de execução, bloqueio e conclusão |
| Ler auditoria                                    | Sim                  | Sim    | Não | Não                                                            |
| Gerenciar membros/papéis                         | Sim, exceto si mesmo | Não    | Não | Não                                                            |

O PO cadastra cliente/projeto/atendimento e cria solicitação escolhendo um membro ativo. Solicitações começam em `new`, passam por triagem e ficam `ready` antes de execução. O desenvolvedor atualiza somente trabalho atribuído a si. Registros legados mantêm o texto original de responsável; a UI sinaliza vínculo pendente e PO/gestor/admin escolhe explicitamente o usuário. O texto legado permanece como snapshot, enquanto `owner_user_id` passa a ser a referência operacional. Nenhuma inferência por nome é realizada.

## Testes (banco separado e descartável)

```sh
npm run test:db
npm run check
npm run build
npm run tls:local # somente se os arquivos locais ainda não existirem
npm test
npm run format:check
npx playwright install chromium
npm run test:e2e
```

`TEST_DATABASE_URL` aponta para banco local com nome terminado em `_test` (default `catus_test`), diferente de `DATABASE_URL`. A suíte recusa alvos fora de loopback e nomes inadequados. **O conteúdo desse banco de teste é limpo/truncado pelos testes.** Não use o banco do aplicativo nem execute suítes concorrentes contra o mesmo banco. As migrations de teste não tocam o banco M0 do aplicativo.

Os testes de API e browser usam apenas identidades simuladas em `tests/support`, com ID tokens RS256 realmente assinados e verificados por `openid-client`. Não existe flag ou rota de bypass no servidor normal. O harness exige `NODE_ENV=test` e banco separado; o entrypoint real não importa o harness. O browser simula a tela do provedor, executando endpoints reais de login/callback, cookies, sessão e API. Isso não comprova configuração nem login no Google real.

Playwright inicia e encerra servidores próprios: pare processos que ocupem 3000/5173 antes de rodá-lo. Em Linux, `CHROMIUM_PATH=/caminho/chromium npm run test:e2e` aceita binário instalado externamente. Nesta máquina foi usado Chromium 143 do pacote npm `@sparticuz/chromium@143.0.4`; download padrão do Playwright é bloqueado pela política. Esse modo usa `--no-sandbox` apenas no browser de teste isolado, não no produto. Artefatos em `test-results/` são ignorados pelo Git.

## API

Rotas públicas limitadas a `GET /api/auth/config` (booleano), `/api/auth/login` e `/api/auth/callback`. Demais rotas exigem sessão e autorização.

| Método | Rota                              | Operação                                                                   |
| ------ | --------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/api/session`                    | Usuário, papel, organização, expiração, organizações permitidas e CSRF     |
| POST   | `/api/session/logout`             | Encerra sessão atual; JSON `{}`                                            |
| POST   | `/api/session/revoke-all`         | Encerra todas as sessões do usuário                                        |
| POST   | `/api/session/organization`       | `{organization_id}`; valida vínculo e rotaciona sessão                     |
| GET    | `/api/health`                     | Conexão ao banco; autenticada                                              |
| GET    | `/api/mission-control`            | Snapshot consistente da organização                                        |
| GET    | `/api/members`                    | Membros ativos da organização                                              |
| GET    | `/api/audit`                      | Até 500 eventos da organização; admin/gestor                               |
| POST   | `/api/memberships`                | Admin: `{email,name,role}`; cria autorização ou atualiza papel             |
| POST   | `/api/memberships/:userId/revoke` | Admin revoga membro da própria organização                                 |
| POST   | `/api/clients`                    | `{name}`                                                                   |
| POST   | `/api/projects`                   | `{client_id,name}`                                                         |
| POST   | `/api/interactions`               | `{project_id,kind,summary,occurred_at}`; `meeting`/`service`, ISO com fuso |
| POST   | `/api/requests`                   | `{interaction_id,title,description,owner_user_id,next_action}`             |
| PATCH  | `/api/requests/:id`               | `{status,owner_user_id,next_action,version}`                               |
| GET    | `/api/extraction`                 | Capability LLM/política da organização; papel PO/gestor/admin              |

201 criação; 401 sessão inválida; 403 permissão/CSRF; 404 recurso inexistente ou fora do escopo; 409 concorrência; 413 payload >32KiB; 415 tipo; 422 validação; 503 autenticação sem OIDC/serviço indisponível. Queries parametrizadas, constraints compostas e contexto de organização são usados em todas as operações. Após 409, recarregue antes de editar. POST de criação exige Idempotency-Key UUID e oferece replay transacional por 24h; veja o protocolo de homologação. Mission Control limita atendimentos/solicitações a 500 recentes, sem excluir o restante.

**Atendimento inteligente M2:** [configuração do provedor, política, orçamento, fila e demonstração](docs/AI_INTAKE.md). Após `db:roles`/migrations, o worker usa `npm run ai:worker`; a configuração pode ser verificada com `npm run ai:check` sem enviar dados.

**Homologação M1.1:** [checklist, HTTPS/Google, privilégios, manutenção, backup e restore](docs/HOMOLOGATION.md). O runtime normal recusa conta PostgreSQL privilegiada e recebe somente sua própria URL; credenciais de migrations/manutenção ficam fora do processo web. Novas migrations usam MIGRATION_DATABASE_URL. Use `npm run start` para servir o build pela origem HTTPS de homologação.

[ARCHITECTURE.md](ARCHITECTURE.md), [MASTER_PLAN.md](MASTER_PLAN.md), [PROGRESS.md](PROGRESS.md) e [NEXT.md](NEXT.md) detalham arquitetura, evidências, limites e próximas tarefas. O procedimento de criação de main está em [docs/GIT_REVIEW.md](docs/GIT_REVIEW.md); nenhuma main/default foi alterada automaticamente.

## M3 — Contratos, escopos e aprovação comercial

Guia: [SCOPE_CONTRACTS.md](docs/SCOPE_CONTRACTS.md). Após `db:roles` e `migrate`, o controle comercial permite cadastrar contratos, preparar versões com itens/origem, submeter, decidir com alçada explícita e abrir change requests. Administrador configura os papéis autorizados; nenhum preparador pode decidir o próprio escopo. Cobertura no Mission Control exige vínculo humano com item aprovado e contrato vigente; “Pronta” não é aprovação comercial. Não há cálculos financeiros ou assinatura eletrônica.

O fluxo M3 e regressões são reproduzidos por `npm test` e `npm run test:e2e`, executados sequencialmente em bancos locais descartáveis. Evidências em PROGRESS.md. Não é preciso credencial Google/LLM real para os testes; aplicação normal continua exigindo autenticação configurada.

## M4 — Horas e inteligência econômica

Guia completo: [ECONOMICS.md](docs/ECONOMICS.md). Premissas e termos versionados com aprovação independente, capacidade declarada, estimativas, horas/reversões, custos/ETC/EAC/margens e consolidação por cliente/moeda/competência. Dinheiro inteiro/BigInt, dados ausentes explicitamente incompletos, snapshots históricos imutáveis. Gestor/admin vê custos; PO estima sem ver taxas e desenvolvedor aponta horas próprias. Não há valores automáticos, contabilidade, recebimentos, câmbio ou execução de agentes.

Aplicar `db:roles`, `migrate` e `test:db`; executar `npm test` antes de `npm run test:e2e`, nunca simultaneamente. Sem Google/LLM real, testes usam apenas harness sintético; aplicação normal continua bloqueando autenticação não configurada.

## M5 — Delegação controlada e runner próprio

Guia: [AGENTIC_DELIVERY.md](docs/AGENTIC_DELIVERY.md). Política default OFF, elegibilidade M3/M4 determinística, fila durável/idempotente, runner isolado, testes/diff e revisão humana. M5.1 usa adaptador Responses separado com schema/no-tools; SDK 0.166.0 desativado por incompatibilidade reproduzida. [Aceite e diagnóstico](docs/REAL_AGENT_ACCEPTANCE.md); não é API do Codex Cloud.

**Validado:** fila/regras e execução real de runner Docker sobre tema Nuvemshop sintético, com geração determinística exclusivamente de teste. **Codex real NOT_VERIFIED; PR remoto NOT_CREATED.** Sem credenciais/gateway/infra autorizados, runner informa unavailable e não simula IA. Código/patch não são integrados automaticamente. M0–M4 preservados.

Testes M5 precisam da imagem Node fixada no CI/guia. Executar `npm test` antes de Playwright. Para API aplicar grants/migration 009; credenciais e mirror de runner ficam em conta separada, sem URLs PostgreSQL/segredos de clientes.
