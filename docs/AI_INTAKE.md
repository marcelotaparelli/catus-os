# M2 — Atendimento inteligente e revisão humana

## Contrato de segurança

O PO registra conversas, reuniões, atendimentos ou observações manualmente. A IA extrai propostas não aprovadas; só uma operação autenticada de confirmação humana cria demandas. Nenhuma extração aprova escopo/contrato, agenda trabalho de engenharia ou executa ferramentas. Sem Chat/Meet, motor financeiro ou agentes de desenvolvimento.

A aplicação normal **não contém mocks nem resultados de demonstração**. O adaptador faz HTTPS real pelo protocolo OpenAI-compatible Chat Completions, com JSON Schema estrito. Sem chave/configuração/política, `GET /api/extraction` indica indisponibilidade e novos jobs são recusados. Todos os fixtures OIDC/LLM ficam em testes. Esta entrega não fez chamadas ao provedor externo: não há credenciais de teste legitimamente disponíveis no ambiente.

## Instalação incremental

Preservar `.env` e dados M0/M1. Com PostgreSQL ativo:

```sh
npm ci
npm run db:roles
npm run migrate
npm run test:db
npm run check
npm run build
```

`db:roles` adiciona a quarta conta `catus_aiworker` ao arquivo privado `.local/database.env`, mantendo senhas existentes. O arquivo não entra no Git. Migration 004 adiciona políticas, orçamento de IA, jobs, propostas e revisões, além de links de rastreabilidade nas demandas. Migration 005 amplia tipos de contexto, preservando `meeting` e `service` antigos. Nenhuma tabela/dado M0/M1 é removido.

- **Runtime:** enfileira e lê jobs, edita propostas, grava revisões e cria demandas com sessão/autorização/CSRF; não muda o estado dos jobs.
- **AI worker:** lê jobs/política/identidade e atualiza execução/orçamento; insere somente os campos permitidos das propostas; não pode INSERT em requests nem UPDATE no estado de proposta/revisões/membros.
- **Migrator:** aplica schema/grants. **Maintenance:** continua só com dados transitórios M1.1; não apaga histórico de IA.

Launchers isolam URLs de banco: web não recebe URL do AI worker; worker não recebe URLs administrativas/runtime/migrations/manutenção. O worker verifica seus privilégios ao iniciar. Em host compartilhado, usar contas de SO/arquivos de segredos separados conforme `docs/HOMOLOGATION.md` — processos do mesmo usuário de SO não têm isolamento de arquivos garantido.

## Configuração do provedor real — proprietário

Configurar os valores em ambiente/arquivo privado, nunca no repositório ou chat:

| Variável                                                   | Exigência                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `LLM_ENABLED`                                              | `true` para habilitar o adaptador                                                                       |
| `LLM_API_KEY`                                              | Chave legítima de teste, fornecida de forma segura; não logada/armazenada nos jobs                      |
| `LLM_BASE_URL`                                             | Base HTTPS do endpoint compatível, por exemplo `https://api.openai.com/v1`; sem userinfo/query/fragment |
| `LLM_MODEL`                                                | Modelo de teste com suporte a `response_format: json_schema` e `max_completion_tokens`                  |
| `LLM_DATA_POLICY_ID`                                       | Referência da política operacional que autoriza o uso do provedor                                       |
| `LLM_INPUT_USD_PER_MILLION` / `LLM_OUTPUT_USD_PER_MILLION` | Preços positivos e explícitos do modelo, até 6 casas; não há cotação inventada/automática               |
| `LLM_MAX_INPUT_TOKENS`                                     | Default 16000, máximo 32000; ver limite conservador abaixo                                              |
| `LLM_MAX_OUTPUT_TOKENS`                                    | Default 4096, máximo 8192                                                                               |
| `LLM_TIMEOUT_MS`                                           | Default 20000, máximo 60000                                                                             |
| `LLM_CLIENT_DATA_ALLOWED`                                  | Default false; true é necessário, mas não suficiente, para dados reais autorizados                      |

O proprietário precisa permitir o hostname exato na política de egress, preservando os demais destinos e o proxy/TLS. `api.openai.com` não estava permitido nesta sessão e não foi contatado. Não desabilitar TLS, extrair tokens injetados ou trocar destinos para contornar política. O endpoint nunca vem do frontend ou do texto do atendimento. Redirects do provedor são recusados.

```sh
npm run ai:check
npm run start
# Em outra sessão protegida, com configuração LLM e somente sua URL de banco:
npm run ai:worker
```

`ai:check` é **offline**. Código 2 significa indisponível/inválido; sucesso confirma somente configuração, não segredo válido, acesso de rede ou inferência. A opção `npm run ai:worker -- --once` executa um ciclo e termina. O worker não faz HTTP externo se o provedor estiver indisponível; pode apenas finalizar tentativas antigas interrompidas. Sem worker ativo, jobs ficam explicitamente na fila. Não há worker distribuído oculto nem serviço de fila externo.

