# Plano mestre do MVP

## Objetivo

Transformar contexto manual fornecido pelos POs em trabalho rastreável, escopo controlado e previsibilidade econômica. O produto completo deve melhorar margem por projeto/cliente sem permitir execução de agentes fora de escopo ou sem revisão.

## Marcos e critérios de aceite

| Prioridade / marco                                  | Escopo                                                                | Critério de saída                                                                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 · M0 (entregue)                                  | Stack, módulos, banco, contexto manual, solicitações, Mission Control | Fluxo cliente → projeto → atendimento → solicitação exercitado no navegador, persistente, com estado/responsável/ação; testes reais e documentação                            |
| P0 · M1 (implementado)                              | Identidade e controle de acesso                                       | Usuários/papéis e organização, autorização em cada rota, testes de isolamento e auditoria por ator; requisito para uso compartilhado                                          |
| P1 · M2 (implementado)                              | Extração assistida e triagem                                          | Provedor atrás da porta, propostas com evidência e perguntas, revisão humana antes de criar demanda, testes com fixtures, orçamento e observabilidade de inferência           |
| P1 · M3 (implementado)                              | Escopo, contratos e aprovações                                        | Versões de escopo, critérios de aceite, aprovações explícitas, referência documental segura e vínculo contratual; nenhuma mudança aprovada implicitamente                     |
| P1 · M4 (implementado)                              | Motor econômico e horas                                               | Taxas vigentes, capacidade, estimativas e apontamentos, custos diretos/indiretos, receita contratada, margem prevista e realizada com fórmulas auditáveis                     |
| P2 · M5 (fronteiras validadas; Codex real pendente) | Delegação a agentes de engenharia                                     | Elegibilidade exige escopo aprovado, margem/regra de custo, repositório permitido; jobs idempotentes, ambiente isolado, testes e PR para revisão; sem merge/deploy automático |
| P2 · M6                                             | Gestão e melhoria contínua                                            | Visões operacionais e econômicas com origem/período, bloqueios, lead time, desvios e aprendizado; sem métricas fictícias                                                      |

## Dependências e limites

M1 antecede qualquer piloto compartilhado. M2 usa contexto do M0; M3 pode avançar com entrada manual independentemente do provedor de IA. M4 exige contratos/estimativas versionados do M3. M5 depende das políticas de autorização, escopo e economia. M6 cresce com dados reais coletados pelos marcos anteriores.

Escopo atual não inclui importação de Chat/Meet, faturamento fiscal, múltiplos serviços, automação de produção nem dashboards de margem sem motor econômico. Um marco termina por comportamento validado, não pela existência de arquivos.

## Estratégia de qualidade

Regras puras em Bun; APIs com PostgreSQL real; fluxos centrais no navegador; migrações repetíveis; tipagem estrita e build em cada PR. Usar banco de teste isolado e dados identificados com limpeza; nunca credenciais reais. Mudanças econômicas exigirão testes de arredondamento, vigência, moeda e reprocessamento. Agentes exigirão limites de recursos, evidência de testes e revisão humana.

## Atualização M1

Identidade OIDC configurável, sessões, papéis, organizações, responsáveis vinculados e auditoria individual implementados. A aceitação automatizada está em PROGRESS.md. Login Google real depende de configuração/credenciais de desenvolvimento; CI remoto aprovado no run 41220332080, observado pela página pública apesar da API GitHub bloqueada. Esses impedimentos não autorizam ativar piloto compartilhado. O desenvolvimento M2 foi posteriormente autorizado explicitamente, com dados sintéticos e testes isolados.

## M1.1 — Homologação e hardening

Sem iniciar M2: rate limiting persistente, criação idempotente, contas PostgreSQL separadas, limpeza transiente, HTTPS local e backup/restore criptografado em banco descartável. Checklist real A/B/C em docs/HOMOLOGATION.md; configuração/aceite Google e responsabilidades do proprietário são explicitamente separados dos testes automatizados. Nenhuma main, produção ou exposição pública autorizada.

## Atualização M2

