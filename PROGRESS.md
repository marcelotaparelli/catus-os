# Progresso

## M2 — Atendimento inteligente com revisão humana · 31/10/2026

Baseline limpo `43183a3` na própria branch `feat/m1-identity-security`, preservado. Leitura dos documentos M0–M1.1 e homologação; autorização explícita M2 aplicada sem aguardar credenciais externas. Migrations anteriores intactas, 004/005 incrementais aplicadas no banco local e nos bancos descartáveis; sem merge/deploy/main/alteração de produção.

### Implementado

- Conversas, reuniões, atendimentos e observações manuais; sem autoenvio ao cadastrar contexto.
- Adaptador **real** HTTPS OpenAI-compatible, configurável por ambiente, sem dependências novas e sem fallback simulado; JSON Schema e validação estrita independente. Missing config/key/policy → indisponível, não gera resultados fictícios.
- Extração de resumo, requisitos, decisões, compromissos, informações ausentes, perguntas, propostas e critérios sugeridos; citações literais com offsets UTF-16 calculados e fonte/hash preservados. Campos de autoridade/tools/IDs externos do modelo recusados. Prompt trata origem como dados não confiáveis.
- Fila PostgreSQL persistente, claim/lease, uma tentativa por job, nenhuma chamada LLM dentro da transação HTTP; crash/timeout/cobrança ambígua sem reenvio automático. Reservas diárias UTC, teto por job, contagem de jobs, limites de input/output/bytes/tempo, preços explícitos e revalidação de política/identidade antes/depois do provedor. Jobs de ontem não contornam orçamento de hoje.
- Quarta conta PostgreSQL AI worker, adicionada sem trocar credenciais antigas; launcher isola URLs. Worker não cria requests, não aprova propostas, não gerencia acesso e não grava revisões humanas. Web continua com autorização individual, isolamento de tenant e CSRF.
- Duplicidades lexicais locais por projeto/organização, com candidatos/evidência e confirmação adicional, sem fusão automática ou envio do catálogo ao LLM.
- UI de políticas sintéticas (admin), extração, fila/histórico, origem, métricas reais quando informadas, revisão/edição/rejeição, confirmação humana e aprovação em lote. Criação transacional/idempotente de somente propostas selecionadas, com responsável/ação e link reverso no Mission Control. Histórico antes/depois e autoria individual; output original da IA imutável.
- Restore M1.1 ampliado para impedir reenvio de jobs queued/running restaurados. Correção do teardown: aguardar fechamento observado das conexões antes de remover bancos descartáveis, em vez de FORCE; erros de pool tratados sem dump de objeto/credenciais.

### Evidências reais

- `npm run check`: Svelte e TypeScript sem erros/avisos; `npm run build`: bundle gerado; formatação validada.
- Suíte completa: **38 testes aprovados, 379 assertions, 0 falhas/erros**, cobrindo M0/M1/M1.1 e M2. Saídas adversariais, evidências inventadas, campos de autoridade, tools, JSON/truncamento/oversize, prompt injection como dado, ausência de chave/política, escopo de dados, isolamento, papel/CSRF, versão, rollback do lote, replay idempotente, duplicidades, cotas, dias UTC, redução de orçamento, falta de usage, crash e revogação.
- Playwright: **2 testes aprovados**. O M2 registrou cliente/projeto/reunião **sintéticos**, recebeu 3 propostas, editou uma, aprovou 2 e rejeitou 1; somente 2 demandas no Mission Control com responsável, ação e rastreabilidade, inclusive após reload. O cenário de regressão PO/desenvolvedor/organização externa continua aprovado.
- O harness usa o adaptador HTTP real com **transporte LLM simulado exclusivamente nos testes**, não inferência real. OIDC também é simulado somente nos testes. Screenshot `test-results/m2-human-reviewed.png` inspecionado; não é apresentado como chamada real ao provedor.
- Testes PostgreSQL comprovam worker sem INSERT requests/UPDATE propostas, runtime sem alteração de estado dos jobs, auditoria humana correta e nenhuma demanda antes da confirmação. Histórico original não muda após edição do PO. Backup/restauração continuam exercitados com pg_dump/pg_restore reais e jobs restaurados bloqueados para reenvio.
- `npm run ai:worker -- --once`: worker restrito iniciou e informou LLM indisponível, sem chamadas externas. `npm run ai:check`: código 2 com configuração ausente, sem segredo impresso ou requisição enviada.

