# Plano mestre do MVP

## Objetivo

Transformar contexto manual fornecido pelos POs em trabalho rastreável, escopo controlado e previsibilidade econômica. O produto completo deve melhorar margem por projeto/cliente sem permitir execução de agentes fora de escopo ou sem revisão.

## Marcos e critérios de aceite

| Prioridade / marco     | Escopo                                                                | Critério de saída                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 · M0 (entregue)     | Stack, módulos, banco, contexto manual, solicitações, Mission Control | Fluxo cliente → projeto → atendimento → solicitação exercitado no navegador, persistente, com estado/responsável/ação; testes reais e documentação                            |
| P0 · M1 (implementado) | Identidade e controle de acesso                                       | Usuários/papéis e organização, autorização em cada rota, testes de isolamento e auditoria por ator; requisito para uso compartilhado                                          |
| P1 · M2                | Extração assistida e triagem                                          | Provedor atrás da porta, propostas com evidência e perguntas, revisão humana antes de criar demanda, testes com fixtures, orçamento e observabilidade de inferência           |
| P1 · M3                | Escopo, contratos e aprovações                                        | Versões de escopo, critérios de aceite, aprovações explícitas, anexos seguros e vínculo contratual; nenhuma mudança aprovada implicitamente                                   |
| P1 · M4                | Motor econômico e horas                                               | Taxas vigentes, capacidade, estimativas e apontamentos, custos diretos/indiretos, receita contratada, margem prevista e realizada com fórmulas auditáveis                     |
| P2 · M5                | Delegação a agentes de engenharia                                     | Elegibilidade exige escopo aprovado, margem/regra de custo, repositório permitido; jobs idempotentes, ambiente isolado, testes e PR para revisão; sem merge/deploy automático |
| P2 · M6                | Gestão e melhoria contínua                                            | Visões operacionais e econômicas com origem/período, bloqueios, lead time, desvios e aprendizado; sem métricas fictícias                                                      |

## Dependências e limites

M1 antecede qualquer piloto compartilhado. M2 usa contexto do M0; M3 pode avançar com entrada manual independentemente do provedor de IA. M4 exige contratos/estimativas versionados do M3. M5 depende das políticas de autorização, escopo e economia. M6 cresce com dados reais coletados pelos marcos anteriores.

Escopo atual não inclui importação de Chat/Meet, faturamento fiscal, múltiplos serviços, automação de produção nem dashboards de margem sem motor econômico. Um marco termina por comportamento validado, não pela existência de arquivos.

## Estratégia de qualidade

Regras puras em Bun; APIs com PostgreSQL real; fluxos centrais no navegador; migrações repetíveis; tipagem estrita e build em cada PR. Usar banco de teste isolado e dados identificados com limpeza; nunca credenciais reais. Mudanças econômicas exigirão testes de arredondamento, vigência, moeda e reprocessamento. Agentes exigirão limites de recursos, evidência de testes e revisão humana.

## Atualização M1

Identidade OIDC configurável, sessões, papéis, organizações, responsáveis vinculados e auditoria individual implementados. A aceitação automatizada está em PROGRESS.md. Login Google real depende de configuração/credenciais de desenvolvimento; CI remoto aprovado no run 41220332080, observado pela página pública apesar da API GitHub bloqueada. Esses impedimentos não autorizam ativar um piloto ou iniciar M2.