Fluxo de atendimento inteligente implementado: fonte manual, adaptador real configurável, fila PostgreSQL, extração com evidências, duplicidades locais, revisão humana, rejeição e criação transacional/idempotente de demandas com rastreabilidade e métricas limitadas à IA. Demonstração sintética e testes em PROGRESS.md; provedor real depende de credenciais/política/egress legítimos. Nenhum motor financeiro ou agente de desenvolvimento iniciado.

## Atualização M3 — issue #1

Contratos por projeto/cliente, tipos fixo/retainer, moeda/vigência/documento; escopos versionados com itens/origem e conteúdo submetido imutável; política explícita por papel e decisão independente de preparadores; change requests com revisão humana; cobertura comercial explícita no Mission Control. Auditoria com snapshots, concorrência/idempotência, migrations preservando M2 e backup/restore exercitados. Sem valores inferidos, anexos executáveis, finanças ou agentes. O guia `docs/SCOPE_CONTRACTS.md` contém critérios de homologação sintética. M4 depende de autorização futura e deverá versionar estimativas/taxas/receitas/horas com moeda/vigência e fórmulas auditáveis; não foi iniciado.

## Atualização M4 — issue #2

Economia gerencial determinística, termos/premissas/taxas versionados, estimativas/capacidade explícitas, apontamentos/reversões e custo/ETC/EAC/margens com fontes, snapshots e incompletude. Preço fechado e retainer por competência separados; tributos/comissões e rateio declarados, sem dinheiro inventado/câmbio/caixa. UI por papel e consolidação por cliente sem moedas ou competências misturadas; evidências em PROGRESS.md e fórmulas em docs/ECONOMICS.md. M0–M3 preservados. M5 não iniciado; elegibilidade exigirá cobertura vigente, economia completa/atual, política de custo/margem, escopo de repositório e revisão humana.

## Atualização M5 — issue #3

Elegibilidade determinística, política default OFF, orçamento separado USD e fila/outbox PostgreSQL durável; runner próprio isolado, SDK oficial configurável, testes/diff e revisão humana implementados. Fatia sintética real validada do M2 até runner Docker e patch/testes reais; harness de geração determinístico existe somente em testes. Codex real NOT_VERIFIED por falta de credencial/gateway legítimos; PR remoto NOT_CREATED, sem credencial mínima/repo/base configurados para publicação. Não declarar M5 end-to-end de IA aceito com fixture. Guia/ameaças/retomada em docs/AGENTIC_DELIVERY.md. M6 não iniciado e nenhum merge/deploy/produção autorizado.

## Decisão de arquitetura — Catus OS e ClickUp (05/11/2026)

O Catus OS passa a ser o sistema operacional central da agência; os marcos e o histórico acima continuam válidos.

| Quem ou o quê         | Onde                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Sócios                | Trabalham somente no Catus OS                                                                     |
| POs e desenvolvedores | Trabalham somente no ClickUp                                                                      |
| Clientes              | Acesso controlado às informações dos próprios projetos, no futuro                                 |
| Dono no Catus OS      | Contratos, escopos aprovados, decisões comerciais, cronogramas acordados e indicadores econômicos |
| Dono no ClickUp       | Execução: tarefas, subtarefas, responsáveis, status e apontamentos                                |

Cada informação é registrada uma vez e sincronizada automaticamente. A IA entra onde produzir benefício mensurável. Custos, margens e dados gerenciais confidenciais não vão para o ClickUp.

As telas atuais de PO e desenvolvedor continuam funcionando: migrá-las ou removê-las só será avaliado depois da integração provada com dados reais.

### Sequência de marcos

| Marco                             | Escopo                                                                          | Situação                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| M6.1 ClickUp somente leitura      | Tarefas do ClickUp no painel dos sócios, sem escrita e desligado por padrão     | Implementado com dados sintéticos; **não verificado com um workspace real** |
| M6.2 Horas do ClickUp             | Apontamentos entram como pendentes de aprovação, alimentando a margem realizada | Não iniciado                                                                |
| M6.3 Escopo aprovado gera tarefas | Primeira escrita no ClickUp, com webhooks e conferência periódica               | Não iniciado; exige VPS com HTTPS                                           |
| M6.4 Cronograma                   | Marcos acordados, previsto contra realizado                                     | Não iniciado                                                                |
| M6.5 Visão do cliente             | Acompanhamento controlado de entregas, pendências e prazos                      | Não iniciado; forma de acesso a decidir                                     |
| M6.6 IA em solicitações e escopos | Análise de solicitações e escopos detalhados, com revisão humana                | Não iniciado; exige provedor e política de dados                            |

