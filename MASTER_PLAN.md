# Plano mestre do MVP

## Objetivo

Transformar contexto manual fornecido pelos POs em trabalho rastreável, escopo controlado e previsibilidade econômica. O produto completo deve melhorar margem por projeto/cliente sem permitir execução de agentes fora de escopo ou sem revisão.

## Marcos e critérios de aceite

| Prioridade / marco     | Escopo                                                                | Critério de saída                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 · M0 (entregue)     | Stack, módulos, banco, contexto manual, solicitações, Mission Control | Fluxo cliente → projeto → atendimento → solicitação exercitado no navegador, persistente, com estado/responsável/ação; testes reais e documentação                            |
| P0 · M1 (implementado) | Identidade e controle de acesso                                       | Usuários/papéis e organização, autorização em cada rota, testes de isolamento e auditoria por ator; requisito para uso compartilhado                                          |
| P1 · M2 (implementado) | Extração assistida e triagem                                          | Provedor atrás da porta, propostas com evidência e perguntas, revisão humana antes de criar demanda, testes com fixtures, orçamento e observabilidade de inferência           |
| P1 · M3 (implementado) | Escopo, contratos e aprovações                                        | Versões de escopo, critérios de aceite, aprovações explícitas, referência documental segura e vínculo contratual; nenhuma mudança aprovada implicitamente                     |
| P1 · M4 (implementado) | Motor econômico e horas                                               | Taxas vigentes, capacidade, estimativas e apontamentos, custos diretos/indiretos, receita contratada, margem prevista e realizada com fórmulas auditáveis                     |
| P2 · M5                | Delegação a agentes de engenharia                                     | Elegibilidade exige escopo aprovado, margem/regra de custo, repositório permitido; jobs idempotentes, ambiente isolado, testes e PR para revisão; sem merge/deploy automático |
| P2 · M6                | Gestão e melhoria contínua                                            | Visões operacionais e econômicas com origem/período, bloqueios, lead time, desvios e aprendizado; sem métricas fictícias                                                      |

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
