# Eficiência operacional: Nenhuma demanda esquecida

Auditoria do Catus OS em `75a9c14`, fluxo proposto para a agência e o primeiro incremento. Dados sintéticos em bancos descartáveis. Nada aqui foi validado por pessoas reais, e nenhum ganho de negócio foi medido: isso só um piloto real confirma.

## 1. Mapa AS-IS

Como foi avaliado: leitura do código, jornadas de navegador já existentes (`e2e/pilot-journey`, `commercial`, `economics`) e sondagem por papel em `docs/quality/ops-followup/measure-before.spec.ts.txt`, com o resultado em `antes/as-is.json`. **IMPLEMENTADA** significa que a etapa funciona em teste sintético, não que foi validada por pessoas.

O sistema tem quatro papéis: administrador, gestor, PO e desenvolvedor. **Não existe papel Comercial**: na auditoria, a pessoa comercial usou o papel de PO.

### A. Novo cliente

| Etapa           | Estado       | O que existe                                                          |
| --------------- | ------------ | --------------------------------------------------------------------- |
| Descoberta      | PARCIAL      | Atendimento do tipo reunião, com resumo em texto livre                |
| Briefing        | AUSENTE      | Nenhum registro próprio                                               |
| Proposta        | AUSENTE      | Nada entre o atendimento e o contrato                                 |
| Contrato        | IMPLEMENTADA | Cadastro, vigência e estados                                          |
| Escopo          | IMPLEMENTADA | Versões, itens, aprovação independente                                |
| Orçamento       | PARCIAL      | Termos econômicos e estimativas; sem orçamento apresentado ao cliente |
| Planejamento    | PARCIAL      | Data prevista na estimativa; sem cronograma                           |
| Desenvolvimento | IMPLEMENTADA | Estados, responsável e horas                                          |
| QA              | AUSENTE      | Sem etapa nem evidência                                               |
| Aceite          | PARCIAL      | Critérios no item de escopo; sem registro do aceite                   |
| Go-live         | AUSENTE      | Sem registro de publicação                                            |
| Suporte         | AUSENTE      | Sem tipo de demanda nem acompanhamento                                |

### B. Cliente existente

| Etapa                    | Estado       | O que existe                              |
| ------------------------ | ------------ | ----------------------------------------- |
| Solicitação de alteração | IMPLEMENTADA | Atendimento, solicitação e change request |
| Verificação contratual   | IMPLEMENTADA | Vínculo manual ao item de escopo aprovado |
| Estimativa               | IMPLEMENTADA | Registro econômico com aprovação          |
| Priorização              | AUSENTE      | Só a ordem por estado                     |
| Execução                 | IMPLEMENTADA | Estados e horas                           |
| Revisão                  | AUSENTE      | Sem etapa                                 |
| Entrega                  | PARCIAL      | Só o estado "Concluída"                   |

### C. Suporte

| Etapa             | Estado       | O que existe                     |
| ----------------- | ------------ | -------------------------------- |
| Incidente urgente | AUSENTE      | Sem tipo nem urgência            |
| SLA               | AUSENTE      | Sem prazo nem relógio            |
| Atribuição        | IMPLEMENTADA | Responsável na solicitação       |
| Resolução         | PARCIAL      | Estados genéricos                |
| Comunicação       | AUSENTE      | Sem registro de aviso ao cliente |
| Fechamento        | PARCIAL      | Só o estado "Concluída"          |
| Aprendizado       | AUSENTE      | Sem registro                     |

### Atritos encontrados

- **Demanda sem prazo:** `requests` não tinha compromisso, motivo de bloqueio nem dependência. "Cobrar em 2 dias" era texto livre.
- **Trabalho parado invisível:** o cartão parado há 12 dias era igual aos outros e ficava por último na lista.
- **Campos repetidos:** registrar exigia selecionar o atendimento, responsável e texto de próxima ação a cada demanda.
- **Dados defasados entre papéis:** o que o PO mudava só aparecia para o desenvolvedor depois de "Atualizar dados".
- **Decisão sem dono:** uma demanda nova de um desenvolvedor dependia do PO, e nada indicava isso a ele.
- **Risco fora do contrato:** "Pendente de análise comercial" aparecia igual em demanda parada e em demanda já em execução.