CI atualizado para Validate M2, preservando todos os checks anteriores e incluindo as novas suítes. Execução remota será verificada após publicar os commits; CI M1.1 não é prova M2.

### Limitação de aceite externo e retomada

Foram verificadas apenas presença/nomes de LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_DATA_POLICY_ID, OPENAI_API_KEY e ANTHROPIC_API_KEY: **ausentes**. Configuração de secrets do ambiente também vazia. Não há credencial de teste legitimamente disponível; não se extraiu chave de outro serviço nem se tentou inferência externa. O egress atual não autoriza o hostname do provedor. Portanto, **compatibilidade/qualidade/usage de um modelo real ainda não foram comprovadas**. Proprietário deve seguir `docs/AI_INTAKE.md` com chave/modelo/preços/política e dados sintéticos autorizados.

Schema/citações não garantem fidelidade semântica; revisão humana permanece obrigatória. Duplicidades são heurísticas limitadas; orçamento é estimado e depende de tarifas/tokenização do modelo e de teto também no provedor. Sem usage confiável, consumo de reserva é conservador, não fatura. Sem política/autorização não enviar clientes reais. Homologação Google, isolamento de SO, retenção corporativa e supervisão de workers continuam pendentes. Não foram implementados Chat/Meet, escopos/contratos, motor financeiro, agentes de desenvolvimento, merge ou deploy.

---

## M1.1 — Homologação e hardening · 31/10/2026

Continuação na própria `feat/m1-identity-security`, baseline limpo `a53b231`. Documentos e código M1 revisados; migrations 001/002 preservadas e migration incremental 003 aplicada/repetida em banco local. Nenhuma main, merge, produção, credencial Google real ou exposição pública.

### Implementação e revisão

- Rate limit persistido e atômico por peer TCP real: 20/min auth, 300/min API, 429/Retry-After, tentativas falhas contam e quotas sobrevivem à reinicialização. Headers de encaminhamento não viram identidade de rede. Falha de proteção retorna 503.
- Idempotência transacional nas quatro criações M0: UUID obrigatório, escopo organização/usuário/rota/chave, hash JSON canônico, TTL 24h, replay do mesmo resultado e 409 para conflito. Uma criação/auditoria sob concorrência; rollback não registra sucesso. Frontend conserva chave para retry da tentativa e limpa rascunhos ao sair/trocar sessão.
- Papéis PostgreSQL runtime/migrator/maintenance, ownership explícito apenas nos objetos conhecidos, PUBLIC sem CREATE/connect indiscriminado. Runtime sem DDL, superuser, alteração da auditoria ou acesso às migrations; manutenção sem leitura de negócio. Startup verifica privilégios e launcher remove credenciais elevadas do processo web (`--no-env-file`). Host compartilhado ainda exige isolamento de SO/arquivos pelo operador.
- Worker separado, 60s, batches de 500, lock transacional e timeout; purga sessões expiradas/inativas/revogadas, states, rate buckets velhos e idempotência vencida, preservando sessões ativas/negócio/auditoria. Comando once exercitado.
- Servidor Bun com build na mesma origem HTTPS loopback, CSP e cabeçalhos; certificado/CA local gerados com chave protegida, sem ignorar erros TLS. Perfil Google offline e check de pré-requisitos. Sem configuração, login continua bloqueado.
- Backup pg_dump custom real (clientes oficiais PostgreSQL 18.3 por digest), streaming AES-256-GCM, chave separada, fsync/rename e arquivos privados. Restore real, transacional, apenas em banco local descartável vazio, rejeita adulteração/overwrite e invalida material de sessão/cache antes dos grants.
- `docs/HOMOLOGATION.md`: instalação, separação de contas/segredos, HTTPS/CA/túnel privado, Google Workspace, checklist A/B/C, rate/idempotência/manutenção, comandos de backup/restore e tarefas do proprietário. README/arquitetura/roadmap/NEXT atualizados; sem iniciar M2.

