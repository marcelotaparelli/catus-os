# Especificação: Alinhamento e Aceite de Demandas

**Situação:** só especificação. Nada foi implementado. A implementação começa em branch própria, derivada da versão então homologada, depois de autorizada.

## 1. Objetivo

Reduzir o retrabalho causado por pedidos ambíguos, divergência de entendimento, mudanças repetidas e falta de critério para o cliente aprovar. Isto é uma hipótese: a redução só pode ser confirmada no piloto real (seção 9).

## 2. O problema, no sistema atual

| O que falta                                  | O que existe hoje                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registro do que foi combinado para a demanda | `requests.description` é texto livre, e `next_action` muda a cada etapa                                                                                          |
| Critérios por demanda                        | `scope_items.acceptance_criteria` vale para o item inteiro; `suggested_acceptance_criteria` só existe nas demandas vindas da extração por IA, que está desligada |
| Confirmação do cliente                       | Só um atendimento em texto livre, sem vínculo com a demanda além da origem                                                                                       |
| Aceite                                       | "Concluída" significa que a equipe terminou, sem indicar se o cliente aceitou                                                                                    |
| Mudança repetida                             | Nada conta quantas vezes o combinado mudou; reabrir (`done → triage`) não tem motivo                                                                             |
| Trabalho novo disfarçado de ajuste           | `change_requests` existe, mas nada sugere usá-lo quando a demanda muda                                                                                           |

## 3. Princípios

1. **Sem burocracia para o PO.** Tudo que já se sabe vem preenchido, e nenhum passo novo é obrigatório em manutenção simples.
2. **Reutilizar** contratos, escopos, change requests, atendimentos, a fila e `request_events`. Sem segundo sistema de tarefas, sem tela nova.
3. **Decisões continuam humanas.** O sistema nunca conclui que o cliente aceitou. **Silêncio não é aceite.**
4. **Sem portal do cliente neste incremento.** Quem registra é a equipe, apontando a evidência.
5. **Determinístico.** Sem IA e sem API externa.

## 4. Fluxo

```
Pedido ─▶ Combinado ─▶ Confirmado pelo cliente ─▶ Execução ─▶ Entregue ─▶ Aceito ─▶ Concluída
              ▲                                                  │
              └──────────── mudança ou recusa, com motivo ◀──────┘
```

Tudo acontece nos estados que já existem; "Entregue" é um marco dentro de "Em execução", não um estado novo.

### 4.1 Combinado

Um cartão de três linhas no formulário atual da demanda, com "O que será entregue", "Critérios de aceite" e "Fora do combinado".

| Campo               | Vem preenchido de                                                                |
| ------------------- | -------------------------------------------------------------------------------- |
| O que será entregue | Título e detalhes da demanda; entregáveis do item de escopo, se houver cobertura |
| Critérios de aceite | Critérios do item de escopo, ou `suggested_acceptance_criteria`                  |
| Fora do combinado   | Exclusões do item de escopo                                                      |

Salvar sem alterar confirma o que veio preenchido. Mudar depois de confirmado cria uma nova versão e conta como mudança; a anterior fica guardada.

### 4.2 Confirmação do cliente

Um clique: "Cliente confirmou", escolhendo o atendimento que serve de evidência, já selecionado no mais recente. Sem atendimento adequado, o formulário já oferece registrar um resumo de uma linha.

Se o cliente ainda não respondeu, usa-se o bloqueio existente (depende do cliente, com data de cobrança), e o sinal "Cliente em atraso" já cobre o resto.

### 4.3 Entrega e aceite

- "Marcar como entregue" substitui "Concluir" quando a demanda tem critérios. Grava o marco e renova o compromisso, agora aguardando o cliente.
- A fila mostra os critérios como lista de marcar. O aceite tem três resultados:

| Resultado            | Efeito                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| Aceito               | Conclui a demanda, com a evidência                                                    |
| Aceito com ressalvas | Conclui e registra quais critérios ficaram de fora e o motivo                         |
| Recusado             | Volta para execução, com os critérios não atendidos e o motivo. Conta como retrabalho |

Sem critérios, "Concluir" continua sendo um clique, como hoje.

### 4.4 Mudança e trabalho fora do contrato

Ao criar nova versão do combinado, ou ao receber recusa por algo fora dos critérios, a pessoa escolhe:

