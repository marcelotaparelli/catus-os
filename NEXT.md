# Próximas etapas

1. **P0 — Identidade e autorização antes de piloto:** definir organização, usuários e papéis; integrar OIDC ou sessões seguras; substituir token e ator fixo; testes de isolamento por organização e autorização negativa por rota.
2. **P0 — Revisar e publicar o bootstrap no Git:** branch de feature já publicada, mas remoto sem main ou outra base; revisar commit na branch `feat/m0-mission-control`, definir branch base e então abrir PR. Não criar/mesclar main automaticamente.
3. **P1 — Robustez operacional:** idempotência de criação, paginação real, busca, limites de volume, testes de conexão interrompida, papéis separados no banco e backup/restauração; migrar responsáveis textuais para usuários.
4. **P1 — Aprimorar UX de contexto:** telas dedicadas, histórico de atendimentos com data/tipo, edição controlada do contexto, acesso à auditoria, filtros por projeto/responsável, confirmação clara de conflito e testes de acessibilidade completos.
5. **P1 — Extração com revisão:** escolher provedor e política de dados/custos; implementar porta existente; persistir propostas/evidências/perguntas e execução rastreável. Nenhum dado real deve ser enviado antes da política aprovada.
6. **P1 — Escopos e contratos:** versões, critérios de aceite, alçadas e aprovações com usuário/data; preparar entrada do motor econômico.
7. **P1 — Economia:** definir fórmulas e fontes de taxas, moedas, impostos/custos, capacidade e margens; testes de precisão; só então exibir indicadores econômicos.
8. **P2 — Agentes e gestão:** elegibilidade, execução isolada, outbox/jobs, orçamento, testes e PR revisável; depois métricas reais de operação e rentabilidade.

Antes de cada etapa, ler `ARCHITECTURE.md`, `MASTER_PLAN.md` e `PROGRESS.md`; preservar dados e mudanças existentes. A tarefa de nuvem já é isolada: usar o checkout existente, sem criar worktree salvo pedido explícito.
