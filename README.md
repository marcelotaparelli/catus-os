# CATUS OS

Primeira fatia M0 de um sistema operacional AI-First para uma agência de e-commerce. Cadastro manual e persistente de clientes, projetos, atendimentos/reuniões e solicitações, com responsável, estado, próxima ação e Mission Control. **A extração por IA não está implementada.**

## Executar localmente

Requisitos: Node.js >=22.12, npm e Linux/macOS compatível com os binários PostgreSQL. Bun 1.4.4 é instalado como ferramenta local pelo npm; não exige instalação global. Não execute PostgreSQL como root. Windows: use WSL2 ou um PostgreSQL externo.

```sh
cd /workspace/catus-os # ou a pasta em que você clonou este repositório
npm ci
npm run env:init
npm run db
```

`db` mantém PostgreSQL real 18.3 em primeiro plano, ouvindo apenas em `127.0.0.1:5432`; os dados persistem em `.local/postgres`. A senha `catus_local_only` é exclusivamente de desenvolvimento. Use Ctrl+C para parar de forma limpa. Não remova o diretório de dados para resolver problemas de inicialização. Para usar um PostgreSQL existente, pule `npm run db` e configure `DATABASE_URL` no `.env` para um banco exclusivo de desenvolvimento com permissão de criar tabelas.

Em outro terminal:

```sh
npm run migrate
npm run dev
```

Em um terceiro terminal:

```sh
npm run web
```

Abra o frontend local na porta 5173. Leia o `DEV_TOKEN` do seu `.env` local e informe no formulário de acesso; nunca envie esse valor no chat ou ao Git. O token permanece apenas na memória da aba e precisa ser informado após recarregar. A API Bun usa a porta 3000. Ambos os processos escutam somente em loopback. Nenhuma credencial real é necessária.

`env:init` preserva `.env` existente e cria um token aleatório quando ausente. O exemplo de configuração está em `.env.example`. As migrations usam lock PostgreSQL e transação, podendo ser repetidas. Após aplicada uma migration, crie outra em vez de editar seu conteúdo. Faça backup antes de evoluir um banco com dados importantes; não há reversão automática.

## Fluxo de aceitação

1. Conecte com o token local e cadastre um cliente.
2. Selecione o cliente e crie um projeto.
3. Selecione o projeto, escolha reunião ou atendimento, preencha data e contexto e registre.
4. Selecione o atendimento e crie uma solicitação com título, descrição, responsável e próxima ação.
5. Confira o cartão em Mission Control no estado **Nova**.
6. Atualize a solicitação para **Em triagem**, altere responsável/próxima ação e salve.
7. Recarregue, conecte novamente e confira os dados persistidos.

Datas do formulário seguem o fuso do navegador e são convertidas para ISO com fuso na API. PostgreSQL armazena `timestamptz`. Nenhum seed, métrica financeira ou resultado de IA é exibido como real.

## Verificar

Com PostgreSQL ativo e migrations aplicadas:

```sh
npm run check
npm test
npm run build
npm run format:check
npx playwright install chromium
npm run test:e2e
```

O Playwright inicia API e frontend se ainda não estiverem ativos. A suíte Bun valida regras e APIs usando PostgreSQL real; o teste de navegador percorre o fluxo e confirma persistência após reload e layout móvel. Os testes criam dados identificados e removem apenas seus próprios registros no `finally`/`afterAll`. **Use sempre um banco exclusivo de desenvolvimento/testes; nunca aponte para produção.** Resultados de navegador e screenshot ficam em `test-results/` (ignorado pelo Git).

Em Linux com navegador gerenciado externamente, `CHROMIUM_PATH=/caminho/chromium npm run test:e2e` permite um executável compatível. Esse modo usa flags sem sandbox apenas para o browser de testes isolado; não é configuração de execução do produto. Nesta máquina foi usado Chromium 143 fornecido por `@sparticuz/chromium@143.0.4` no tooling externo. O download padrão do Playwright foi bloqueado pela rede; não se desabilitou TLS ou integridade dos pacotes.

`npm run build` valida e gera o bundle em `dist`; distribuição pública/servidor de produção não fazem parte deste marco. A API recusa `NODE_ENV=production` porque o acesso atual usa um token local compartilhado, sem autenticação individual.

## API e segurança

Todas as rotas exigem `Authorization: Bearer <DEV_TOKEN>`; escritas exigem JSON e têm limite de 32 KiB. Origens de navegador são restritas a localhost nas portas 3000/5173; não há CORS aberto. Entradas são validadas no backend, consultas são parametrizadas, erros internos são ocultados e respostas não podem ser cacheadas. Svelte escapa texto; nenhum HTML de usuário é renderizado.

| Método | Rota                   | Operação                                                                      |
| ------ | ---------------------- | ----------------------------------------------------------------------------- |
| GET    | `/api/health`          | Conexão real ao banco                                                         |
| GET    | `/api/mission-control` | Snapshot consistente de clientes, projetos, atendimentos e solicitações       |
| POST   | `/api/clients`         | `{name}`                                                                      |
| POST   | `/api/projects`        | `{client_id,name}`                                                            |
| POST   | `/api/interactions`    | `{project_id,kind,summary,occurred_at}`; kind `meeting` ou `service`          |
| POST   | `/api/requests`        | `{interaction_id,title,description,owner,next_action}`; estado inicial `new`  |
| PATCH  | `/api/requests/:id`    | `{status,owner,next_action,version}`; atualização completa desses três campos |
| GET    | `/api/extraction`      | Capacidade indisponível explícita, sem executar IA                            |

Respostas de criação: 201. Erros: 401 autenticação, 403 origem, 404 inexistente, 409 conflito de versão, 413 corpo excessivo, 415 tipo de conteúdo, 422 validação, 500 falha interna. Após 409, recarregue dados antes de editar novamente. O POST não oferece idempotência: em erro de rede, confira os dados antes de reenviar. O Mission Control carrega até 500 atendimentos e 500 solicitações mais recentes; os demais não são excluídos, mas paginação será necessária antes de uso em escala.

Responsáveis são texto obrigatório nesta fatia, não identidades autenticadas. Auditoria identifica `local-developer`; não representa uma pessoa específica. O banco local usa uma conta dona do schema; separar conta de migrations e runtime é requisito futuro. Não exponha este ambiente nem compartilhe o token. [ARCHITECTURE.md](ARCHITECTURE.md), [MASTER_PLAN.md](MASTER_PLAN.md), [PROGRESS.md](PROGRESS.md) e [NEXT.md](NEXT.md) detalham decisões, plano e limites.
