# Plano de rollout: identidade Catus, WOFF2 e fila de ações

**Nenhum rollout está autorizado por este documento.** Ele descreve o que fazer quando houver autorização, a partir de `75a9c14`. Execute no host da homologação, com o app fora de uso durante a janela.

## O que muda

| Item             | Efeito                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Migration `010`  | Acrescenta 4 colunas anuláveis em `requests`, 3 tabelas e 1 gatilho. Não reescreve linhas                                           |
| Servidor         | Entrega `.woff2`; nova rota `/api/followup`; `/api/overview` ganha o campo `followup`; bloquear passa a exigir motivo e dependência |
| Automação        | Roda no processo da API, sem serviço externo. `FOLLOWUP_AUTOMATION=off` desliga só os alertas                                       |
| Dados existentes | Demandas ficam sem compromisso e sem modelo. Nada é preenchido por suposição                                                        |

## Antes

1. Confirme o SHA aprovado e a árvore limpa no checkout.
2. Atualize o script de atualização para o novo SHA. Ele precisa acrescentar `automation_jobs` e `demand_alerts` às tabelas ignoradas na comparação exata (`TRANSIENT`), e conferir as duas à parte, como `deploy/g4.sh` faz. O script de `75a9c14` não serve.
3. Registre o estado atual, por contagem e hash de cada tabela de negócio, e a identidade do cluster.
4. Conte o que a primeira varredura vai sinalizar:

   ```sql
   SELECT count(*) FILTER (WHERE owner_user_id IS NULL) sem_dono, count(*) sem_compromisso
   FROM requests WHERE status <> 'done';
   ```

   Cada demanda aberta anterior à `010` vai gerar um aviso "Sem compromisso". Avise a equipe.

5. Gere um backup cifrado (`deploy/catus.sh backup`) e guarde fora do volume do banco.
6. Faça o teste de restauração (`restore-test`) e compare o banco restaurado com o original. Sem esse resultado, não continue. O banco `*_restore_test` fica no cluster com uma cópia dos dados: decida depois se o remove.

## Execução

1. `git switch --detach <SHA aprovado>`.
2. `deploy/catus.sh update`, que faz backup, build, migration e reinício. Só a migration `010` deve aparecer como aplicada.

## Validação de integridade

1. Todos os serviços saudáveis, mesma identidade de cluster e mesmo volume `catus_pgdata`.
2. Todas as tabelas de negócio com a mesma contagem e o mesmo hash, exceto `requests`, por causa das colunas novas. Em `requests`, compare os hashes só das colunas antigas.
3. `request_events` vazia, se ninguém usou o sistema; `demand_alerts` só com alertas abertos, conferidos com a contagem acima.
4. Sem violações:

   ```sql
   SELECT count(*) FROM (SELECT 1 FROM demand_alerts WHERE resolved_at IS NULL GROUP BY request_id,kind HAVING count(*)>1) d;
   SELECT count(*) FROM automation_jobs WHERE state='failed';
   ```

5. Depois de duas varreduras (10 minutos), os alertas abertos não mudam sem mudança nas demandas.
6. `deploy/g4.sh` com GO, e M2 e M5 desligados.
7. No navegador, com pessoas reais: login Google, permissões de cada papel, Inter e Lexend carregadas sem erro de CSP e a fila de cada papel. Essa validação continua humana.

## Rollback

**Da aplicação, sem voltar o banco:** é o caminho normal.

1. `git switch --detach <SHA anterior>` e `deploy/catus.sh update`, sem nenhuma operação no banco.
2. As colunas e tabelas novas ficam sem uso. O gatilho continua registrando eventos, e os trabalhos ficam na fila sem processar, sem efeito nas transações.

Foi ensaiado em banco descartável: as jornadas de `94971be`, versão anterior a este PR, passaram sobre o esquema já com a `010`, e `tests/followup.test.ts` confere os mesmos comandos com o papel de runtime. Não foi ensaiado na instalação real.

**Ao voltar para a versão nova depois:** o que foi alterado nesse intervalo gera compromissos desatualizados, que aparecem como vencidos ou sem compromisso na fila.

**Do banco, só se a validação mostrar perda ou corrupção de dados:** pare o app, restaure o backup cifrado do passo 5 em um banco novo, confira e só então troque. Mudanças feitas depois do backup se perdem, por isso a decisão é sua. Não apague o volume.

**Critérios para parar e voltar:** qualquer diferença em tabela de negócio, cluster ou volume diferente, migration inesperada, serviço sem saúde após 5 minutos, ou G4 sem GO.