## 2. Fluxo TO-BE

Um único item de trabalho, a solicitação, com etapas que dependem da variação. Cada etapa mostra responsável, próxima ação e compromisso.

| Variação           | Caminho                                                                                                                      | Aprovações                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Manutenção simples | Nova → Pronta → Em execução → Concluída                                                                                      | Nenhuma além da cobertura, se houver trabalho fora do contrato |
| Projeto pontual    | Nova → Triagem → cobertura e estimativa → Pronta → Em execução → Revisão → Aceite → Concluída                                | Escopo e estimativa                                            |
| Implantação        | Descoberta → Briefing → Proposta → Contrato e escopo → Orçamento → Planejamento → Execução → QA → Aceite → Go-live → Suporte | Contrato, escopo, orçamento, publicação                        |
| Emergência         | Incidente → Atribuição imediata → Resolução → Comunicação → Fechamento → Aprendizado; cobertura analisada depois             | Publicação e comercial continuam humanas                       |

Campos por etapa, além do responsável e da próxima ação: compromisso; motivo e dependência quando bloqueada; cobertura ao executar; horas previstas, consumidas e restantes quando houver estimativa; evidências de revisão, QA, aceite e publicação nas etapas futuras. O histórico vem de `request_events` e `audit_events`.

Decisões comerciais, contratuais e de publicação permanecem humanas. O servidor continua sendo a autoridade, e as regras econômicas não mudam.

## 3. Lacunas e automações priorizadas

| #   | Lacuna                                    | Automação                                   | Retorno esperado | Esforço | Situação            |
| --- | ----------------------------------------- | ------------------------------------------- | ---------------- | ------- | ------------------- |
| 1   | Demanda sem dono, prazo ou acompanhamento | Fila de ações e alertas sem repetição       | Alto             | Médio   | **Este incremento** |
| 2   | Revisão, QA e aceite sem evidência        | Etapas opcionais com evidência              | Alto             | Médio   | Backlog             |
| 3   | Incidente sem SLA                         | Variação Emergência com relógio             | Alto             | Médio   | Backlog             |
| 4   | Sem proposta nem briefing                 | Modelo guiado até o contrato                | Médio            | Alto    | Backlog             |
| 5   | Sem priorização                           | Ordem explícita por gestor                  | Médio            | Baixo   | Backlog             |
| 6   | Avisos só dentro do sistema               | E-mail ou chat a partir da fila persistente | Médio            | Médio   | Backlog             |
| 7   | Sem papel Comercial                       | Papel próprio, sem acesso a mais dados      | Baixo            | Baixo   | Backlog             |

"Retorno esperado" é uma avaliação qualitativa, não uma medição.

## 4. Primeiro incremento

### O que mudou

- **Fila de ações em Solicitações:** "Com você" e "Da equipe", calculada a cada leitura sobre todas as demandas abertas.
- **Registro único e curto:** só o título é obrigatório. O modelo define a próxima ação e o compromisso, a sessão define o responsável, e o atendimento mais recente é a origem. O formulário 04 de "Clientes e projetos" saiu.
- **Um formulário de atualização:** o mesmo para a fila e para os cartões, com compromisso, motivo e dependência.
- **Mudança de etapa revendo a próxima ação:** nada é gravado até salvar. Concluir é um clique, porque não há próxima ação.
- **Manutenção sem triagem separada:** só o PO, o gestor ou o administrador podem liberar; o desenvolvedor continua sem essa permissão.
- **Painel "Bloqueios" removido do Mission Control:** a fila substitui, e o Mission Control aponta para ela sem chamada de API a mais na abertura.