- **Ajuste dentro do combinado:** segue.
- **Mudança de escopo:** abre o change request existente, já com a demanda e o motivo. A decisão comercial continua humana.

Na **segunda** mudança da mesma demanda, a fila mostra o sinal abaixo, para o gestor e o PO.

## 5. Variações, sem aprovações desnecessárias

| Modelo                        | Combinado                                             | Confirmação do cliente            | Aceite                                               |
| ----------------------------- | ----------------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| Manutenção simples            | Opcional. Sem critérios, tudo funciona como hoje      | Opcional                          | Só se houver critérios                               |
| Manutenção com item de escopo | Preenchido sozinho, sem ação                          | Opcional                          | Só se houver critérios                               |
| Implantação                   | Sinal se faltar ao ficar pronta. **Avisa, não trava** | Sinal se executar sem confirmação | Pedido ao concluir, com ressalva registrada se pular |

Nenhuma regra bloqueia uma transação. Quem decide seguir sem aceite segue, e isso fica registrado.

## 6. Sinais novos na fila

Mesmas regras de hoje: determinísticos, sem repetição, com um único alerta aberto por demanda e condição. Os prazos são parâmetros iniciais do piloto, não SLAs.

| Sinal                      | Regra                                                 | Quem vê como "Com você" |
| -------------------------- | ----------------------------------------------------- | ----------------------- |
| Sem combinado              | Implantação pronta ou em execução, sem combinado      | PO, gestor              |
| Executando sem confirmação | Implantação em execução, combinado não confirmado     | PO, gestor              |
| Aguardando aceite          | Entregue, compromisso vencido                         | Dono, PO, gestor        |
| Mudança repetida           | 2 ou mais mudanças no combinado, ou 2 ou mais recusas | PO, gestor              |
| Reaberta                   | `done → triage` nos últimos 30 dias, sem motivo novo  | Dono, gestor            |

## 7. Modelo de dados

Migration `011`, só aditiva, no mesmo padrão da `010`: a versão anterior da aplicação continua funcionando, e o rollback do código não exige voltar o banco.

```
request_agreements   só inclusão; uma linha por versão
  request_id, version, deliverable, criteria (jsonb: id, text), exclusions,
  source (scope_item | proposal | manual), scope_item_id, change_kind (adjust | scope),
  reason, created_by, created_at

agreement_confirmations   só inclusão
  agreement_id, evidence_interaction_id (obrigatório), confirmed_by_contact,
  recorded_by, recorded_at

request_acceptances   só inclusão
  agreement_id, result (accepted | accepted_with_notes | rejected),
  criteria_results (jsonb: id, met, note), reason, evidence_interaction_id (obrigatório),
  recorded_by, recorded_at

requests   nova coluna anulável
  delivered_at
```

- `request_events` ganha os valores `agreement`, `delivered` e `acceptance` em `changes`.
- **Demandas existentes:** ficam sem combinado, e nada é preenchido por suposição.
- **Gates:** as três tabelas são dados de negócio e entram na comparação exata do G4 e do script de rollout, ao contrário de `automation_jobs` e `demand_alerts`.

## 8. API e permissões

Mesmas regras do servidor: identidade vem da sessão, CSRF nas escritas, idempotência nas criações e bloqueio otimista por `version`.

| Rota                                       | Quem                                       |
| ------------------------------------------ | ------------------------------------------ |
| `POST /api/requests/:id/agreement`         | PO, gestor, administrador                  |
| `POST /api/requests/:id/agreement/confirm` | PO, gestor, administrador                  |
| `POST /api/requests/:id/delivered`         | Dono da demanda, PO, gestor, administrador |
| `POST /api/requests/:id/acceptance`        | PO, gestor, administrador                  |
| `GET /api/followup/:id/events`             | Já existe; passa a mostrar as versões      |

- **Desenvolvedor:** lê o combinado e os critérios das próprias demandas, e marca como entregue. **Não registra aceite do cliente**, porque não pode atestar a própria entrega.
- **Separação:** aceite registrado por quem apontou horas na demanda fica marcado na trilha. Decisão pendente na seção 12.
- **Tenants:** todas as consultas filtram por organização, e a evidência precisa ser um atendimento do mesmo projeto.

## 9. Medição

