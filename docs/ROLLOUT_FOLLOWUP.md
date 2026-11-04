# Plano de rollout: identidade Catus, WOFF2 e fila de ações

**Nenhum rollout está autorizado por este documento.** Ele descreve o que fazer quando houver autorização, a partir de `75a9c14`. Execute no host da homologação, com o app fora de uso durante a janela.

## O que muda

| Item             | Efeito                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Migration `010`  | Acrescenta 4 colunas anuláveis em `requests`, 3 tabelas e 1 gatilho. Não reescreve linhas                                           |
| Servidor         | Entrega `.woff2`; nova rota `/api/followup`; `/api/overview` ganha o campo `followup`; bloquear passa a exigir motivo e dependência |
| Automação        | Roda no processo da API, sem serviço externo. `FOLLOWUP_AUTOMATION=off` desliga só os alertas                                       |
| Dados existentes | Demandas ficam sem compromisso e sem modelo. Nada é preenchido por suposição                                                        |

## Script

[`deploy/rollout-cea8960.sh`](../deploy/rollout-cea8960.sh) executa este plano. Ele roda **fora do checkout**, porque o arquivo não existe em `cea8960`, e confere as versões pelo conteúdo.

| Modo                                 | Efeito                                                                               | Autorização        |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------ |
| `check`                              | Só lê: instalação, versões, banco, migration pendente. Grava apenas o log em `$HOME` | Nenhuma            |
| `run AUTORIZO-cea8960`               | Executa tudo, parando no primeiro problema                                           | A sua, por escrito |
| `rollback AUTORIZO-ROLLBACK-cea8960` | Volta a aplicação para `75a9c14`, sem tocar no banco; retoma se tiver parado no meio | A sua, por escrito |

Depois de um rollback, `run` recusa executar de novo, porque o banco já tem a `010`. Voltar para a versão nova exige outra revisão e outro script.

## Critérios para autorizar a execução

Todos precisam estar cumpridos. Cada um tem como ser conferido.

| #   | Critério                                               | Como conferir                                                               | Quem         |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------- | ------------ |
| 1   | `cea8960` aprovado, com checks verdes                  | `validate`, `quality` (41885979701) e `g4` (41885981145)                    | Registrado   |
| 2   | Script revisado no PR, sem merge pendente que o altere | PR aprovado por você                                                        | Você         |
| 3   | O script copiado é o revisado                          | `sha256sum -c` no comando abaixo, com o hash publicado no PR                | Comando      |
| 4   | `check` termina com `CHECK OK` no Arch                 | Saída do comando, enviada para revisão                                      | Você executa |
| 5   | Migration pendente é só a `010`                        | Linha `pendente: só a migration`                                            | `check`      |
| 6   | Cluster identificado                                   | Linha `Cluster:`, igual à identidade registrada no G4 de `75a9c14`          | Você compara |
| 7   | Volume de alertas aceito                               | Linha `primeira varredura vai sinalizar`: cada demanda aberta gera um aviso | Você decide  |
| 8   | 8 GB livres em repositório, Docker e `$HOME`           | `check` para se faltar                                                      | `check`      |
| 9   | Janela sem uso combinada com a equipe                  | Uso durante a execução para o script. `check` avisa de sessões ativas       | Você         |
| 10  | Quem fará a validação humana está definido             | Login Google, permissões e fila de cada papel                               | Você         |
| 11  | Critérios de parada e rollback aceitos                 | Seção "Rollback"                                                            | Você         |
| 12  | Autorização explícita                                  | Mensagem sua citando `cea8960`. **Nenhuma existe hoje**                     | Você         |

Comando do `check`, que não altera nada na instalação; o `git fetch` só atualiza referências do repositório:

```sh
cd ~/sandboxes/agent/projects/catus-os-m5 && git fetch origin chore/rollout-cea8960 feat/pilot-oidc && git show FETCH_HEAD:deploy/rollout-cea8960.sh > ~/catus-rollout-cea8960.sh && echo "HASH_DO_PR  $HOME/catus-rollout-cea8960.sh" | sha256sum -c && bash ~/catus-rollout-cea8960.sh check
```

## O que foi provado e o que não foi

Em `docs/quality/rollout-cea8960/`: cenários, simulador e resultados, com **PostgreSQL real, a migration real, os comandos SQL reais e a automação real de `cea8960`**.

**Docker foi simulado**, e os valores de `catus.sh` e `g4.sh` também. Não foram provados o formato real de saída do Docker e do Compose, o tempo real de build e migração, nem o backup e a restauração reais. Na preparação, uma divergência de formato faz o script parar. Depois do update, a mesma divergência para o script com a aplicação já atualizada, e o caminho é investigar ou fazer rollback.

## Antes

1. Confirme o SHA aprovado e a árvore limpa no checkout.
2. Use `deploy/rollout-cea8960.sh`. O script de `75a9c14` não serve: ele não sabe da migration `010`, das colunas novas de `requests`, nem das tabelas que a automação grava.
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

`run` faz `git switch --detach` para `cea8960` e `deploy/catus.sh update`, que faz backup, build, migration e reinício. Só a migration `010` pode aparecer como aplicada.

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

1. `rollback AUTORIZO-ROLLBACK-cea8960`: troca o checkout para `75a9c14` e roda `deploy/catus.sh update`, sem nenhuma operação no banco, e confere cluster, histórico e conteúdo.
2. As colunas e tabelas novas ficam sem uso. O gatilho continua registrando eventos, e os trabalhos ficam na fila sem processar, sem efeito nas transações.

Foi ensaiado em banco descartável: as jornadas de `94971be`, versão anterior a este PR, passaram sobre o esquema já com a `010`, e `tests/followup.test.ts` confere os mesmos comandos com o papel de runtime. Não foi ensaiado na instalação real.

**Ao voltar para a versão nova depois:** o que foi alterado nesse intervalo gera compromissos desatualizados, que aparecem como vencidos ou sem compromisso na fila.

**Do banco, só se a validação mostrar perda ou corrupção de dados:** pare o app, restaure o backup cifrado do passo 5 em um banco novo, confira e só então troque. Mudanças feitas depois do backup se perdem, por isso a decisão é sua. Não apague o volume.

**Critérios para parar e voltar:** qualquer diferença em tabela de negócio, cluster ou volume diferente, migration inesperada, serviço sem saúde após 5 minutos, ou G4 sem GO.
