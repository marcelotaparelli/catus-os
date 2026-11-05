# Especificação: Alinhamento e Aceite de Demandas

**Situação:** revisada com as decisões do responsável (seção 12). O menor incremento está em branch própria, `feat/alinhamento-aceite`, sem merge. A seção 14 separa o que ele entrega do que ficou para depois.

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
4. **Sem portal do cliente e sem papel Comercial neste incremento.** Quem registra é a equipe, apontando a evidência.
5. **Determinístico.** Sem IA e sem API externa.

## 4. Fluxo

```
Pedido ─▶ Combinado ─▶ Confirmado pelo cliente ─▶ Execução ─▶ Entregue ─▶ Aceito ─▶ Concluída
              ▲                                                  │
              └──────────── mudança ou recusa, com motivo ◀──────┘
```

Tudo acontece nos estados que já existem; "Entregue" é um marco dentro de "Em execução", não um estado novo.

### 4.1 Combinado

Um formulário no próprio cartão da fila, com "Critérios de aceite" e a marcação de alto risco. Os critérios vêm do item de escopo ou de `suggested_acceptance_criteria`, quando existem.

Salvar sem alterar confirma o que veio preenchido. Mudar depois cria uma nova versão, pede o motivo e conta como mudança; a anterior fica guardada.

### 4.2 Confirmação do cliente

"Cliente confirmou" usa como evidência o atendimento mais recente do projeto, mostrado no formulário, ou o que a pessoa escrever em uma linha, que vira um novo atendimento.

Se o cliente ainda não respondeu, usa-se o bloqueio existente (depende do cliente, com data de cobrança), e o sinal "Cliente em atraso" já cobre o resto.

### 4.3 Entrega e aceite

"Marcar como entregue" substitui "Concluir" quando a demanda tem critérios. Grava o marco e renova o compromisso, agora aguardando o cliente.

| Resultado           | Efeito                                                                      |
| ------------------- | --------------------------------------------------------------------------- |
| Aceito              | Conclui a demanda, com a evidência                                          |
| Recusado            | Continua em execução, com o motivo como próxima ação. Conta como retrabalho |
| Concluir sem aceite | Conclui e registra exatamente isso. Não é aceite                            |

Sem critérios, "Concluir" continua sendo um clique, como hoje.

### 4.4 Mudança repetida

A partir da **segunda** mudança ou recusa, somadas, a fila mostra o sinal da seção 6 para o gestor e o PO. A decisão sobre escopo continua no caminho comercial existente, "Analisar cobertura".

## 5. Variações, sem aprovações desnecessárias

| Modelo                        | Combinado                                             | Confirmação do cliente            | Aceite                                               |
| ----------------------------- | ----------------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| Manutenção simples            | Opcional. Sem critérios, tudo funciona como hoje      | Opcional                          | Só se houver critérios                               |
| Manutenção com item de escopo | Vem preenchido, se alguém abrir                       | Opcional                          | Só se houver critérios                               |
| Implantação                   | Sinal se faltar ao ficar pronta. **Avisa, não trava** | Sinal se executar sem confirmação | Pedido ao concluir, com ressalva registrada se pular |

Falta de combinado, de confirmação ou de aceite nunca bloqueia: avisa e fica na auditoria. Há só duas recusas, ambas de decisão do responsável: alto risco sem autorização (seção 5.1) e desenvolvedor encerrando uma entrega com critérios (seção 8).

### 5.1 Operações de alto risco

O sistema não sabe sozinho o que é arriscado, então é uma marcação humana: PO, gestor ou administrador marca "Alto risco" no combinado. Exemplos: migração ou exclusão de dados, mudança sem volta em produção, credenciais e pagamentos.

- **O que fica impedido:** iniciar execução, marcar como entregue e concluir, até um gestor ou administrador clicar em "Autorizar alto risco".
- **A autorização vale para uma versão.** Mudar o combinado pede autorização de novo.
- **Quem retira a marcação:** só gestor ou administrador; o PO não pode, porque isso removeria a autorização. Tudo fica na trilha.
- **Nunca automático:** nenhum prazo ou varredura autoriza.

## 6. Sinais novos na fila

Mesmas regras de hoje: determinísticos, sem repetição, com um único alerta aberto por demanda e condição.

| Sinal                      | Regra                                               | Quem vê como "Com você" |
| -------------------------- | --------------------------------------------------- | ----------------------- |
| Alto risco sem autorização | Combinado marcado, versão atual não autorizada      | Gestor, administrador   |
| Aguardando aceite          | Entregue e sem resposta do cliente                  | PO, gestor              |
| Sem combinado              | Implantação pronta ou em execução, sem combinado    | PO, gestor              |
| Executando sem confirmação | Implantação em execução, combinado não confirmado   | PO, gestor              |
| Mudança repetida           | 2 ou mais mudanças no combinado, somadas às recusas | PO, gestor              |

Demandas de implantação já abertas passam a mostrar "Sem combinado", porque nada é preenchido por suposição.

## 7. Modelo de dados

Migration `011`, só aditiva: a versão anterior da aplicação continua funcionando, e o rollback do código não exige voltar o banco.

