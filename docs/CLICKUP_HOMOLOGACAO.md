# Homologação do M6.1 com um projeto real do ClickUp

Procedimento para a primeira leitura real, de um único projeto, num ambiente isolado e descartável. Nada aqui é executado sem autorização explícita do proprietário. Este documento é público: identificadores reais, nomes de clientes e tokens nunca são escritos nele, em issues, PRs ou chat.

**Estado atual:** ensaiado com dados sintéticos, um ClickUp simulado e login OIDC real contra um emissor de ensaio. Nenhuma chamada ao ClickUp real foi feita. Merge, deploy e início do M6.2 continuam em HOLD.

## 1. Pré-condições

1. Autorização explícita do proprietário para esta homologação, registrada fora do repositório.
2. Revisão dos PRs #20 (M6.1) e do PR de preparação da homologação (escopo de status por lista). A homologação roda a partir da branch, sem merge.
3. Um projeto piloto com uma única lista do ClickUp, de preferência com status personalizados, responsáveis, subtarefas, prazos e pelo menos uma dependência, para exercitar todas as leituras.
4. O proprietário escolhe a máquina. Ela não pode ser a instalação do Arch em uso nem a VPS de produção.

## 2. Fluxo assistido

O ambiente é um clone novo, num diretório novo, com o PostgreSQL embutido do `dev:local`. O cluster fica em `.local/postgres` desse clone, as portas são escolhidas livres, e nada do que já existe é reutilizado, reiniciado ou apagado. O fluxo `clickup:homolog` faz as verificações e preparações e **para antes de qualquer conexão ao ClickUp**.

```sh
git clone https://github.com/marcelotaparelli/catus-os.git ~/catus-homolog-clickup
cd ~/catus-homolog-clickup
git switch --detach <SHA revisado>
bun install --frozen-lockfile
bun run clickup:homolog init        # marca este clone; recusa qualquer diretório com .local ou .env
bun run dev:local                   # deixe rodando neste terminal
```

Em outro terminal, no mesmo diretório, rode `bun run clickup:homolog` quantas vezes quiser. Cada execução mostra `OK`, `PENDENTE` (depende do proprietário) ou `FALHA`, e diz o próximo passo:

| Verificação                 | O que o fluxo faz                                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clone de homologação        | Exige a marca do `init`. Sem ela, para antes de tocar em qualquer banco                                                                                                                             |
| Banco isolado               | Só continua se o `data_directory` do PostgreSQL conectado for o `.local/postgres` deste clone                                                                                                       |
| Migrations                  | Confere que todas as do repositório foram aplicadas                                                                                                                                                 |
| Conta do worker             | Cria a conta, se faltar, reaplica os privilégios e confere 22 regras: sem economia, contratos, escopo, demandas, pessoas, sessões, auditoria ou mapeamentos; sem DELETE; sem atributos elevados     |
| Worker recusa contas fortes | Roda o worker real, pelo launcher, com as contas da web, das migrações e do administrador: todas recusadas. A própria é aceita e processa 0 listas. Só roda sem lista vinculada e com proxy fechado |
| `.env` protegido            | 0600, ignorado e fora do Git; recusa token em texto no `.env`                                                                                                                                       |
| Configuração do ClickUp     | Grava só chaves não secretas: organização, ritmo de 30 chamadas por minuto, caminho do arquivo do token e, com `--workspace`, o workspace e `CLICKUP_ENABLED=true`                                  |
| Login OIDC                  | Confere `OIDC_*` sem exibir o segredo, mostra a URI de redirecionamento a cadastrar, testa o emissor e se a API está com login ativo                                                                |
| Administrador               | Com `--admin-email`, autoriza o primeiro administrador (`bootstrap:admin`)                                                                                                                          |
| Token e vínculo             | Valida o arquivo do token sem exibi-lo e mostra qual lista está vinculada a qual projeto                                                                                                            |