O runtime e o worker devem receber a mesma configuração de modelo/limites/preços/política; somente a chave pode ser rotacionada sem invalidar jobs. O runtime usa a configuração para capability/reserva; a chamada HTTP ocorre somente no worker. Alterações de endpoint/modelo/prompt/limites/preços invalidam um job enfileirado em vez de enviá-lo silenciosamente a outro destino.

## Política da organização e envio de dados

Administrador registra uma política por organização: `enabled`, referência, classificação máxima (`synthetic` ou `authorized_client`), orçamento diário, orçamento por job e limite diário de jobs. A UI oferece habilitação inicial **apenas para sintéticos**, USD 1/dia, USD 0,10/job e 20 jobs/dia. São limites administrativos, não estimativas de custo do modelo. A API permite configurar limites dentro dos máximos documentados no schema; não permite a PO/dev conceder privilégios.

API de política, em sessão de administrador: `POST /api/ai/policy`, JSON:

```json
{
  "enabled": true,
  "policy_reference": "POLITICA-SINTETICOS-HOMOLOGACAO-01",
  "data_scope": "synthetic",
  "daily_budget_micro_usd": 1000000,
  "per_job_budget_micro_usd": 100000,
  "daily_job_limit": 20
}
```

Usar o CSRF da sessão como nas demais escritas; não registrar cookies/tokens em tickets. Para desabilitar, enviar a política com `enabled:false`. Ações são auditadas individualmente.

Dados reais exigem simultaneamente: política do ambiente aprovada, `LLM_CLIENT_DATA_ALLOWED=true`, política da organização `authorized_client` com referência de autorização e confirmação explícita do PO no envio. Classificação é uma declaração humana, **não um detector de PII**. Não habilitar isso sem política/consentimento, termos do provedor, retenção e aprovação do proprietário. Nenhum dado real foi enviado nesta entrega. O modelo recebe somente a fotografia do texto desse atendimento; não recebe listas de clientes, outros projetos, papéis, sessões, chaves ou candidatos a duplicidade.

## Extração, evidências e revisão

Resposta estruturada versionada: resumo, requisitos, decisões, compromissos, informações ausentes, perguntas e até 8 propostas, cada uma com descrição, evidências e até 8 critérios sugeridos. Fatos/propostas/critérios exigem citações literais encontradas no texto. O servidor calcula offsets UTF-16 `[start,end)` e guarda texto/hash originais. Campos extras, IDs/estado/atribuição/autoridade sugeridos pelo modelo, evidências ausentes/inventadas, ferramentas, truncamento e respostas excessivas são recusados. Não aceitar Markdown como JSON implicitamente.

O prompt separa instrução do sistema e JSON `untrusted_source`; instruções na conversa são dados. O adaptador não oferece ferramentas, execução, navegação de URLs de origem ou autoridade de usuário. Ainda assim, **quote exata não comprova que uma paráfrase é semanticamente fiel**. A UI mantém tudo como sugestão não aprovada e exige que o PO confira a correspondência e corrija alucinações/omissões. Não alegamos eliminar semanticamente toda alucinação por validação estrutural.

O resultado original da IA é imutável no job. Edição humana altera a proposta corrente e grava snapshots antes/depois, ator, horário e versão; a evidência original e o resultado original permanecem. Texto editado pelo PO é autoria humana registrada, não uma nova inferência. Rejeitar não cria request. Aprovar em lote exige confirmação explícita, versões atuais, responsáveis ativos da mesma organização e próxima ação; a transação cria somente as selecionadas, liga request↔proposta e grava auditoria/revisões. Qualquer falha desfaz o lote todo. Retry com a mesma Idempotency-Key retorna os mesmos IDs; estados decididos impedem nova criação mesmo após expiração do cache idempotente.

Duplicidades são **heurísticas locais**: título normalizado igual ou sobreposição lexical alta entre até 500 candidatos do mesmo projeto/organização. Recalculadas na leitura/aprovação, sem enviar o catálogo ao LLM. Não detectam toda duplicidade semântica, não fundem/excluem demandas e não decidem aprovação. Candidatos encontrados exigem confirmação adicional; atualizar a extração e revisar os IDs antes de confirmar.

## Fila, falhas e orçamento

Enfileiramento retorna 202 e é idempotente por organização/usuário/chave. Um único job ativo por atendimento. Worker usa `FOR UPDATE SKIP LOCKED`, commit do claim antes do HTTP e lease de 90s; requisições do PO não aguardam inferência. Uma tentativa por job, sem retries HTTP automáticos. Jobs presos após crash tornam-se falhos e não são reenviados: cobrança ambígua não autoriza duplicar chamada. Nova tentativa manual exige novo job e nova reserva.

