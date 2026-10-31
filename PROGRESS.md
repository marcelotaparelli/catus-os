# Progresso

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

CI foi preparada, mas execução no GitHub ainda não foi observada. O remoto sem base impede PR revisável agora; implementação preparada para commit na branch de feature. O Playwright também validou a inicialização automática de API e frontend após parar os serviços anteriores. Ambiente atual validado não comprova restauração de snapshot em nova tarefa. Ver próximos critérios em `NEXT.md`.