**Descartar:** encerrar o `dev:local` (Ctrl+C) e apagar `~/catus-homolog-clickup`. Isso remove banco, contas de banco e dados lidos do ClickUp.

### Login no painel

O painel usa o mesmo login OIDC de produção, com um cliente Google **só de desenvolvimento** (`docs/DEV_LOCAL.md`, seção "Login Google de desenvolvimento"). O fluxo imprime a URI de redirecionamento a cadastrar, normalmente `http://127.0.0.1:5173/api/auth/callback`. O ID e o segredo do cliente vão para o `.env` do clone, que fica em 0600 e fora do Git. Depois de reiniciar o `dev:local`:

```sh
bun run clickup:homolog --workspace <workspace> --admin-email <seu e-mail> --admin-name "<seu nome>"
```

Reinicie o `dev:local` mais uma vez para a API ver a integração ligada. O painel fica em Mission Control > Visão executiva > projeto > Execução no ClickUp.

## 3. Conta de serviço e token

Credenciais nunca passam pelo chat, por e-mail ou pelo repositório. O proprietário cria e grava o token diretamente na máquina de homologação.

1. No ClickUp, criar um usuário de serviço (por exemplo `catus-leitura@<domínio da agência>`) com acesso **somente** à lista do piloto. Se o plano permitir, papel convidado com permissão de visualização.
2. Entrar como esse usuário e gerar o token pessoal (Settings > Apps > API Token).
3. No clone de homologação, num terminal interativo:

```sh
bun run clickup:token
```

Isso pede o token sem mostrá-lo na tela e aceita apenas um terminal interativo, nunca pipe, argumento ou arquivo, então o token não fica no histórico do shell. O valor é validado e gravado atomicamente em `~/.config/catus-homolog/clickup-token`: arquivo 0600, diretório 0700, fora do repositório. Nada é impresso de volta.

O launcher do worker lê esse arquivo **como dado**, nunca com `source`. Ele recusa link simbólico, outro dono, permissões abertas, diretório gravável por outros, caminho dentro do repositório e qualquer conteúdo que não seja uma única linha no formato de token. A API e o worker de IA nunca recebem o token nem o caminho dele.

4. Ao final da homologação, aprovada ou não, regerar o token no ClickUp. Isso invalida o anterior.

## 4. Identificadores

| Identificador        | Onde obter                                                    | Validação pelo sistema                                                                                                                        | Validação humana                                             |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Workspace ID         | URL `app.clickup.com/<workspace>/...`                         | só dígitos, senão o fluxo recusa e a integração fica desligada. Tarefa de outro workspace faz a leitura falhar inteira (`workspace_mismatch`) | o nome do workspace no ClickUp é o esperado                  |
| List ID              | URL da lista, `.../v/li/<lista>`                              | só dígitos, senão o vínculo é recusado                                                                                                        | depois da 1ª leitura, o nome da lista no painel é o esperado |
| Organização no Catus | gravada pelo fluxo: a organização padrão do banco descartável | UUID, senão a integração fica desligada                                                                                                       | o projeto piloto aparece no painel                           |

Os identificadores reais ficam só no `.env` da máquina de homologação.

## 5. Primeira leitura (exige autorização)

Com todos os itens em `OK`, a lista vinculada no painel ao projeto piloto, e só depois da sua autorização explícita:

```sh
bun run clickup:worker -- --once
bun run clickup:homolog report
```

O worker confere a própria conta de banco antes de qualquer chamada e para se ela tiver privilégios a mais. A saída esperada é `ClickUp sync cycle: 1 list(s) processed`. Em caso de erro, aparece só a classe do erro (`unauthorized`, `not_found`, `rate_limited`, `workspace_mismatch`...), nunca o token ou a resposta do ClickUp.

`report` mostra, sem gravar nada, as contagens por status, por responsável, sem responsável, atrasadas e sem lista principal. São esses números que se comparam com o ClickUp na seção 6.

### Ensaio (05/11/2026, sem ClickUp)