### Regras determinísticas

Em `src/server/followup/rules.ts`. Os números são parâmetros iniciais, não metas.

| Condição                  | Regra                                                         | Quem vê como "Com você"                 |
| ------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| Em execução sem cobertura | Sem item de escopo aprovado e em execução                     | PO, gestor                              |
| Sem responsável           | Sem dono, ou dono inativo                                     | PO, gestor                              |
| Compromisso vencido       | Data anterior a hoje                                          | Dono, gestor                            |
| Cliente em atraso         | Bloqueada aguardando o cliente, com data vencida              | Dono, PO, gestor                        |
| Acima das horas estimadas | Horas aprovadas e pendentes maiores que o estimado            | Gestor (só gestor e administrador leem) |
| Sem cobertura comercial   | Implantação pronta; manutenção não pergunta antes de executar | PO, gestor                              |
| Parada                    | 3 dias na manutenção, 7 na implantação, sem movimentação      | Dono                                    |
| Bloqueada                 | Dentro do prazo, com o motivo                                 | Dono, gestor                            |
| Sem compromisso           | Pronta, em execução ou bloqueada, sem data                    | Dono                                    |
| Aguardando liberação      | Nova ou em triagem                                            | Dono, PO, gestor                        |
| Excesso de trabalho       | Mais de 5 demandas em execução na mesma pessoa                | Aviso para PO, gestor e administrador   |

Compromissos contam dias úteis, sem feriados, e usam o dia em UTC, como o restante do sistema.

### Automação e falhas

- **Eventos:** `request_events`, gravado por gatilho na mesma transação da mudança. Nenhum caminho de código pode pular, e é só de inclusão.
- **Fila persistente:** `automation_jobs`, com chave de idempotência, `FOR UPDATE SKIP LOCKED`, concessão com prazo, nova tentativa com espera crescente e limite de 6 tentativas.
- **Alertas sem repetição:** `demand_alerts` admite um único aberto por demanda e condição. Um novo episódio gera um novo alerta.
- **Falha da automação:** a transação da demanda não depende dela, e a fila é calculada a cada leitura. Gestor e administrador veem o aviso de atraso, e a varredura seguinte recupera o que falhou.
- **Sem serviço externo e sem IA:** roda no processo da API. `FOLLOWUP_AUTOMATION=off` desliga só os alertas.

### Implantação futura

Exige backup e autorização. A migration `010` só acrescenta colunas anuláveis, sem reescrever a tabela, e tabelas novas. A versão anterior da aplicação continua funcionando com esse esquema, o que permite voltar o código sem voltar os dados. As demandas existentes ficam sem compromisso até a primeira mudança de etapa, e a fila as sinaliza como "Sem compromisso". Nada é preenchido na migration.

### Antes e depois

Mesma regra de contagem (`Meter`), mesmas pessoas e mesmos dados sintéticos. Cliques + campos. Tempos são de execução automatizada em uma máquina, não de uma pessoa, e servem só para comparar passos.

| Tarefa                             | Antes                 | Depois                   | O que mudou além dos cliques                            |
| ---------------------------------- | --------------------- | ------------------------ | ------------------------------------------------------- |
| Registrar demanda                  | 6 + 3                 | **3 + 1**                | Agora nasce com compromisso                             |
| Localizar o que precisa de ação    | 9 + 0, 3 de 6 sinais  | **1 + 0, 6 de 6 sinais** | Parada, vencida e atraso de cliente passam a existir    |
| Bloquear por causa do cliente      | 8 + 1, em texto livre | **5 + 1, estruturado**   | Motivo, dependência e data de cobrança                  |
| Dar dono a demanda sem responsável | 4 + 0                 | **1 + 0**                | 212 → 164 ms                                            |
| Levar uma demanda até o fim        | 24 + 4                | **7 + 2**                | 4 passagens manuais viram 3, com a próxima ação revista |