Critérios técnicos do M6.1 e o caminho até o piloto real estão em [docs/CLICKUP.md](docs/CLICKUP.md).

## Dores dos sócios (numeração permanente)

Estes números não são reutilizados nem renumerados. As causas são hipóteses a confirmar com uso real. Nenhuma métrica tem linha de base medida; valores e relatos internos não são registrados neste repositório público.

**Estados possíveis:** não iniciada; parcial; implementada com dados sintéticos; validada com dados reais.

### D01 — Acompanhamento interno dos projetos e visibilidade para os clientes

- **Causa hipotética:** a situação dos projetos fica espalhada e depende de perguntar às pessoas.
- **Solução proposta:** execução do ClickUp no painel dos sócios (M6.1); visão do cliente depois (M6.5).
- **Oportunidades de IA:** resumo periódico do andamento de cada projeto, com revisão humana antes de chegar ao cliente.
- **Prioridade:** P0.
- **Dependências:** workspace do ClickUp, vínculo entre projeto e lista; decisão sobre o acesso do cliente.
- **Métricas:** tempo para responder "como está o projeto"; idade do dado exibido.
- **Critérios de aceite:** totais iguais aos do ClickUp em um projeto real, conferidos pelo proprietário; dado desatualizado sinalizado; cliente vê só os próprios projetos.
- **Estado:** parcial. Visão interna implementada com dados sintéticos; visão do cliente não iniciada.

### D02 — Escopos contratuais ambíguos e perdas financeiras

- **Causa hipotética:** escopos sem itens, exclusões e critérios de aceite explícitos, e trabalho sem vínculo com o que foi contratado.
- **Solução proposta:** escopos versionados e mudança formal (M3, existente); ligação entre item de escopo e tarefas (M6.3).
- **Oportunidades de IA:** apontar ambiguidade e lacunas em minutas de escopo, sem decidir (M6.6).
- **Prioridade:** P1.
- **Dependências:** uso real do M3; vínculo entre escopo e tarefas.
- **Métricas:** parcela do trabalho vinculada a item de escopo; mudanças de escopo registradas por projeto; horas fora de escopo.
- **Critérios de aceite:** todo trabalho cobrado rastreável a uma versão aprovada; mudança só com decisão humana registrada.
- **Estado:** implementada com dados sintéticos no que toca ao M3; ligação com o ClickUp não iniciada.

### D03 — Aprovações problemáticas que provocam retrabalho

- **Causa hipotética:** aprovações informais ou sem registro do que exatamente foi aprovado, e por quem.
- **Solução proposta:** aprovações internas (M3, existente); aprovação do cliente registrada, com as regras do PR #19 quando for definido onde cada ação acontece.
- **Oportunidades de IA:** comparar a entrega com os critérios aprovados e apontar divergências para revisão humana.
- **Prioridade:** P1.
- **Dependências:** número de sócios que aprovam; canal do cliente; decisão sobre o PR #19.
- **Métricas:** retrabalho por demanda; tempo de aprovação; reprovações por critério.
- **Critérios de aceite:** toda aprovação com autor, data e versão; nenhuma aprovação implícita.
- **Estado:** parcial. Aprovação interna implementada com dados sintéticos; aprovação do cliente sem merge.

### D04 — Preenchimento manual de backlogs e levantamento de status

