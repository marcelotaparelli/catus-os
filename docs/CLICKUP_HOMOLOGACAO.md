# Homologação do M6.1 com um projeto real do ClickUp

Procedimento para a primeira leitura real, de um único projeto, num ambiente isolado e descartável. Nada aqui é executado sem autorização explícita do proprietário. Este documento é público: identificadores reais, nomes de clientes e tokens nunca são escritos nele, em issues, PRs ou chat.

**Estado atual:** ensaiado só com dados sintéticos e um ClickUp simulado. Nenhuma chamada ao ClickUp real foi feita. Merge, deploy e início do M6.2 continuam em HOLD.

## 1. Pré-condições

1. Autorização explícita do proprietário para esta homologação, registrada fora do repositório.
2. Revisão dos PRs #20 (M6.1) e do PR de preparação da homologação (escopo de status por lista). A homologação roda a partir da branch, sem merge.
3. Um projeto piloto com uma única lista do ClickUp, de preferência com status personalizados, responsáveis, subtarefas, prazos e pelo menos uma dependência, para exercitar todas as leituras.
4. O proprietário escolhe a máquina. Ela não pode ser a instalação do Arch em uso nem a VPS de produção.

## 2. Ambiente isolado

O ambiente é um checkout novo, num diretório novo, com o PostgreSQL embutido do `dev:local`. Ele cria um cluster próprio em `.local/postgres` desse diretório, escolhe portas livres e nunca reutiliza, reinicia ou apaga o que já existe.

```sh
git clone https://github.com/marcelotaparelli/catus-os.git ~/catus-homolog-clickup
cd ~/catus-homolog-clickup
git switch --detach <SHA revisado da branch de homologação>
bun install --frozen-lockfile
bun run dev:local          # anota as portas que ele imprimir
```

Antes de continuar, confirme que o banco é o novo (troque `<porta>` pela porta impressa):

```sh
psql "postgres://catus:catus_local_only@127.0.0.1:<porta>/catus" -Atc "SHOW data_directory"
# precisa terminar em ~/catus-homolog-clickup/.local/postgres
```

Se o caminho for outro, pare: o procedimento está apontando para um banco que não é descartável.

O login usa o OIDC configurado no `.env` desse checkout (ver `docs/DEV_LOCAL.md`). Sem OIDC, a API sobe com login desligado e o painel não abre; a comparação ainda pode ser feita pelas consultas da seção 6.

**Descartar:** encerrar o `dev:local` (Ctrl+C) e apagar `~/catus-homolog-clickup`. Isso remove banco, contas de banco e dados lidos do ClickUp.

## 3. Conta de serviço e token

Credenciais nunca passam pelo chat, por e-mail ou pelo repositório. O proprietário cria e grava o token diretamente na máquina de homologação.

1. No ClickUp, criar um usuário de serviço (por exemplo `catus-leitura@<domínio da agência>`) com acesso **somente** à lista do piloto. Se o plano permitir, papel convidado com permissão de visualização.
2. Entrar como esse usuário e gerar o token pessoal (Settings > Apps > API Token).
3. Gravar o token num arquivo fora do repositório, sem eco no terminal e sem histórico de shell:

```sh
install -d -m 700 ~/.config/catus-homolog
( umask 077; read -rs -p 'Token ClickUp: ' t; echo; printf 'CLICKUP_API_TOKEN=%s\n' "$t" > ~/.config/catus-homolog/clickup.env; unset t )
```

O token não vai para o `.env` do checkout, porque esse arquivo é lido também pela API. O launcher já remove `CLICKUP_API_TOKEN` do ambiente da API, mas o arquivo separado evita que ele sequer seja lido ali.

4. Ao final da homologação, aprovada ou não, regerar o token no ClickUp. Isso invalida o anterior.

## 4. Identificadores

| Identificador        | Onde obter                                                  | Validação pelo sistema                                                                                                                          | Validação humana                                             |
| -------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Workspace ID         | URL `app.clickup.com/<workspace>/...`                       | só dígitos, senão a integração fica desligada (`invalid_config`). Tarefa de outro workspace faz a leitura falhar inteira (`workspace_mismatch`) | o nome do workspace no ClickUp é o esperado                  |
| List ID              | URL da lista, `.../v/li/<lista>`                            | só dígitos, senão o vínculo é recusado                                                                                                          | depois da 1ª leitura, o nome da lista no painel é o esperado |
| Organização no Catus | `SELECT id,name FROM organizations` no banco de homologação | UUID, senão a integração fica desligada                                                                                                         | o nome é o da agência criada para o teste                    |

Os identificadores reais ficam só no arquivo de ambiente da máquina de homologação.

## 5. Ativação

No checkout de homologação:

```sh
# Conta de banco do worker (sem acesso a contratos, economia ou demandas)
bun run clickup:role
bun run migrate            # aplica 012 e 013 com os privilégios

# Configuração não secreta: no .env do checkout
#   CLICKUP_ENABLED=true
#   CLICKUP_ORGANIZATION_ID=<uuid da organização de homologação>
#   CLICKUP_WORKSPACE_ID=<workspace>
#   CLICKUP_REQUESTS_PER_MINUTE=30      # metade do padrão na primeira leitura
# Reiniciar o dev:local para a API ver CLICKUP_ENABLED e a organização.
```

No painel, como gestor ou administrador: projeto piloto > Execução no ClickUp > Listas vinculadas > informar o List ID.

Primeira leitura, uma única vez e com o token só nesse processo:

```sh
( set -a; . ~/.config/catus-homolog/clickup.env; set +a; bun run clickup:worker -- --once )
```

O worker confere a própria conta de banco antes de qualquer chamada e para se ela tiver privilégios a mais. A saída esperada é `ClickUp sync cycle: 1 list(s) processed`. Em caso de erro, aparece só a classe do erro (`unauthorized`, `not_found`, `rate_limited`, `workspace_mismatch`...), nunca o token ou a resposta do ClickUp.

## 6. Comparação com o ClickUp

A leitura inclui tarefas fechadas e subtarefas e exclui tarefas arquivadas. No ClickUp, use a visualização de lista com "Mostrar fechadas" e "Subtarefas: expandidas", sem filtros.

Consultas somente leitura no banco de homologação:

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

**Erro controlado:** com um token propositalmente inválido no arquivo, rodar `--once`. Esperado: `unauthorized` em `clickup_sync_runs`, o painel mostra "falhando" e mantém os números anteriores. Restaurar o token correto depois.

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
4. **Descartar o ambiente:** encerrar o `dev:local` e apagar o diretório do checkout de homologação e `~/.config/catus-homolog`.

## 9. O que não acontece nesta homologação

- Nenhuma escrita no ClickUp: o cliente só tem GET, sem redirecionamento, e os testes recusam qualquer outro método.
- Nenhum webhook, portal do cliente, importação de horas ou envio de custos e margens.
- Nenhum acesso ao banco do Arch ou da VPS, e nenhum deploy.