Feito numa VM descartável sem rede externa, com um clone novo e um usuário sem privilégios. O emissor OIDC foi um provedor HTTPS local de ensaio, com certificado de uma CA própria confiada pela API; ele não faz parte do repositório.

1. `init` recusou o checkout de trabalho, que tem `.local`, e marcou o clone novo.
2. O `dev:local` encontrou a 5432 ocupada, não mexeu nela e criou um cluster na 5433. O fluxo confirmou o `data_directory` do clone e as 12 migrations até a 013.
3. Conta do worker criada, 22 regras de privilégio conferidas. O worker real recusou as contas da web, das migrações e do administrador, e aceitou a própria com 0 listas.
4. Sem OIDC, o fluxo apontou o que faltava e a URI de redirecionamento. Com OIDC no `.env`, confirmou o emissor e o login ativo e autorizou o administrador. Com `--workspace`, ligou a integração.
5. `clickup:token` num terminal real: o token não apareceu na tela, e o arquivo ficou 0600 num diretório 0700.
6. Login real no navegador, pela troca completa de código com PKCE e assinatura verificada, como o administrador autorizado. Vínculo da lista pelo painel, que mostrou "nenhuma leitura concluída".
7. Uma leitura simulada, gravada com a própria conta do worker e sem ClickUp, apareceu no painel: nome da lista, abertas, concluídas, subtarefas, atrasada, prazos, responsáveis e status sem significado no escopo da lista. O mapeamento salvo pelo painel mudou a situação para "Com bloqueios". `report` mostrou as mesmas contagens.
8. O token canário e o segredo OIDC não apareceram em `.env`, `.local`, logs ou evidências. O worker nunca rodou com o token. No descarte, nenhum processo ficou vivo e o clone foi apagado.

Fica para o proprietário: o login com o cliente Google real, que depende de rede e da conta dele, e a leitura real do ClickUp.

## 6. Comparação com o ClickUp

A leitura inclui tarefas fechadas e subtarefas e exclui tarefas arquivadas. No ClickUp, use a visualização de lista com "Mostrar fechadas" e "Subtarefas: expandidas", sem filtros.

`bun run clickup:homolog report` já mostra as contagens. Para conferir tarefa a tarefa, as consultas somente leitura abaixo rodam no banco de homologação:

```sql
-- Última leitura
SELECT state, pages, tasks_seen, tasks_missing, data_warnings, error_code, http_status, started_at, finished_at
  FROM clickup_sync_runs ORDER BY started_at DESC LIMIT 5;
-- Totais por status, como estão no ClickUp
SELECT t.status_raw, t.status_type, count(*) FILTER (WHERE t.parent_task_id IS NULL) tarefas,
       count(*) FILTER (WHERE t.parent_task_id IS NOT NULL) subtarefas
  FROM clickup_list_tasks m JOIN clickup_tasks t USING (organization_id, task_id)
 WHERE m.missing_since IS NULL GROUP BY 1, 2 ORDER BY 1;
-- Amostra para conferência tarefa a tarefa
SELECT t.task_id, t.status_raw, t.due_at, t.assignee_ids, t.waiting_on, t.home_list_id
  FROM clickup_list_tasks m JOIN clickup_tasks t USING (organization_id, task_id)
 WHERE m.missing_since IS NULL ORDER BY random() LIMIT 10;
```

| Verificação                             | Catus                        | ClickUp                     | Tolerância                                                                             |
| --------------------------------------- | ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| Tarefas e subtarefas abertas e fechadas | painel e consulta por status | contagem da lista           | zero diferença                                                                         |
| Contagem por status                     | consulta por status          | agrupamento por status      | zero diferença                                                                         |
| Atrasadas                               | painel                       | filtro "vencidas"           | diferenças só em prazos sem horário do próprio dia (tolerância de um dia, documentada) |
| Sem responsável                         | painel                       | filtro "sem responsável"    | zero diferença                                                                         |
| Responsáveis                            | painel, por pessoa           | agrupamento por responsável | zero diferença                                                                         |
| 10 tarefas sorteadas                    | consulta de amostra          | abrir cada tarefa           | status, prazo, responsáveis, dependências e lista principal iguais                     |
| Lista principal (`home_list_id`)        | amostra                      | campo "Lista" da tarefa     | igual em todas, ou registrar que a API não informou                                    |