Medidos a partir de `request_events` e das tabelas novas, por modelo de demanda. Os valores só valem com dados do piloto real, comparando períodos equivalentes.

| Indicador                   | Definição                                                          |
| --------------------------- | ------------------------------------------------------------------ |
| Retrabalho                  | Demandas com recusa ou reabertura, sobre as entregues              |
| Mudanças por demanda        | Versões do combinado depois da confirmação                         |
| Mudanças que viraram escopo | Mudanças marcadas como escopo que abriram change request           |
| Tempo até o aceite          | De "entregue" até o aceite                                         |
| Cobertura do combinado      | Demandas de implantação com combinado confirmado antes de executar |
| Esforço do PO               | Cliques + campos por tarefa, com o mesmo `Meter`                   |

**Falta uma linha de base:** antes de habilitar, é preciso medir as reaberturas e a duração das demandas nos dados que a `010` já registra. Sem isso, não haverá comparação.

## 10. Critérios de aceite do incremento

**Sem burocracia, medido:**

| Tarefa do PO                                          | Hoje       | Limite                  |
| ----------------------------------------------------- | ---------- | ----------------------- |
| Registrar manutenção simples                          | 3 + 1      | Igual                   |
| Levar manutenção simples até o fim, sem critérios     | 7 + 2      | Igual                   |
| Combinado com item de escopo                          | Não existe | Até 1 clique, 0 campos  |
| Confirmação do cliente com o atendimento mais recente | Não existe | Até 2 cliques, 0 campos |
| Aceite integral                                       | Não existe | Até 2 cliques, 0 campos |

**Provar no navegador, com usuários sintéticos:**

1. Manutenção simples percorre o fluxo atual, sem nenhum passo novo.
2. Implantação vai de combinado a aceite, com evidências e trilha.
3. Nenhuma demanda é aceita sem ação humana, mesmo com o compromisso vencido.
4. Recusa volta para execução, com o motivo, e conta como retrabalho.
5. Segunda mudança gera um só sinal, para as pessoas certas.
6. Mudança de escopo abre o change request existente, e a decisão continua comercial.
7. Combinado antigo fica legível depois de uma nova versão, e a trilha não pode ser reescrita.
8. Desenvolvedor não registra aceite, nem lê demanda de outro; outra organização não lê nada.
9. A automação parada não impede registrar combinado, confirmação ou aceite.

**Técnicos:** concorrência (dois aceites simultâneos), recuperação, mais de 500 demandas, migration sobre dados existentes, rollback com a versão anterior, `validate`, `quality` e G4 verdes.

## 11. Orçamento: o principal risco técnico

Em `cea8960` sobram **576 bytes de JS bruto** e **35 bytes de CSS gzip**. Esta interface não cabe nessa folga, e aumentar limites não é a primeira opção.

Antes de implementar, nesta ordem:

1. **PR de compressão HTTP,** que você já pediu. Ele pode justificar rever qual medida (bruta ou comprimida) o orçamento deve controlar, como decisão sua, com medições.
2. **Unificar o que hoje está duplicado:** a fila e a lista completa de Solicitações mostram quase o mesmo cartão.
3. **Limpar o CSS** antes de acrescentar qualquer regra.

## 12. Decisões que dependem de você

1. **Implantação sem aceite:** a especificação avisa e registra, sem travar. Recomendo começar assim e endurecer só com dados do piloto.
2. **Separação no aceite:** quem apontou horas pode registrar o aceite do cliente? Recomendo permitir e marcar na trilha, porque em equipes pequenas o PO costuma ter feito as duas coisas.
3. **Portal do cliente:** fica fora. Recomendo reavaliar só se o registro pela equipe mostrar divergências no piloto.
4. **Papel Comercial:** continua fora. Hoje, a pessoa comercial usa o papel de PO.

## 13. Fora do escopo

Portal ou login do cliente; envio de e-mail, chat ou assinatura eletrônica; IA para escrever critérios; faturamento ligado ao aceite; etapas de QA e go-live; alteração das regras econômicas.

## 14. Ordem sugerida

1. Rollout de `cea8960` validado por pessoas reais e linha de base medida.
2. Compressão HTTP e folga de orçamento.
3. Modelo de dados, API e testes, sem interface.
4. Interface na fila e no formulário atual, medindo o esforço a cada passo.
5. Piloto com poucas demandas de implantação, antes de abranger o resto.