```
request_alignment   só inclusão; uma linha por fato
  request_id, kind, agreement_version, criteria, high_risk, reason,
  evidence_interaction_id, recorded_by, recorded_by_executor, recorded_at

kind: agreement | confirmation | risk_authorization | delivered |
      accepted | rejected | closed_without_acceptance
```

Uma só tabela substitui as três previstas antes e dispensa coluna nova em `requests`: o estado atual é calculado das linhas.

- **O banco garante:** confirmação, aceite e recusa sem evidência são recusados por `CHECK`, e alterar ou apagar uma linha é recusado por trigger.
- **Demandas existentes:** ficam sem linhas.
- **Gates:** é dado de negócio e entra na comparação exata do G4, que já compara toda tabela não listada como transitória.

## 8. API e permissões

Mesmas regras do servidor: identidade vem da sessão, CSRF nas escritas e bloqueio otimista por `version`.

`POST /api/requests/:id/alignment`, com `kind`, e `GET` na mesma rota para ler a trilha:

| `kind`                 | Quem                                       |
| ---------------------- | ------------------------------------------ |
| `agreement`            | PO, gestor, administrador                  |
| `confirmation`         | PO, gestor, administrador                  |
| `risk_authorization`   | Gestor, administrador                      |
| `delivered`            | Dono da demanda, PO, gestor, administrador |
| `accepted`, `rejected` | PO, gestor, administrador                  |

- **Evidência:** precisa ser um atendimento do mesmo projeto. Para aceite e recusa, com data posterior à entrega, então um atendimento antigo não serve de prova.
- **Desenvolvedor:** lê o combinado das próprias demandas e marca como entregue. Não registra aceite e não conclui demanda com combinado, nem pela rota de atualização.
- **PO que também executou:** pode registrar, porque a evidência é do cliente, e a linha fica marcada com `recorded_by_executor`.
- **Concluir sem aceite:** PO, gestor ou administrador. Grava `closed_without_acceptance`, nunca aceite.
- **Tenants:** todas as consultas filtram por organização.

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

**Linha de base:** `bun run baseline:alinhamento [AAAA-MM-DD]` lê os dados que a `010` já registra e devolve só agregados por modelo de demanda, em transação `READ ONLY`: retrabalho, reaberturas, tempo de ciclo, contatos com o cliente, ações e horas do PO e horas sobre a estimativa. O esforço de cliques e campos vem do `Meter`, nas jornadas. Reaberturas anteriores à `010` não existem no histórico, e o relatório informa desde quando há eventos e marca amostras com menos de 20 demandas.

## 10. Critérios de aceite do incremento

**Sem burocracia, medido:**

| Tarefa do PO                                      | Hoje       | Limite              |
| ------------------------------------------------- | ---------- | ------------------- |
| Registrar manutenção simples                      | 3 + 1      | Igual               |
| Levar manutenção simples até o fim, sem critérios | 7 + 2      | Igual               |
| Combinado com critérios já existentes             | Não existe | 2 cliques, 0 campos |
| Confirmação com atendimento já registrado         | Não existe | 2 cliques, 0 campos |
| Aceite com atendimento posterior à entrega        | Não existe | 2 cliques, 0 campos |
| Aceite sem atendimento                            | Não existe | 2 cliques, 1 campo  |

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

Em `f1067b8` sobram **576 bytes de JS bruto** e **35 bytes de CSS gzip**. A ordem é reduzir antes de pedir mais: gerar os botões de uma lista, levar textos da trilha para o servidor e não criar nenhuma regra de CSS. Qualquer aumento de limite é decisão do responsável, com as medições no PR.

## 12. Decisões do responsável

| Assunto                            | Decisão                                          |
| ---------------------------------- | ------------------------------------------------ |
| Manutenção simples                 | Sem burocracia adicional                         |
| Implantação sem confirmação        | Avisar e auditar, sem bloqueio geral             |
| Operações de alto risco            | Exigem autorização humana                        |
| Aceite                             | O PO pode registrar, com evidência do cliente    |
| Separação                          | Desenvolvedor não pode atestar a própria entrega |
| Portal do cliente, papel Comercial | Fora deste incremento                            |
| Silêncio                           | Nunca significa aceite                           |

**Interpretações a confirmar:** quem define e autoriza o alto risco (seção 5.1), e o PO que também executou poder registrar, com marcação (seção 8).

## 13. Fora do escopo

Portal ou login do cliente; papel Comercial; envio de e-mail, chat ou assinatura eletrônica; IA para escrever critérios; faturamento ligado ao aceite; etapas de QA e go-live; alteração das regras econômicas.

## 14. O que o menor incremento entrega

**Entrega:** critérios versionados, confirmação, entrega, aceite e recusa com evidência, autorização de alto risco, os cinco sinais, a trilha legível e a linha de base.

**Fica para depois, para caber no menor incremento:**

- "O que será entregue" e "Fora do combinado" como campos próprios, e pré-preenchimento pelo item de escopo além dos critérios.
- Aceite com ressalvas e critérios como lista de marcar. Hoje, ressalvas vão no texto da evidência.
- Mudança que abre `change_request` já preenchido. Hoje, "Analisar cobertura" continua sendo o caminho.
- Sinal de reabertura sem motivo, e motivo ao reabrir.

**Depois:** piloto com poucas demandas de implantação, comparando com a linha de base.