- **Causa hipotética:** a mesma informação é digitada em mais de um lugar, e o status é levantado à mão.
- **Solução proposta:** leitura automática do ClickUp (M6.1); geração de tarefas a partir do escopo aprovado (M6.3).
- **Oportunidades de IA:** decompor um escopo aprovado em tarefas propostas, com revisão humana.
- **Prioridade:** P0.
- **Dependências:** token e estrutura do workspace; mapeamento de status.
- **Métricas:** tempo semanal gasto em levantamento de status; campos digitados em dobro.
- **Critérios de aceite:** status no painel sem digitação no Catus OS; nenhuma tarefa duplicada; falha de sincronização visível.
- **Estado:** parcial. Leitura implementada com dados sintéticos; backlog automático não iniciado.

### D05 — Falta de visibilidade objetiva da rentabilidade por cliente, projeto e empresa

- **Causa hipotética:** custo real desconhecido, porque as horas ficam fora do cálculo ou chegam tarde.
- **Solução proposta:** motor econômico (M4, existente); horas do ClickUp entrando como pendentes de aprovação (M6.2).
- **Oportunidades de IA:** explicar desvios de margem a partir de dados já calculados; a aritmética continua determinística.
- **Prioridade:** P1.
- **Dependências:** termos e taxas reais; acesso às horas de toda a equipe no ClickUp; regra de aprovação de horas.
- **Métricas:** parcela das horas com origem automática; defasagem entre o trabalho e a margem atualizada.
- **Critérios de aceite:** margem por projeto reproduzível a partir das fontes; dado ausente indisponível, nunca zero; nada econômico no ClickUp.
- **Estado:** parcial. Motor implementado com dados sintéticos; horas do ClickUp não entram no cálculo.

### D06 — Cronogramas pouco confiáveis e reclamações recorrentes dos clientes

- **Causa hipotética:** datas prometidas sem ligação com a execução, e atrasos descobertos tarde.
- **Solução proposta:** prazos operacionais visíveis (M6.1); marcos acordados e previsto contra realizado (M6.4).
- **Oportunidades de IA:** alertar sobre risco de atraso com base no histórico, deixando clara a incerteza.
- **Prioridade:** P1.
- **Dependências:** modelo de marcos; prazos preenchidos no ClickUp.
- **Métricas:** marcos cumpridos na data acordada; antecedência com que um atraso é conhecido; parcela de tarefas com prazo.
- **Critérios de aceite:** previsto e realizado lado a lado; nenhuma previsão sem base declarada.
- **Estado:** parcial. Prazos operacionais implementados com dados sintéticos; cronograma contratual não iniciado.

### D07 — Desalinhamento de expectativas, responsabilidades, entregáveis e prazos entre Catus e cliente

- **Causa hipotética:** o combinado não fica registrado em um único lugar visível às duas partes.
- **Solução proposta:** registro do combinado (regras do PR #19) e visão do cliente (M6.5).
- **Oportunidades de IA:** extrair compromissos de atendimentos para confirmação humana (base no M2).
- **Prioridade:** P2, por depender da visão do cliente.
- **Dependências:** forma de acesso do cliente; política de dados.
- **Métricas:** pendências do cliente em aberto e sua idade; divergências registradas sobre o combinado.
- **Critérios de aceite:** cada compromisso com responsável e prazo, visível às duas partes.
- **Estado:** não iniciada na linha de integração; regras preliminares no PR #19, sem merge.

### D08 — Necessidade de IA para análise de solicitações, elaboração detalhada de escopos e acompanhamento de projetos

- **Causa hipotética:** análise e detalhamento consomem tempo de pessoas experientes e variam de um caso para outro.
- **Solução proposta:** extração assistida existente (M2) e novas capacidades com revisão humana (M6.6).
- **Oportunidades de IA:** é o próprio objeto desta dor: triagem, rascunho de escopo e resumo de andamento.
- **Prioridade:** P2; depende de dados reais para medir benefício.
- **Dependências:** provedor, política de dados e revisor definidos; dados do ClickUp.
- **Métricas:** tempo por análise; parcela de sugestões aceitas sem alteração; custo por análise.
- **Critérios de aceite:** benefício medido contra uma linha de base; nenhuma decisão comercial sem humano; custo limitado por orçamento.
- **Estado:** parcial. Extração implementada e desativada, testada só com provedor simulado; IA de escopo e acompanhamento não iniciada.