Resultados em `docs/quality/ops-followup/antes/as-is.json` e `depois/depois.json`.

## 5. Backlog enxuto

1. Etapas de revisão, QA e aceite com evidência, sem obrigar a manutenção.
2. Variação Emergência: urgência, relógio de SLA e registro de comunicação.
3. Notificação externa a partir de `automation_jobs`, sem bloquear transações.
4. Priorização explícita pelo gestor.
5. Exibir o histórico (`GET /api/followup/:id/events`) e o tempo por etapa, já disponíveis na API.
6. Modelo de implantação com descoberta, briefing e proposta.
7. | Feriados e fuso da organização nos compromissos. | Tarefa                | Antes                    | Depois           | Tempo automatizado                                      | O que mudou além dos cliques |
   | ------------------------------------------------ | --------------------- | ------------------------ | ---------------- | ------------------------------------------------------- | ---------------------------- |
   | Registrar demanda                                | 6 + 3                 | **3 + 1**                | 370 → 491 ms     | Agora nasce com compromisso                             |
   | Localizar o que precisa de ação                  | 9 + 0, 3 de 6 sinais  | **1 + 0, 6 de 6 sinais** | 302 → 295 ms     | Parada, vencida e atraso de cliente passam a existir    |
   | Bloquear por causa do cliente                    | 8 + 1, em texto livre | **5 + 1, estruturado**   | 889 → 1.878 ms   | Motivo, dependência e data de cobrança                  |
   | Dar dono a demanda sem responsável               | 4 + 0                 | **1 + 0**                | 212 → 141 ms     |                                                         |
   | Levar uma demanda até o fim                      | 24 + 4                | **7 + 2**                | 5.798 → 1.867 ms | 4 passagens manuais viram 3, com a próxima ação revista |

Três tempos pioraram (registrar, localizar e bloquear). Têm menos passos, mas agora recarregam os dados, e bloquear passa também pela liberação e pela sessão de outra pessoa. As medições são de uma máquina e variam entre execuções.

Resultados em `docs/quality/ops-followup/antes/as-is.json` e `depois/depois.json`.

## 5. Backlog enxuto

1. Etapas de revisão, QA e aceite com evidência, sem obrigar a manutenção.
2. Variação Emergência: urgência, relógio de SLA e registro de comunicação.
3. Notificação externa a partir de `automation_jobs`, sem bloquear transações.
4. Priorização explícita pelo gestor.
5. Exibir o histórico (`GET /api/followup/:id/events`) e o tempo por etapa, já disponíveis na API.
6. Modelo de implantação com descoberta, briefing e proposta.
7. Feriados e fuso da organização nos compromissos.

## 6. Efeito na homologação e nos gates

A automação roda sozinha, então `automation_jobs` e `demand_alerts` mudam com o sistema parado. São dados operacionais derivados das demandas.

- **G4, comparação exata:** a impressão digital do estágio C passa a ignorar essas duas tabelas, como já fazia com `rate_limits` e `oidc_transactions`. As tabelas de negócio, inclusive `requests` e `request_events`, continuam comparadas.
- **G4, verificações complementares:** cada tabela recebe uma linha sintética, e o G4 compara as colunas imutáveis das linhas existentes no instante do backup, na restauração, ao recriar os contêineres e após down/up. Também confere as invariantes: um alerta aberto por demanda e condição, datas coerentes, trabalhos sem estado impossível e índices únicos válidos.
- **Rollout:** veja `docs/ROLLOUT_FOLLOWUP.md`.

## 7. Limites conhecidos

- A fila cobre todas as demandas abertas, sem limite. A lista completa de Solicitações mostra as 500 mais recentes e avisa quando chega a esse número.
- A fila mostra 60 cartões por grupo de cada vez, com a contagem total e "Mostrar mais".
- A varredura de 650 demandas levou cerca de 100 ms em teste, com dados simples. Não foi medida com volume real de horas e estimativas.