### Evidência executada

- Typecheck Svelte/TS: aprovado (0 erros/avisos); build Vite e formatação aprovados.
- `npm test`: **26 testes aprovados, 277 assertions**, regressão M0/M1, autorização/isolamento, OIDC negativo, privilégios SQL reais, retry concorrente/restart, quota persistente, limpeza, backup/restore e HTTPS.
- `CHROMIUM_PATH=/tmp/chromium npm run test:e2e`: **1 aprovado**, PO → desenvolvedor, terceira organização, reload, autorização e logout; teardown corrigido para limpar também idempotência e sem falhas de limpeza na última execução.
- Backups/restores da suíte comparam linhas de clientes/projetos/atendimentos/solicitações/usuários/membros/auditoria. Arquivo adulterado não cria objetos; alvo com dados é recusado; destino não contém sessões nem idempotência anterior. Bancos/roles da suíte são criados e removidos, sem usar dados do aplicativo.
- Comandos manuais reais: `db:roles` (repetível, sem trocar senhas), `migrate`, `cleanup -- --once`, `backup:key`, `backup -- .local/backups/m11-local.catus`, `restore:prepare`, `restore:test`. Arquivo criptografado local de 32.450 bytes criado; restore em `catus_homolog_restore_test` completou com `sessionsInvalidated:true`. Artefatos/chaves/URLs ficam em `.local` ignorado e nunca foram impressos.
- Entrypoint real iniciou com conta restrita e sem URLs administrativas; instância HTTPS em 127.0.0.1:3443 respondeu HTML/CSP e `configured:false` via curl com `--cacert`. Teste TLS rejeitou CA não confiável; nenhuma verificação de assinatura/TLS foi desabilitada.
- `npm audit --omit=dev`: 0 vulnerabilidades reportadas. Os testes passaram com imagem oficial verificada por checksum/digest; nenhuma dependência de aplicação nova foi necessária.
- `npm run homologation:check` sem perfil real retornou código 2 (`Homologation requires HTTPS` na configuração default HTTP), corretamente identificando pendência, não um aceite. Testes do perfil HTTPS/Google usaram exclusivamente valores fictícios identificados como testes.

CI `Validate M1.1` foi atualizado sem remover checks existentes: papéis/migrations, build antes de testes HTTPS, geração de CA local, clientes PostgreSQL por digest, todas as suítes e Playwright. CI M1.1 aprovado no [run 41227344571](https://github.com/marcelotaparelli/catus-os/actions/runs/41227344571), commit `480aae5`, confirmado na página pública como `completed successfully`. CI M1 anterior não foi usado como evidência M1.1.

### Pendências e limites

Independentes de segredos Google concluídas; proprietário precisa configurar cliente/consentimento/redirect/secret de homologação, egress, domínio Workspace, trust dos perfis e contas A/B/C, e registrar aceite real. Não foi feita autenticação no Google real. Isolamento entre usuários de SO e supervisão contínua do worker não foram configurados no host. O cluster de fixtures ainda tem administrador com senha pública de desenvolvimento: o proprietário deve fornecer/endurecer PostgreSQL de homologação antes de uso compartilhado, conforme checklist; grants runtime não substituem esse requisito. RLS, retenção corporativa de auditoria/backups, observabilidade e recuperação de produção não estão implementados. Restore foi ensaiado no schema atual, não em backups históricos. TTL idempotente de 24h não é deduplicação eterna nem persiste rascunho do browser após reload.

---

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