Os formatos reais de `assignees`, `dependencies` e `list` são confirmados nessa amostra. O código aceita as duas formas documentadas, mas só a leitura real diz qual o ClickUp usa. Se aparecer `data_warnings` maior que zero, a homologação não é aprovada até entender quais campos falharam.

Depois do mapeamento de status no painel, conferir: as contagens de "bloqueadas" e "aguardando cliente" batem com as tarefas desses status no ClickUp.

**Segunda leitura** (idempotência): rodar o worker `--once` de novo, sem mudanças no ClickUp. Esperado: `tasks_inserted = 0`, `tasks_updated = 0`, `tasks_missing = 0`.

**Mudança controlada:** o proprietário muda o status de uma tarefa e o prazo de outra no ClickUp. Na leitura seguinte, só essas duas aparecem em `tasks_updated`, e o painel reflete a mudança.

**Erro controlado:** grave um token propositalmente inválido com `bun run clickup:token -- --replace` e rode `bun run clickup:worker -- --once`. Esperado: `unauthorized` em `clickup_sync_runs`, o painel mostra "falhando" e mantém os números anteriores. Depois, grave o token correto da mesma forma.

## 7. Critérios para considerar o primeiro projeto homologado

Todos obrigatórios:

1. Seção 6 sem diferenças fora da tolerância, com a planilha de conferência guardada fora do repositório.
2. Duas leituras seguidas sem alteração produzem zero inserções, atualizações e ausências.
3. A mudança controlada aparece, e só ela.
4. O token inválido gera `unauthorized`, sem perder dados, e a falha aparece no painel.
5. `data_warnings = 0` na leitura final, ou cada aviso explicado e aceito pelo proprietário.
6. Nenhuma escrita no ClickUp: o histórico de atividade da lista no ClickUp não mostra ações do usuário de serviço.
7. O token não aparece em nenhuma saída: `grep -r "pk_" ~/catus-homolog-clickup/.local` e a saída do worker não encontram nada.
8. PO e desenvolvedor da organização de homologação não veem o painel de execução, e nenhum valor econômico aparece nas tabelas `clickup_*`.
9. Todo status aberto da lista tem mapeamento explícito, no escopo da lista.
10. O proprietário assina o resultado.

Só depois disso o M6.2 pode começar, e só com nova autorização.

## 8. Rollback

Do mais leve ao completo. Nenhum passo apaga dados do Catus OS fora do ambiente descartável, e nenhum exige migration de reversão: 012 e 013 são aditivas, e o teste `tests/clickup-upgrade.test.ts` comprova que o código do M6.1 continua funcionando no esquema com a 013.

1. **Desvincular a lista** no painel. O worker para de ler essa lista, e o projeto volta a "não vinculado". O histórico fica guardado.
2. **Desligar a integração:** `CLICKUP_ENABLED=false` e reiniciar. O painel some e as rotas `/api/clickup/*` respondem 404.
3. **Revogar o token** no ClickUp (regerar). Nenhuma leitura volta a funcionar com o anterior.
4. **Descartar o ambiente:** encerrar o `dev:local` e apagar o diretório do clone de homologação e `~/.config/catus-homolog`.

## 9. O que não acontece nesta homologação

- Nenhuma escrita no ClickUp: o cliente só tem GET, sem redirecionamento, e os testes recusam qualquer outro método.
- Nenhum webhook, portal do cliente, importação de horas ou envio de custos e margens.
- Nenhum acesso ao banco do Arch ou da VPS, e nenhum deploy.
