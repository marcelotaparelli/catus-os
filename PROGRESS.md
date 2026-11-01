# Progresso

## Piloto controlado M0–M4 — preparação · 01/11/2026

Branch `feat/pilot-readiness` criada a partir de `feat/m5-acceptance @ b4fc3cf` (árvore limpa, igual a `origin/feat/m5-acceptance`; nenhum trabalho local descartado). Sem M6, sem novos agentes, sem merge/deploy. Runbook: [docs/PILOT.md](docs/PILOT.md).

### Ambiente desta verificação

Contêiner Debian 12 sem git/PostgreSQL/Docker pré-instalados: instalados git e Chromium do Playwright 1.58.2. PostgreSQL 18.3 embutido (`npm run db`) executado por usuário de SO não-root; `db:roles`, `migrate`, `test:db` aplicados (001–009). Docker 20.10 subiu, mas o driver `vfs` esgotou os 3,9 GB do disco raiz ao baixar a imagem Node fixada; foi removido. Portanto **não foram executados localmente**: backup/restore com `pg_dump` fixado e runner isolado M5 (7 testes Bun + `e2e/zz-delivery.spec.ts`, todos com causa `docker` ausente/`sandbox_failure`, idêntica antes e depois das mudanças). Esses dependem do CI.

### Auditoria de usabilidade (navegador real, capturas inspecionadas)

Defeitos encontrados nos fluxos existentes e corrigidos:

- Página única de 3,4k–4,9k px sem navegação; no mobile a barra lateral sumia sem substituto. → Navegação por módulos filtrada por papel (lateral fixa e barra compacta no mobile). Exibição apenas; API continua autorizando cada chamada.
- Solicitações (trabalho do dia) ficavam abaixo de M5/M4/M3; o desenvolvedor rolava toda a página. → Solicitações no topo; filtro **Atribuídas a mim**/por responsável/sem vínculo; indicadores Em aberto e Atribuídas a mim; papel exibido em português.
- Painel de edição renderizado após toda a lista, fora da visão. → Edição inline no próprio cartão, com foco.
- Após 409, o formulário mantinha a versão antiga e falhava sempre. → Recarrega e reabre a edição com o registro atual, com aviso; não reaplica o texto antigo (sem lost update).
- Resposta não-JSON (proxy/queda) mostrava erro de parser. → Mensagem compreensível.
- Sem consulta de clientes/projetos/reuniões registradas. → Seção somente leitura com atendimentos por projeto e solicitações abertas.
- `GET /api/audit` sem tela. → Auditoria somente leitura para admin/gestor, com filtros por tipo e autor.
- Aprovadores viam UUIDs (preparador, decisor, horas, eventos, origem de item de escopo). → Nomes de membros (UUID como fallback) e origem descrita.
- Campos monetários em unidades mínimas sem retorno visual (risco de erro 100×). → Prévia formatada ao vivo (`6000` → `= USD 60,00`); contrato inteiro/BigInt inalterado.

Mudança de API: `GET /api/mission-control` passa a incluir `project_id` e `updated_at` nas solicitações, na mesma consulta já restrita à organização (asserção adicionada em `tests/api.test.ts`). Nenhuma migration nova; 001–009 preservadas.

### Jornada ponta a ponta comprovada

`e2e/pilot-journey.spec.ts`, somente pela UI e com quatro papéis: PO registra reunião → cria solicitação com responsável e próxima ação → consulta a reunião no diretório → admin configura alçadas → PO registra contrato USD, gestor ativa → PO prepara/submete escopo V1 (sem botão de decisão para o preparador), gestor aprova → PO vincula cobertura e tria até Pronta → edição concorrente PO×gestor resulta em aviso e dados atuais → gestor prepara premissas, taxa, termos, capacidade e custo direto, admin aprova cada um → PO estima sem ver taxas, gestor aprova → desenvolvedor filtra “Atribuídas a mim”, inicia execução (responsável bloqueado) e aponta 120 min; `/api/economics` do desenvolvedor sem campos de custo → gestor aprova horas identificadas por nome e calcula: receita USD 10000,00, EAC USD 3284,00, margem projetada USD 6716,00, minutos 600/120/0/1200, capacidade 1000, alertas explícitos, sem incompletude → Mission Control idêntico para PO/gestor/desenvolvedor após reload → auditoria mostra PO e desenvolvedor com `ready->in_progress`; PO recebe 403 em `/api/audit`; desenvolvedor recebe 403 ao criar solicitação via API → 390 px sem overflow. Os valores coincidem com `e2e/economics.spec.ts` (mesmas entradas via API), validando UI contra API.

