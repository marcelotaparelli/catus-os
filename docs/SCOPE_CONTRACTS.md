# M3 — Contratos, escopos e aprovação comercial

Implementação da [issue #1](https://github.com/marcelotaparelli/catus-os/issues/1), a partir de `cf34cbc`, em `feat/m3-scope-contracts`. Referências M0–M2 e migrations 001–005 preservadas. Este módulo registra autorizações humanas e documentos externos; não assina contratos, não consulta referências documentais e não processa valores financeiros.

## Instalação e testes reproduzíveis

Com `.env` privado e PostgreSQL loopback conforme README/HOMOLOGATION:

```sh
npm ci
# Terminal separado, se o PostgreSQL local não estiver ativo:
npm run db
# Outros comandos, após banco disponível:
npm run db:roles
npm run migrate
npm run test:db
npm run check
npm run build
npm run tls:local
npm test
npm run format:check
# Chromium oficial, quando não instalado:
npx playwright install --with-deps chromium
npm run test:e2e
```

Neste ambiente o browser instalado usa `CHROMIUM_PATH=/tmp/chromium npm run test:e2e`. APIs e Playwright compartilham o banco descartável `_test`: executar **sequencialmente**, nunca simultaneamente. As suítes comerciais e de operação criam bancos/roles descartáveis próprios com UUIDs e removem ao terminar. Testes de backup exigem Docker local e imagem PostgreSQL fixada no guia de homologação. Não mudar URLs para produção ou remover guardas de banco.

Migrations 006/007 adicionam entidades, índices, FKs compostas e proteções de imutabilidade. `requests.scope_item_id` nasce nulo; não há associação retroativa, mudança de status, exclusão ou atribuição comercial inferida para dados existentes. Teste de upgrade popula schema M2, aplica M3 e compara conteúdo de demandas, auditoria e histórico de IA. Repetir `migrate` usa o registro transacional de migrations e advisory lock.

`db:roles`/`migrate` reaplicam grants sem trocar senhas: runtime lê/escreve somente tabelas/colunas necessárias; decisões/eventos/contribuidores são append-only para runtime, itens só inseridos/removidos em rascunho. Maintenance não lê as tabelas M3; AI worker não tem grants nelas nem pode alterar cobertura de requests. SQL tem constraints tenant/projeto/origem e triggers de imutabilidade; autorização de usuário continua no servidor. RLS permanece fora do marco, como documentado no M1.

## Modelo e regras

### Contratos

Um contrato pertence a **um projeto e seu cliente na mesma organização**. Campos obrigatórios: título, tipo `fixed_price` (projeto de preço fechado) ou `retainer` (retainer/banco de horas), moeda, vigência inicial/final inclusivas em datas UTC e referência documental textual. Moedas suportadas explicitamente: BRL, USD, EUR, GBP, CAD, AUD, JPY, CHF, ARS, CLP, MXN. Outras podem ser acrescentadas sem alterar dados; não há conversão ou cotação.

Criado como `draft`. PO/gestor/admin podem cadastrar/editar termos em rascunho; somente gestor/admin registra `active` ou `closed`, após conferir o documento externo. Isso é registro da situação documental, não assinatura eletrônica ou inferência de concordância do cliente. Transições: draft → active/closed; active → closed. Após ativação, termos são imutáveis; alteração contratual exige cadastrar outro contrato e selecionar sua referência em nova versão de escopo. Encerramento é final. Nenhum campo de valor/hora/taxa é aceito; dados econômicos aguardam M4.

API de edição de termos existe em PATCH; UI mínima permite cadastro, ativação e encerramento. Referência é texto escapado; não é URL visitada, anexo, upload ou segredo. Não usar dados/documentos reais na homologação deste marco.

### Escopos e itens

Uma série por projeto, com números monotônicos. Até uma versão draft/submitted e uma approved por projeto, garantidas por índices únicos. Inicial é V1. Estados: `draft → submitted → approved/rejected`; approved → superseded somente quando outra versão do mesmo projeto é aprovada. Conteúdo submetido e itens tornam-se imutáveis também no PostgreSQL; rejeição não libera edição retroativa. Cada item exige descrição, entregáveis, exclusões, critérios de aceite, dependências (declarar explicitamente “nenhuma declarada” quando aplicável) e origem: atendimento e/ou demanda, ambos do mesmo projeto. Se ambos fornecidos, a demanda deve vir daquele atendimento. Origem de demanda M2 mantém a cadeia até proposta/job/texto original.

Editar rascunho exige a revisão atual (`version`) e substitui seus itens; IDs de itens do rascunho podem mudar, pois ainda não têm cobertura. Na submissão a versão é congelada. Revisão de escopo inicial rejeitado cria versão nova, copia conteúdo e contribuidores e preserva a rejeição anterior. Versão aprovada só evolui por change request. A numeração comercial (`number`, V1/V2) e o contador concorrente (`version`) têm funções distintas.

### Alçadas e segregação de funções

**Sem política explícita da organização, negar qualquer decisão.** Administrador configura `approval_roles` com `manager`, `administrator`, ou ambos. PO e desenvolvedor nunca podem configurar política nem conceder autoridade por payload. A política tem versão e histórico; alterações antigas não reescrevem decisões tomadas.

Para aprovar **ou rejeitar**, exigir simultaneamente: papel atual manager/admin admitido pela política, versão submetida atual, justificativa e usuário não envolvido em sua preparação. Autor, editores e submissor são registrados em `scope_contributors`. Versões copiadas herdam todos esses contribuidores: copiar/submeter por outra pessoa não apaga participação nem permite autoaprovação. Essa regra conservadora pode exigir um segundo gestor/admin não participante. Um único administrador não consegue aprovar escopo que preparou; não existe override oculto.

Aprovação exige contrato active e vigente em UTC. Rejeição pode registrar problema documental mesmo se contrato expirou. Decisão guarda ator, papel, revisão submetida, data, justificativa e snapshot de alçada/versão da política. Ela prova a autorização **interna** registrada; confirmação/assinatura do cliente continua no documento externo. Desenvolvedor lê contratos/escopos da própria organização, mas não prepara, decide nem altera cobertura.

### Change requests

PO/gestor/admin abre a partir da versão atualmente aprovada, informando motivo e impacto **descritivo**. Cria novo registro e nova versão draft com cópia de itens e contribuidores, IDs novos e referência à base. O PO edita essa versão e submete; nenhum efeito comercial ocorre antes da decisão independente.

Se aprovado: antiga approved passa a superseded, nova submitted vira approved, change request muda para approved e todos os eventos/decisão são gravados na mesma transação. Se rejeitado: base continua aprovada, proposta é congelada como rejeitada e change request recebe rejected. Para tentar de novo, abrir novo change request a partir da versão atualmente aprovada; não usar revisão simples da change request rejeitada. Uma versão pendente por projeto evita ramos concorrentes ambíguos.

### Cobertura comercial da demanda

Vínculo explícito humano `request.scope_item_id`, com revisão da demanda e auditoria de antes/depois. Só aceitar item da versão atualmente aprovada, contrato ativo/vigente e **mesmo projeto/organização** da demanda. Nenhum vínculo é inferido de similaridade, origem, status M0 ou aprovação M2. Vínculo pode ser removido com null.

Mission Control calcula `commercial_coverage`:

- `covered`: vínculo satisfaz versão aprovada, contrato ativo e vigência UTC.
- `pending_analysis`: sem vínculo ou versão substituída/contrato encerrado/expirado.

Quando V2 substitui V1, vínculos V1 e suas evidências são preservados, mas tornam-se pendentes. Revisar/revincular explicitamente aos itens V2. Não há migração automática de cobertura, mesmo quando o texto dos itens é igual. Expiração/encerramento também retiram a cobertura efetiva sem reescrever demandas. Estado operacional e responsável são preservados; `ready` nunca representa aceite comercial, e M3 não introduz bloqueio retroativo no workflow M0.

## Transações, concorrência e auditoria

Todas as escritas acontecem no Context autenticado M1, sessão/tenant obtidos no servidor, CSRF e origem exata. Campos desconhecidos/identidade/autoridade são recusados. Payload JSON até 32 KiB; até 20 itens, textos limitados. Leituras do painel comercial usam um snapshot SQL com joins filtrados por organização. Usuários externos não podem ler/associar/alterar objetos de outra organização.

Criações de contrato/escopo/change request, submissões, revisões, decisões e cobertura exigem UUID `Idempotency-Key`, com hash canônico e resposta persistidos junto à alteração. Replay exige sessão/papel atuais e, para decisão, alçada atual e ausência de contribuição; payload diferente retorna 409. Cache tem TTL 24h do M1.1; após expirar, conferir o histórico e usar chave nova. Uniques e estado final impedem aprovação duplicada depois da janela. PATCH usa `version` e retorna 409 em replay desatualizado; não promete replay de resposta para edição.

Advisory lock por organização/projeto serializa numeração, preparação e decisões. Locks de linha/versão e decisão única por scope evitam decisões concorrentes duplicadas; lock de contrato/política estabiliza competência e vigência durante a aprovação. Vínculos de cobertura usam locks de escopo/contrato, serializando com substituição e encerramento. Eventos comerciais append-only contêm autor/papel, entidade, ação, antes/depois; evento M1 é escrito na mesma transação. Erro tardio em auditoria desfaz decisão, estado, change request, cobertura e chave idempotente. Teste injeta falha somente no banco descartável e verifica rollback antes de tentar novamente.

Backup/restore M1.1 continua abrangendo todo schema/dados; suíte compara também contratos, versões, itens, contribuidores, decisões, políticas, change requests e eventos. Sessões/cache e jobs M2 continuam invalidados conforme M1.1/M2; aprovação histórica não é reenviada nem recriada no restore.

## API

Rotas abaixo exigem sessão; POST/PATCH exigem CSRF. Membros sem permissão recebem 403; IDs de outra organização retornam inexistência. Endpoints não recebem organização/ator/papel do frontend.

| Método | Rota                         | Operação                                                                                                                                                         |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/commercial`            | Contratos, versões/itens/decisões, change requests, política e últimos 200 eventos da organização                                                                |
| POST   | `/api/commercial/policy`     | Admin: `{version:0,approval_roles:['manager','administrator']}` inicial; version atual nas alterações                                                            |
| POST   | `/api/contracts`             | PO/gestor/admin: `{project_id,client_id,title,kind,currency,valid_from,valid_until,document_reference}`                                                          |
| PATCH  | `/api/contracts/:id`         | `{version,...termos}` enquanto draft; `{version,state:'active'/'closed'}` exige gestor/admin                                                                     |
| POST   | `/api/scopes`                | Inicial: `{project_id,contract_id,title,items:[{description,deliverables,exclusions,acceptance_criteria,dependencies,origin_interaction_id,origin_request_id}]}` |
| PATCH  | `/api/scopes/:id`            | Rascunho: `{version,contract_id,title,items}`                                                                                                                    |
| POST   | `/api/scopes/:id/submit`     | `{version}`                                                                                                                                                      |
| POST   | `/api/scopes/:id/decide`     | Gestor/admin com alçada e independente: `{version,decision:'approved'/'rejected',reason}`                                                                        |
| POST   | `/api/scopes/:id/revisions`  | `{version}` para rejeição de escopo inicial; cria cópia com nova numeração                                                                                       |
| POST   | `/api/change-requests`       | `{base_scope_id,version,reason,impact}`; devolve change request e `scope` draft                                                                                  |
| POST   | `/api/requests/:id/coverage` | `{version,scope_item_id:UUID/null}`; não muda status operacional                                                                                                 |

Nenhuma rota M2 aceita comandos de alteração comercial; seu worker PostgreSQL não tem acesso às tabelas M3. Aprovar proposta M2 cria apenas demanda operacional descoberta, nunca escopo/contrato.

## Checklist de homologação sintética

1. Aplicar setup acima. Preparar três contas convidadas: **A PO**, **B gestor independente**, **C admin**, mais usuário da **organização B**. Sem OIDC real, rodar exclusivamente o harness dos testes; aplicação normal permanece sem login se OIDC não configurado.
2. C configura alçadas pela UI, permitindo gestor/admin. Sem essa ação, B tenta decidir e deve receber 403 sem decisão/evento de sucesso.
3. A cadastra cliente, projeto e reunião **sintéticos**, contrato com referência fictícia, moeda e vigência corrente. Contrato nasce draft. B confere a referência e registra active; A não pode ativar.
4. A prepara V1 com itens, entregáveis/exclusões/aceite/dependências e atendimento/demanda de origem. Submete. Tentativa de editar após submissão deve falhar; tentativa A decidir retorna 403. B decide com justificativa. Conferir decisão, data, ator, competência e snapshot de política.
5. A registra duas demandas, associa uma a item V1 aprovado e deixa outra sem cobertura. Mission Control deve distinguir “Cobertura comercial aprovada” e “Pendente de análise comercial”, mesmo se a segunda estiver operacionalmente ready. Confirmar responsável/ação preservados.
6. A abre change request com motivo/impacto; V2 nasce draft e V1 não muda. Edita e submete V2. A segunda demanda continua pendente, V1 ainda cobre a primeira. B aprova V2; V1 torna-se substituída com conteúdo/decisão intactos. Vínculos antigos ficam pendentes; A deve revisá-los explicitamente. Repetir com rejeição em projeto separado: base permanece aprovada.
7. Gestor que editou/preparou uma versão (inclusive por herança de cópia) tenta decidir e recebe 403; outro gestor/admin independente deve decidir. Não elevar papel do PO para contornar.
8. Rodar os testes de concorrência: duas decisões simultâneas geram uma decisão, uma falha 409, uma transição e um evento de sucesso. Retry de mesma chave retorna a mesma resposta. Testes de falha de auditoria devem comprovar rollback integral.
9. Usuário da organização B não vê os contratos, versões, change requests ou demandas da A; IDs conhecidos não permitem alteração/associação. Desenvolvedor não cria contrato/escopo nem atribui cobertura.
10. Reload preserva cobertura/histórico. Encerrar contrato ou atingir fim da vigência retira cobertura efetiva, preservando IDs e estado operacional. Backup/restore deve preservar conteúdo e decisões. Não publicar fixtures como clientes reais.

## Evidências e limites para M4

Comandos, números e CI reais em `PROGRESS.md`. Playwright `e2e/commercial.spec.ts` cobre PO/admin/gestor/organização B, V1/V2, cobertura, decisão sem alçada, reload e viewport estreito. Screenshot sintético ignorado em `test-results/m3-scope-contracts.png`. OIDC do harness é simulado apenas em testes; nenhum Google/LLM externo é exercitado por M3. Credenciais/egress reais continuam pendentes do proprietário conforme guias M1/M2, sem bloquear este marco sintético.

`CommercialBasis` em `src/shared/commercial.ts` prepara referências estáveis de contrato/tipo/moeda/vigência, versão e item aprovado para estimativas/apontamentos/taxas/receitas/margens futuras. Eventos preservam quando e por quem cada base foi autorizada; M4 deverá versionar valores/taxas/estimativas e comparar moeda/vigência, sem preencher lacunas com zero ou números inferidos. M3 não armazena nem calcula esses valores. Não há assinatura eletrônica, anexo/upload, aprovação externa automática, motor financeiro, executor de agentes, merge ou deploy.

Limites explícitos: política por papel sem teto monetário (valores inexistentes em M3); uma versão pendente/aprovada por projeto; painel sem paginação de contratos/versões, eventos limitados a 200; cobertura sinaliza análise, não bloqueia fluxo operacional legado. Funções de retenção, RLS e filtros/paginação podem evoluir separadamente. Operação real exige homologação humana, isolamento de SO/segredos e supervisão documentados anteriormente.