Reservas usam o máximo de tokens configurado e preços declarados em micros de USD. São serializadas por organização antes de enfileirar; limites diários de custo/jobs e por job são persistidos. Datas de orçamento são UTC. Jobs de dias anteriores expiram sem envio; orçamento reduzido, política removida, usuário revogado ou configuração divergente impedem envio. A política/identidade é conferida também após o retorno; revogação não consegue recolher dados de uma chamada já iniciada, mas bloqueia publicar propostas dessa execução.

A entrada é limitada por bytes UTF-8 do payload com margem (upper bound conservador para tokenização compatível) e não é truncada silenciosamente. Saída máxima de 128 KiB, tokens de saída e deadline são limitados. O orçamento é **estimado**, não uma garantia de fatura: depende de tarifas corretas/modelo compatível e do comportamento do provedor. Configure também teto de gastos no provedor. Uma mudança de preço fora do sistema não é automaticamente conhecida.

Quando usage é válido, registrar tokens/latência/custo estimado, inclusive falhas de estrutura quando a medição foi recebida. Sem usage ou após crash/timeout ambíguo, custo estimado fica nulo e o controle diário consome conservadoramente a reserva. Isso não é apresentado como custo real. Jobs recusados antes de enviar consomem zero dinheiro, mas contam para limite de tentativas/jobs. Histórico da IA não é apagado pelo worker de retenção M1.1; política de retenção/redação é responsabilidade operacional pendente.

Restore M1.1 foi ampliado: jobs queued/running restaurados ficam `failed/restored_requires_review`, e suas reservas são tratadas conservadoramente; não há reenvio automático ao ligar worker após restore. Reaplicar migrations/grants do ambiente antes de reiniciar workers. Históricos concluídos e revisões são preservados.

## Rotas M2

Todas exigem sessão, tenant do servidor e papel PO/gestor/admin, salvo atualização de política que exige admin. Desenvolvedor não processa nem aprova propostas.

| Método | Rota                           | Resultado                                                                                                                         |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/extraction`              | Capability atual e política da organização, sem segredo                                                                           |
| POST   | `/api/ai/policy`               | Política administrativa auditada                                                                                                  |
| POST   | `/api/extractions`             | `{interaction_id,data_scope,confirm_external_processing:true}`, Idempotency-Key UUID, 202                                         |
| GET    | `/api/extractions`             | Até 100 execuções recentes da organização                                                                                         |
| GET    | `/api/extractions/:id`         | Snapshot, resultado, propostas e histórico de revisões                                                                            |
| PATCH  | `/api/proposals/:id`           | `{action:'edited',version,title,description,acceptance_criteria:string[]}` ou `{action:'rejected',version}`                       |
| POST   | `/api/extractions/:id/approve` | Confirmação humana, até 8 `{id,version,owner_user_id,next_action}`, confirmação de duplicidades quando aplicável, Idempotency-Key |

## Demonstração reproduzível e aceite com provedor real

```sh
npm run test:db
npm run check
npm run build
# Pré-requisitos de TLS e Docker/pg_dump descritos em HOMOLOGATION.md
npm test
CHROMIUM_PATH=/tmp/chromium npm run test:e2e # neste ambiente; Chromium instalado pode ser usado sem a variável
```

O teste Playwright `intelligent-intake.spec.ts` autentica PO em harness test-only, cadastra cliente/projeto/reunião sintéticos, usa o **adaptador HTTP real com transporte LLM mock de teste**, obtém três propostas, edita uma, rejeita uma, aprova duas e confere somente duas demandas com responsável/ação/proveniência no Mission Control, inclusive após reload. Screenshot em `test-results/m2-human-reviewed.png` (ignorado pelo Git). Testes não provam qualidade semântica ou compatibilidade de uma conta/modelo real.

Para aceite externo legítimo: proprietário configura chave/modelo/preços de teste, egress e política sintética; login real conforme M1; iniciar runtime e worker; repetir exatamente o cenário com texto sintético (sem dados de clientes), conferir quotes, decisões/perguntas, IDs das duas demandas e ausência da terceira, revisar histórico e comparar usage/preço com metadados do provedor. Registrar SHA/modelo/prompt/latência/tokens/estimativa e IDs, nunca segredo/cookie. Não forçar que um modelo real gere exatamente três propostas: revisar a resposta, reformular o caso sintético ou documentar divergência; não adulterar resultado como se fosse inferência real.

Sem credenciais legítimas, não executar inferência real nem fabricar seu resultado. O código deste marco pode ser validado automaticamente; aceite com provedor real permanece pendente do proprietário. Sem merge, deploy, Google Chat/Meet, escopo/contratos, motor financeiro ou execução agêntica.