### Evidências executadas

- `npm run check`: 0 erros/0 avisos (422 arquivos). `npm run build`: ok. `npm run format:check`: ok.
- `npm test`: 85 testes, **78 aprovados**, 7 falhas exclusivamente por ausência de Docker (mesmo resultado no baseline `b4fc3cf` neste ambiente).
- `npm run test:e2e`: **5 aprovados** (commercial, economics, intelligent-intake, pilot-journey, workflow); `zz-delivery` falha por `sandbox_failure` (Docker). Ordem real, banco do harness compartilhado.
- Runtime de produção (`npm run start`, build servido pela API, HTTPS local, conta runtime restrita, sem OIDC): `/api/auth/config` → `{"configured":false}`; `/api/mission-control` e `/api/auth/login` → 503; escrita com `Origin` forjada → 403; CA desconhecida rejeitada pelo cliente; CSP/HSTS/X-Frame-Options presentes; escuta somente `127.0.0.1:3443`. Runtime com conta administrativa recusado (“excessive privileges”). `homologation:check` sem Google → código 2.
- Nenhum segredo, credencial Google/OpenAI ou dado real usado; diff verificado antes dos commits.

### Status externo

Login Google real: **NOT_VERIFIED** (sem cliente OAuth/domínio/egress). Homologação privada: procedimento reproduzível documentado e controles do runtime verificados localmente; host, contas reais e aceite A/B/C dependem do proprietário. Branch **não publicada** a partir deste ambiente (sem credencial GitHub: `could not read Username`); CI da branch **não observado**. O proprietário publica com `git push -u origin feat/pilot-readiness` e confere o workflow `Validate M5.1`, que roda também os testes dependentes de Docker.

## M5.1 — Issue #4: preparação do aceite real · 01/11/2026

Baseline local/remota `aec7a5a` confirmada e issue/comentários lidos; branch
`feat/m5-acceptance`. Nenhum trabalho perdido foi presumido recuperado. Git e
SDK/dependências foram instalados no ambiente, preservando proxy/TLS. Push HTTPS
sem credencial Git falhou; checkpoints foram publicados pelo conector GitHub e
sincronizados por fetch/rebase, sem force push, merge, deploy ou mudança de main.

- Checkpoint documental remoto `6109e78`, CI
  [41339535951](https://github.com/marcelotaparelli/catus-os/actions/runs/41339535951)
  **success**.
- Checkpoint de implementação `ec0bbeb`, CI
  [41348702849](https://github.com/marcelotaparelli/catus-os/actions/runs/41348702849)
  **success**: **83 testes / 980 assertions**, cinco Playwright, grants/migrações,
  typecheck/build/formatação, regressões M0–M5 e backup/restore criptografado real.
  Prova SDK loopback e testes Responses/readiness também aprovados. O HEAD final
  inclui documentação e build/smoke das imagens; seu CI deve ser conferido por SHA
  antes da entrega. Não reutilizar CI de um ancestral como evidência desse HEAD.

Checkpoint `0d32e20`, [CI 41349073787](https://github.com/marcelotaparelli/catus-os/actions/runs/41349073787) **success** observado: regressão completa, testes de autorização legada, builds das duas imagens e import Responses sem rede aprovados. **Fase A PREPARED**; Fase B NOT_VERIFIED. Checkpoint documental posterior registra esta evidência e acrescenta import sem rede do gateway; conferir também o CI do HEAD na entrega.

### Contrato e implementação

Reprodução real do SDK/CLI **0.166.0** contra servidor loopback de recusa 422,
sem credencial real: seis requests `/v1/responses`, `stream:true`, schema JSON e
tools request_user_input/view_image/multi_agent_v1/get_goal/create_goal/update_goal,
mesmo com shell/apply_patch desativados, read-only e approval never. **Zero chamadas
a provedor**. Há incompatibilidade comprovada com no-tools e chamada única; CLI
version/SDK instalado não eram inferência. SDK e entrypoint legado desativados,
sem bypass ou relaxamento do gateway.

Adaptador separado `ResponsesAgent`, HTTP/JSON Responses direto, schema estrito,
tools vazio/tool_choice none/store false/stream false, uma chamada e timeout/abort;
imagem ativa sem SDK/CLI. Reutiliza sandbox, allowlists, testes fixos e patch/SHA.
Gateway reconstrói campos aceitos, fixa modelo/schema/saída, orçamento antes da
rede, uma autorização consumida antes do upstream, sem redirect/retry. Recusas,
truncamento, tools, paths/campos extras/segredos, usage ausente/inválido/excessivo e
limites de bytes falham fechados; validação repetida no cliente/executor/API.
Política e resultado têm harness responses-api explícito; UI não chama isso de
Codex SDK. Attestation e política SDK anteriores não habilitam Responses; nova
revisão humana obrigatória, default OFF. Migrations 001–009 intocadas.

Diagnóstico offline por dez fronteiras, sem revelar valores/credenciais, sem
claim/inferência; ausência DENIED, presença CONFIGURED_NOT_VERIFIED, código 2.
Fixture sintético versionado com título esperado e testes antes/depois; mock e
geração determinística só em testes. Guia REAL_AGENT_ACCEPTANCE contém comandos,
custo/uma tentativa, checklist de instalação privada e evidências do proprietário.
CI acrescenta reprodução SDK, testes adversariais e build/smoke sem rede das imagens.

Checks locais: contratos sintéticos/readiness, Svelte/TS sem erros/avisos, build e
formatação aprovados. Esta VM é root, sem Docker/socket/capabilities; launcher
PostgreSQL recusa root. Não foram alegados testes Docker/backup locais: evidência
completa vem do CI por SHA, sem remover testes ou alterar isolamento para acomodar
este ambiente.

### Gate externo — parar após preparação A

**Inferência Responses real NOT_VERIFIED; CODEX_REAL_VERIFIED não estabelecido;
PR do agente NOT_CREATED.** Preparação não conclui M5 end-to-end. Proprietário deve
configurar chave legítima somente no gateway privado, conta/billing/tarifas/tetos,
modelo compatível, TLS/egress autorizado, host/runner isolado e repo/ref/SHA fixture
autorizados. Não solicitar segredo no chat. Após configuração, uma execução real,
patch/testes/usage/custo/limpeza e revisão humana com evidências sanitizadas.
Sucesso Responses será RESPONSES_REAL_VERIFIED, nunca certificação do SDK.
Publicador de PR separado depende de repo/base e credencial mínima próprios;
nenhum token amplo foi reutilizado. M6 e homologações independentes M1/M2/M4 não
foram iniciados/promovidos. Sem dados de clientes ou produção.

## M5 — Issue #3: fila e runner controlado Nuvemshop · 01/11/2026

Baseline M4 `613d0cc46bd199be344beb661824bcdc44ccdcbc` confirmado local/remoto; branch própria `feat/m5-agentic-delivery` criada sem reescrever histórico. Issue #3, arquitetura/planos/progresso e guias M0–M4 lidos; rede cloud restrita/sem secrets de provedor configurados preservada. Migrations 001–008 intocadas. Sem main/default, merge, deploy, produção ou exposição pública.

### Situação de aceite por fronteira

| Fronteira                  | Evidência real                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Fila/regras/autorizações   | Validada em PostgreSQL real, M2 humano → M3 → M4 → política → job automático único                                        |
| Runner isolado com fixture | Validado: repo Git sintético, arquivo alterado, testes Docker reais, patch/SHA/limites/limpeza e revisão humana           |
| Codex real                 | **NOT_VERIFIED**: sem chave legítima/gateway/egress homologados. Fixture determinístico só nos testes, llm_verified=false |
| PR remoto do agente        | **NOT_CREATED**: patch preservado; nenhuma credencial mínima/repo/base de publicação do agente disponibilizados/validados |

### Implementado

- Migration 009 aditiva: política/specs/aprovação de observação/credenciais de runner, reservas diárias/totais, jobs/leases/eventos/reviews. Runtime mínimo, AI worker/maintenance sem grants M5; runner separado não recebe PostgreSQL.
- Política default OFF e ativação humana auditada por gestor/admin, repo/ref/SHA e arquivos de tema allowlisted, Nuvemshop/Codex SDK, tentativas/concorrência/tempo/tokens/preços/tetos/frescor/margem. Elegibilidade usa identidade/atribuição/status/spec, cobertura M3 atual e contrato vigente, observação M4 completa/fresca/sem mudanças posteriores, aprovação independente e capacidade/orçamento. Nada é autorizado por flag frontend ou texto do modelo.
- Job/reserva/eventos transacionais junto à mutação elegível: fila/outbox PostgreSQL sem serviço genérico extra. Um job por spec/ativo por demanda; revalida claim/start/heartbeat/finish. Revogação bloqueia e cancela; crash/ambiguidade exige revisão, sem retry pago. Estado do job separado da demanda.
- Runner exporta somente blobs 100644 explícitos de mirror/branch/SHA autorizados, aplica arquivos existentes de tema por código e roda comandos fixos Node em container sem rede, root/worktree RO, usuário não root com UID/GID do proprietário dos mounts, caps/pids/memória/CPU/arquivos/tmpfs finitos. Watchdog dentro do container e limpeza observada, sem socket Docker/DB/GitHub/segredos no agente/testes. Git temporário não tem remoto.
- Adaptador CodeAgent/Codex SDK oficial 0.166.0 em package/lock isolados, Node admitido no runner; container read-only/approval never/web off, sem full-access. Gateway detém chave upstream e impõe uma chamada/tokens/bytes/tempo/modelo/preços/teto, sem tools/storage/retries/redirect. Dinheiro operacional microUSD/BigInt, sem somar USD a BRL/M4 ou fingir fatura quando só reserva é conhecida.
- Credencial de broker limitada a org/projeto, digest/8h/revogação, CLI local offline e arquivo 0600 novo. Launchers isolam env e removem DB/finance/GitHub/provider keys conforme papel do serviço. Recusas autenticadas auditadas após rollback sem guardar corpo/segredos; hashes de lease não expostos.
- Mission Control com bloqueios/elegibilidade, política/revisão M4/spec, fila, reserva/consumo controlado, patch/testes/limpeza e aceitar/rejeitar/pedir correção/cancelar. Fixture identificado explicitamente, sem alterar status/comercial ou integrar código.
- Restore encerra interrompidos, liquida reserva conservadora, limpa leases/revoga credenciais e desativa políticas com evento de sistema; histórico/evidência/review preservados, nenhuma reativação automática.

### Evidências executadas

- `db:roles`, `migrate`, `test:db` aprovados em PostgreSQL local preservado; migration 009 aplicada/repetível. Postmaster antigo estava zombie e somente locks obsoletos foram arquivados antes de retomar o mesmo banco.
- Typecheck Svelte/TS sem erros/avisos; build Vite aprovado. **78 testes aprovados, 923 assertions, 0 falhas**, incluindo regressões completas M0–M4. Políticas OFF, escopo/contrato, margem/orçamento/frescor, concorrência/replay, crash/cancelamento/lease, caminhos/comandos/artefatos adversariais, tenant/autorização, token privado/revogação, timeout e limpeza exercitados.
- **5 cenários Playwright aprovados**. O M5 cria demanda via revisão M2, aprova M3/M4, ativa política, aprova observação independentemente, observa um job automático, runner Docker real altera templates/home.tpl, testes/códigos e diff são conferidos, humano aceita revisão, reload preserva e demanda segue ready. Geração do código é fixture test-only, não inferência real. Screenshot sintético ignorado test-results/m5-agentic-delivery.png.
- Testes do tema falham antes da correção e passam após; comprovam ausência de interfaces externas, DB/provider/broker creds/socket/host .env, root/worktree readonly e limites cgroup pids32/memória128MiB. Watchdog/abort encerram teste real pendurado. Após suíte, Docker não tinha containers órfãos em execução.
- Backup AES-GCM/pg_dump/pg_restore reais em banco descartável preservam patch/reviews, invalidam running/credenciais/políticas e zeram reservas pendentes sem replay. M4 continua com hashes/recálculo exatos após restore.
- `npm --prefix runner ci --ignore-scripts` instala SDK/CLI 0.166.0; README/types oficiais inspecionados. Imagens SDK/gateway foram construídas com proxy/CA corretos e sem segredos. CLI `--version` executada na imagem com rede none/RO, sem inferência. SDK não é Codex Cloud.
- `npm run delivery:runner -- --once` sem configuração retorna código 2, unavailable / Codex real NOT_VERIFIED, sem claim/chamada externa. Checagens foram de presença, nunca leitura de valor: CODEX_API_KEY/OPENAI_API_KEY/control-token ausentes. GH_TOKEN herdado existe, mas seu escopo não foi validado e ele não foi reutilizado no agente/gateway/PR; launchers o removem. Git da branch Catus usa somente transporte autorizado para publicar esta implementação.
- Formatação/diff e auditorias npm do runtime e runner aprovadas, 0 vulnerabilidades reportadas. Uma falha de descoberta de fixture fora do sandbox foi corrigida movendo seu programa para dado .fixture, sem desabilitar testes; pacote é executado somente no container. Erros de tipagem/strip-types e contrato de resposta M2 encontrados no desenvolvimento foram corrigidos antes das execuções finais.

Primeiro CI M5 [41306712896](https://github.com/marcelotaparelli/catus-os/actions/runs/41306712896), commit `2240b92`, falhou nos testes do runner: o UID 1000 fixo do container não correspondia ao proprietário dos arquivos privados no GitHub runner. Corrigido para o UID/GID não root do supervisor, preservando permissões 0600/0700, mounts RO e demais limites; não foi removido nenhum teste ou controle. Correção publicada no commit `09927aa`; o [CI 41307336275](https://github.com/marcelotaparelli/catus-os/actions/runs/41307336275) concluiu **Success**, observado em 01/11/2026 às 12:39 UTC. Após a correção, repetidos localmente: typecheck, 78 testes/923 assertions, build, formatação e 5 Playwright, todos aprovados. O commit documental subsequente terá seu HEAD conferido no GitHub antes da entrega. CI mantém checks anteriores e adiciona SDK e imagem Node fixada. Instalação, threat model, diagramas, limites, custos e aceite externo em docs/AGENTIC_DELIVERY.md.

### Limitações / bloqueios externos

Não declarar M5 end-to-end com Codex aceito: não houve credencial/gateway/egress de provedor legítimos disponíveis, nem inferência externa ou PR remoto de agente. SDK/modelo no-tools, SSE real e infraestrutura de rede/conta dedicada ainda requerem teste do proprietário sem relaxar limites. Fixture não substitui essa prova. Patch é a entrega revisável suportada. Apenas correções de arquivos de tema existentes e testes Node sem dependências; renderer/loja Nuvemshop real, publicador de PR mínimo, retenção/paginação/volumes e homologação corporativa continuam pendentes. Sem usuários/clientes/dados reais enviados a terceiros, Cloud task API, merge/deploy/produção ou M6.

---

## M4 — Issue #2: horas, custos, capacidade e rentabilidade · 01/11/2026

HEAD M3 local/remota `e0631d9a2c2b05fd8f99506c5dcb92fe5405748d` confirmada; branch própria `feat/m4-economics` criada sem reescrever histórico. Issue #2 e contexto M0–M3/AI/homologação lidos. Ambiente cloud conectado, rede restrita preservada e sem secrets externos configurados. Sem main/default, merge, deploy, produção ou exposição pública.

### Implementado

- Migration aditiva 008; 001–007 intactas. Registros econômicos por organização/moeda/vigência/fonte/autor, versões e decisões independentes append-only; termos ligados ao contrato/escopo M3, com aditivos de escopo somente após aprovação M3.
- Configuração explícita de tributos/comissões, calendário e overhead proporcional ou ausência declarada. Taxas por profissional/função de custo com vigência e snapshots; função de custo exige declaração do aprovador, sem inferência pelo papel de acesso. Capacidade alocada explicitamente, limitada pelo calendário e sem duplicar disponibilidade entre projetos.
- Estimativas aprovadas por demanda coberta, baseline/restante, pessoa/data; restante atualizável com autoria e histórico. Horas de usuário real em minutos inteiros, pendentes/aprovadas/rejeitadas/revertidas, limites de data/dia, replay/deduplicação e correções por substituição auditada.
- Custos de trabalho congelados na aprovação, despesas externas com orçamento/incorrido/restante explícitos numa única versão e overhead separado. Dinheiro em strings inteiras/BigInt, arredondamento half away por linha/dedução, nenhuma aritmética financeira com float.
- Motor puro m4.1 com custo incorrido, orçamento, ETC/EAC, desvios e margens por bases comparáveis; reconhecimento explícito separado de contratado, nenhum recebimento presumido. Retainer por competência, minutos incluídos/saldo/excedente/rollover com teto/origem; preço fechado não usa saldo de horas. Incompletude por indicador lista dados faltantes e impede margem fictícia.
- Mission Control integra painel por papel: gestor/admin configura/decide/observa fontes/relatórios; PO estima sem taxas e desenvolvedor aponta horas próprias sem custos. Observações congelam inputs completos, CommercialBasis, resultado, engine/hash canônico e data/corte. Evolução por observações; consolidação por cliente não mistura moeda/competência/revisões e alerta projetos sem observação comparável.
- Runtime com SELECT/INSERT M4, sem reescrita; worker LLM/maintenance sem grants M4. Transações, CSRF/tenant, alçada M3, autor independente, concorrência/versionamento e idempotência mantidos. Sem nova dependência de aplicação, LLM para números, ERP/banco/Chat/Meet ou execução M5.

### Evidências reais

- `db:roles`, `migrate`, `test:db` aprovados em PostgreSQL local preservado; migration 008 aplicada sem reescrever tabelas antigas. Typecheck Svelte/TS sem erros/avisos; build Vite aprovado.
- `npm test`: **65 testes aprovados, 798 assertions, 0 falhas**, regressões M0–M3 e M4. Testes econômicos independentes conferem centavos/percentuais, grandes produtos BigInt, arredondamento/zero/negativos inválidos, dados incompletos e moedas incompatíveis.
- Preço fechado sintético: incorrido 19.400, ETC 72.600, EAC 242.000 e margem projetada 758.000 centavos BRL; realizado relevante 79.400/margem 320.600 sobre reconhecido 400.000. Restante maior muda EAC para 328.400 e margem para 671.600, sem alterar realizado ou snapshot anterior.
- Retainer sintético: outubro com 600 minutos + 120 de rollover validado, 780 aprovados → saldo −60, excedente 60, receita projetada 106.000, EAC 109.500 e margem −3500 centavos. Competência seguinte não herda horas/receita implicitamente; excesso de rollover recusado.
- PostgreSQL real: concorrência/replay de horas e decisões, mudança de taxa por vigência/revisão sem reprecificar linhas antigas, confidencialidade de PO/dev e organização externa, ausência de taxa/configuração/estimativa, contrato encerrado/escopo pendente sem autoridade automática, falha tardia de auditoria com rollback integral e limites de capacidade/data/duração.
- Backup AES-GCM com pg_dump/pg_restore oficial real em banco descartável preservou economic_records/decisions, time_entries/events e economic_reports/events não vazios. Todos os inputs restaurados foram recalculados exatamente e os hashes canônicos conferidos. Upgrade M3→M4 preserva escopo/decisão comercial e não cria valores financeiros automáticos.
- Playwright: **4 cenários aprovados**, M0/M1, M2, M3 e M4. Gestor prepara premissas explícitas, admin aprova, PO estima, desenvolvedor registra 120 minutos sem acesso a custos, gestor aprova/observa EAC/margem/risco/fontes e reload persiste. Screenshot sintético ignorado `test-results/m4-economics.png`.
- Uma execução conjunta de browser encontrou 429 após acumular sessões/requisições dos quatro marcos no mesmo peer. Limite maior foi aplicado **somente no harness de testes**; produção e testes negativos de rate limiting permanecem intactos. Reexecução sequencial completa aprovada. Erros de revisão/calendário detectados durante desenvolvimento foram corrigidos sem remover checks.

CI **Validate M4 aprovado** no [run 41299049760](https://github.com/marcelotaparelli/catus-os/actions/runs/41299049760), commit `46d880c`, confirmado pela página pública como `Success` / `completed successfully`. Novas suítes incluídas e todos os checks anteriores preservados. `npm run format:check`, `git diff --check` e `npm audit --omit=dev` também aprovados (0 vulnerabilidades de runtime reportadas). Guia completo, fórmulas, exemplos e checklist em docs/ECONOMICS.md.

### Bloqueios e limites

Não houve uso de credenciais/valores reais, login Google real, inferência externa ou envio econômico a terceiros. Homologação Google/LLM e operação corporativa seguem pendentes do proprietário; não bloqueiam os testes sintéticos autorizados. Cálculo é gerencial proporcional, não contabilidade/fiscal/câmbio/caixa. Certificações de completude e reconciliação de rollover após correções exigem gestor; observações preservadas não se atualizam silenciosamente. Termos concorrentes no mesmo projeto/período, alocações temporais parciais e regras fiscais específicas exigem modelo aprovado futuro. M4 prepara referências para política M5, sem declarar elegibilidade automática ou iniciar agentes. Sem merge/deploy.

---

## M3 — Issue #1: escopos, contratos e change requests · 01/11/2026

Baseline M2 `cf34cbcfce8c3f516cfe968b730917f23b1fd692` confirmado local/remoto. Árvore inicial limpa; branch própria `feat/m3-scope-contracts`, sem reescrita de histórico/main/default/merge/deploy. Issue pública #1 lida integralmente, assim como contexto técnico e guias M1/M2. Skill cloud-environment-runtime aplicada; ambiente sem secrets/identidades externas, política restrita preservada.

### Implementado

- Migrations incrementais 006/007, sem alterar 001–005: contratos com cliente/projeto, tipo explícito fixed_price/retainer, moeda, vigência UTC, estado e referência documental; nenhum valor inferido. Termos ativados imutáveis, ativação/encerramento por gestor/admin.
- Escopos versionados por projeto, draft/submitted/approved/rejected/superseded; itens com entregáveis/exclusões/aceite/dependências e origem de atendimento/demanda, com FKs/validação de projeto/tenant. Conteúdo submetido congelado também em SQL; cópias usam IDs novos e preservam história.
- Alçada explícita por organização configurável apenas por admin, limitada a gestor/admin; negar decisão sem política. Autor/editores/submissor, inclusive herdados de cópias, não decidem o próprio trabalho. Decisão guarda ator/papel/data/revisão/política/justificativa.
- Change request copia versão aprovada para rascunho, motivo/impacto descritivo; decisão independente e transacional. Aprovação substitui versão anterior preservando conteúdo/decisão; rejeição conserva a base aprovada.
- Cobertura humana explícita de demanda por item aprovado e contrato vigente, sem mudança de estado/responsável M0. Mission Control distingue coberta/pendente mesmo em ready; versão substituída/contrato encerrado ou expirado exige revisão dos vínculos, nunca remapeamento automático.
- UI de cadastro/ativação/encerramento de contratos, política, itens/versões, submissão/revisão/decisão, change requests, cobertura e histórico. API de edição de termos draft disponível. Eventos before/after e auditoria atômicos; versões/409, locks por projeto e idempotência em criações/decisões/submissões/cobertura.
- Privilégios SQL mínimos preservados: worker M2/maintenance sem acesso M3, runtime sem alteração de decisões/eventos; LLM não pode criar/decidir contratos/escopos. CommercialBasis fornece referência versionada para futuro M4, sem economia implementada.

### Evidências e correções

- PostgreSQL local preservado foi reiniciado após confirmar postmaster zombie e arquivar locks obsoletos, sem remover dados. `db:roles`, `migrate`, `test:db` aprovados; migrations 006/007 aplicadas e repetíveis.
- `npm run check`: Svelte/TypeScript sem erros/avisos; `npm run build`: bundle gerado. Suíte completa com **49 testes aprovados, 537 assertions, 0 falhas**, incluindo regressões M0–M2 e testes M3. `npm run format:check`, `git diff --check` e `npm audit --omit=dev` aprovados (0 vulnerabilidades de runtime reportadas). CI **Validate M3 aprovado** no [run 41294130810](https://github.com/marcelotaparelli/catus-os/actions/runs/41294130810), commit `1125081`, confirmado pela página pública como `Success` / `completed successfully`. Todos os checks anteriores foram preservados, com novas suítes M3 incluídas. A implementação está publicada na branch própria; nenhum sucesso remoto M2 foi usado como prova M3.
- Playwright: **3 testes aprovados**, M3 PO/admin/gestor/organização externa, M2 reunião → duas demandas aprovadas/uma rejeitada, M0/M1 sessão/desenvolvedor/logout/tenant. M3 demonstra V1 aprovada, demanda coberta e descoberta, change request V2 sem efeito antes de decisão, V1 preservada após substituição, vínculo revisado explicitamente e reload/viewport estreito. Screenshot `test-results/m3-scope-contracts.png` é sintético, ignorado no Git.
- Testes PostgreSQL: concorrência de dois gestores cria somente uma decisão, negativa de autoaprovação/PO/dev/alçada ausente, autoria/competência, origens e links cross-tenant/cross-project, vigência e termos imutáveis, versões desatualizadas, retries idempotentes e falha tardia de auditoria com rollback de estado/decisão/chave. Upgrade M2→M3 conserva demandas, auditoria e jobs; backup/restore real compara também entidades/histórico comerciais sintéticos.
- Uma falha real nos testes mostrou que cópias inicialmente não herdavam preparadores; corrigido e coberto por regressão. Seletores browser e limites de login do harness adequados aos novos usuários (limites de produção e testes negativos mantidos). Uma execução API/browser simultânea interferiu no banco compartilhado; descartada e repetida sequencialmente com sucesso.

### Bloqueios externos e limites

Sem credenciais Google/LLM legítimas ou autorização de egress do provedor: não houve login Google real, inferência externa ou envio de clientes a terceiros. Harness OIDC/LLM simulado exclusivamente nos testes, sem bypass no app normal. Homologação corporativa continua pendente do proprietário, sem bloquear o desenvolvimento sintético autorizado. Contrato é registro documental interno, não assinatura eletrônica; política M3 por papel, sem limiar financeiro. Paginação/retenção e RLS adicionais ficam no backlog. Nenhum M4/financeiro/agente/Chat/Meet/merge/deploy/produção iniciado. Guia reproduzível: docs/SCOPE_CONTRACTS.md.

---

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

CI **Validate M2 aprovado** no [run 41239116737](https://github.com/marcelotaparelli/catus-os/actions/runs/41239116737), commit `da5a6e3`, confirmado na página pública como `Success` / `completed successfully`. Preservados todos os checks anteriores, com novas suítes incluídas. `npm run format:check`, `git diff --check` e `npm audit --omit=dev` também aprovados localmente (0 vulnerabilidades de runtime reportadas). CI M1.1 não foi usado como prova M2.

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
