# M4 — Inteligência econômica auditável

Implementação da [issue #2](https://github.com/marcelotaparelli/catus-os/issues/2), a partir da HEAD M3 `e0631d9a2c2b05fd8f99506c5dcb92fe5405748d`, em `feat/m4-economics`. Somente dados sintéticos nesta entrega. Não há conexão contábil/bancária, conversão de moeda, inferência por IA ou execução de agentes.

## Execução incremental

Preservar `.env`, dados e migrations 001–007. Pré-requisitos e HTTPS/identidade em HOMOLOGATION.md; banco local loopback disponível:

```sh
npm ci
npm run db:roles
npm run migrate
npm run test:db
npm run check
npm run build
npm run tls:local
npm test
npm run format:check
npx playwright install --with-deps chromium # quando necessário
npm run test:e2e
npm run start
```

Neste ambiente, `CHROMIUM_PATH=/tmp/chromium npm run test:e2e`. Executar APIs e Playwright sequencialmente: usam o mesmo banco descartável de regressão. Backup/restore usa Docker local e clientes PostgreSQL fixados por digest, conforme M1.1; não requer conta de nuvem. Suíte M4 cria bancos e roles descartáveis separados e compara/recalcula todas as observações após restore. Aplicativo normal continua exigindo OIDC; não usar o harness test-only para autenticar pessoas reais.

Migration **008_economics.sql** é aditiva; não altera tabelas, conteúdos, escopos, decisões, valores históricos ou migrations anteriores. Nenhum projeto recebe automaticamente configuração, preço, taxa ou estimativa. `db:roles`/`migrate` aplicam grants mínimos sem trocar senhas. Todas as entidades M4 são append-only, com triggers que recusam UPDATE/DELETE, além dos grants restritos.

## Unidades, limites e precisão

- **Dinheiro:** string decimal canônica inteira, não negativa, até 15 algarismos, na menor unidade da moeda. BRL/USD/EUR etc. usam centavos (exponente 2); JPY/CLP usam unidade inteira (exponente 0). `10000` BRL = BRL 100,00. Não aceitar floats, sinal negativo, notação científica, zeros à esquerda ou preço formatado. Zero é permitido **somente quando explicitamente informado**.
- **Duração:** minutos inteiros. Apontamento 1–1440; soma por usuário/dia, incluindo pendentes, não ultrapassa 1440. Estimativa/capacidade/saldo até 10.000.000 minutos por campo. Não arredondar horas digitadas: informar minutos.
- **Tributos/comissões:** pontos-base inteiros, 0–10000 cada, soma até 10000. 1000 bps = 10%. São deduções proporcionais explicitamente configuradas sobre receita relevante; não há cálculo fiscal de regimes/IVA/retenções.
- **Aritmética monetária:** somente `BigInt` no motor, incluindo multiplicações, somas e percentuais; strings na API/PostgreSQL JSONB preservam inteiros. Não há `parseFloat`, ponto flutuante para dinheiro ou divisão monetária em Number.
- **Arredondamento:** nearest, half away from zero, em cada fronteira de linha de trabalho/overhead e em cada dedução percentual, depois soma das linhas. Para custos positivos: `round(minutos × taxa_minor_por_hora / 60)`. Percentual de margem calculado em bps, com mesmo arredondamento. Não arredondar de novo valores já persistidos.
- **Datas:** ISO `YYYY-MM-DD`, de 2000 a 2100, competências/vigências inclusivas e UTC. Não aceitar horas futuras. Corte de relatório não pode ser futuro nem anterior ao início dos termos. Os valores observados representam conhecimento no instante de geração, filtrando datas trabalhadas até o corte; um relatório novo de competência passada não pretende reconstruir o que se sabia naquela época. Observações antigas preservadas são a prova do conhecimento anterior.
- **Moedas:** conjunto M3, sem câmbio automático. Termos devem usar a moeda do contrato; custos/taxas incompatíveis tornam o cálculo dependente incompleto, nunca são somados como se fossem equivalentes. Taxas sobrepostas do mesmo profissional/função são recusadas, inclusive entre moedas, para não escolher arbitrariamente uma moeda.

## Entidades e autoria

`economic_records` guarda tipo, projeto opcional, série, revisão, predecessor, moeda, período, fonte documental, payload validado por tipo, autor e horário. Tipos: `config`, `rate`, `terms`, `estimate`, `capacity`, `direct_cost`. JSONB evita tabelas vazias por subtipo; fronteira API valida campos, enums, unidades e todas as associações. Entidade relacional tem FK composta por organização/projeto/predecessor. Não aceitar campos desconhecidos ou identidade/competência enviadas pelo frontend.

`economic_decisions` é única por versão: decisão, ator/papel atual, política M3, justificativa, snapshot e data. Todas as versões nascem pendentes; rejeição não produz efeito e não libera edição retroativa. Preparar outra revisão exige `previous_id` da última versão da série e uma decisão na anterior. Só a revisão aprovada mais recente de cada série alimenta novo relatório; uma revisão ainda pendente/rejeitada não substitui a aprovada. Snapshots anteriores não mudam. Períodos aprovados sobrepostos são recusados para configuração da mesma moeda, taxa da mesma pessoa/função, termos do mesmo projeto e capacidade da mesma pessoa/projeto.

`time_entries` mantém usuário real da sessão, projeto/demanda, data, minutos, comentário e correção de origem; `time_events` mantém decisões/reversões com autoria/razão e snapshots de taxa/custo. `economic_reports` mantém corte, versão do motor, inputs completos, resultado e SHA-256 canônico; `economic_events` mantém trilha operacional append-only, com auditoria M1 na mesma transação.

## Permissões e segregação

| Operação                                                              | Gestor/admin                                | PO               | Desenvolvedor    |
| --------------------------------------------------------------------- | ------------------------------------------- | ---------------- | ---------------- |
| Ver taxas, custos, termos monetários, relatórios, auditoria econômica | Sim, organização atual                      | Não              | Não              |
| Preparar config/taxa/termos/capacidade/despesa                        | Sim                                         | Não              | Não              |
| Preparar estimativa de demanda coberta                                | Sim                                         | Sim              | Não              |
| Decidir registro econômico                                            | Alçada M3 explícita, preparador diferente   | Não              | Não              |
| Apontar horas                                                         | Somente próprias                            | Somente próprias | Somente próprias |
| Decidir/reverter horas aprovadas                                      | Gestor/admin diferente do usuário das horas | Não              | Não              |
| Reverter horas próprias pendentes                                     | Sim                                         | Sim              | Sim              |

PO recebe somente estimativas sem snapshots de custo e referências não monetárias de termos aprovados. Desenvolvedor recebe somente apontamentos próprios, sem taxas/custos/relatórios. `GET /api/mission-control`, membros e auditoria comum não contêm valores M4; o painel financeiro usa endpoint separado filtrado por papel. Negação de acesso acontece no servidor, além da UI. O AI worker e maintenance não recebem grants de leitura/escrita M4. Runtime tem SELECT/INSERT, sem UPDATE/DELETE; operadores com credencial direta continuam fora da fronteira de usuários, como no M1. RLS não é alegado como implementado.

Decisões econômicas exigem gestor/admin aceito na política explícita M3 e distinto do preparador. PO não altera taxas nem decide seu próprio impacto. Apontamentos não aprovam escopo, não alteram responsável e não liberam execução. É possível registrar trabalho real sintético fora de cobertura para evidenciar consumo; o relatório alerta e bloqueia margem projetada completa, sem inventar autorização M3.

## Configuração, taxas e capacidade

Configuração por organização/moeda/vigência exige tributos, comissões, calendário ISO de dias da semana, minutos de trabalho/dia e feriados explicitamente declarados. O campo de feriados vazio na UI declara lista vazia; não há importação automática de calendário nacional. Overhead exige uma destas regras:

1. `none_explicit`: declaração auditável de ausência de overhead; taxa null, custo de overhead zero por escolha explícita.
2. `per_labor_minute`: taxa de overhead em unidades mínimas/hora, aplicada proporcionalmente a minutos aprovados/previstos/restantes. A fonte deve documentar como o gestor obteve a taxa. O sistema não calcula uma taxa a partir de um pool inventado nem contabiliza o mesmo overhead como despesa externa.

Taxa de trabalho é por profissional real **ou** por função de custo explícita (`developer`, `po`, `manager`, `administrator`). O agrupamento de custo usa nomes conhecidos, mas **não é inferido do papel de acesso do usuário**: na decisão de estimativa/apontamento, gestor pode declarar `cost_role`; vazio usa somente taxa individual. Não reconstruir função histórica a partir do papel atual. Taxa individual vigente tem precedência; função só é alternativa quando declarada. Snapshot registra ID/valor/moeda/data de referência e declaração do aprovador; ausência de taxa não vira zero.

A aprovação de horas congela `round(minutos × taxa vigente na data trabalhada / 60)`. A aprovação de estimativa congela a taxa vigente na data de conclusão declarada. Alteração futura de taxa, mudança de papel ou nova revisão não reprecificam essas linhas. Para ajuste retroativo, reverter e substituir horas ou preparar nova estimativa com justificativa/fonte; observações antigas continuam imutáveis.

Capacidade é **alocação explícita de disponibilidade** de pessoa/projeto/competência, não horas contratadas ou gastas. Na aprovação, exige calendário configurado e respeita seu teto de dias úteis/feriados × minutos/dia; soma de alocações da mesma pessoa em projetos distintos não pode excedê-lo. Alocações sobrepostas devem alinhar competências, evitando rateio temporal implícito. Zero de disponibilidade é válido se declarado, não default. Não há previsão de ausências ou utilização pessoal presumida.

## Termos econômicos e regimes

Os termos econômicos referenciam contrato e versão de escopo M3 atualmente aprovados, ativos e vigentes. Período dentro do contrato, moeda igual e uma base por projeto/competência, sem sobreposição. Essa limitação evita contabilizar as mesmas horas em contratos concorrentes sem um modelo explícito de alocação. Série de termos versiona o **total substitutivo**, não valores incrementais somados às revisões anteriores.

**Preço fechado:** valor contratado explícito; sem minutos incluídos/overage/rollover. Ajuste de preço é nova revisão com fonte/decisão independente; mudança de escopo exige também change request M3 aprovado apontando para o novo escopo. Escopo pendente não ganha termos aprovados. `recognized_minor` manual não pode exceder o valor aprovado nesse regime.

**Retainer/banco de horas:** valor do período e minutos incluídos explícitos. Receita fixa da competência não depende de saldo consumido. Excedente pode ser `none` (não cria receita adicional) ou `billable`, com preço/hora excedente explicitamente aprovado. Projetar excedente não significa reconhecê-lo ou recebê-lo. Rollover pode ser `none` ou `carry_capped` com teto e entrada explícitos; entrada positiva exige termos anteriores aprovados do mesmo contrato/moeda, período anterior já encerrado e todas as horas decididas. Não cria automaticamente saldo ou receita de outro mês.

Na aprovação de entrada de rollover, validar limite contra `min(saldo positivo anterior, teto anterior, teto novo)`. Preservar origem e snapshot de apontamentos consultados. Correção de período anterior após esse aceite **não recalcula silenciosamente** o saldo transferido; gestor deve reconciliar com nova revisão auditável. Rollover nunca é dinheiro/margem e não é confundido com horas de preço fechado.

Ambos os regimes exigem declarações `direct_costs_complete` e `time_entries_complete`. False significa universo ainda não conciliado, não ausência de custo. True é certificação humana para a observação aprovada, com fonte/data; pendências novas ainda bloqueiam indicadores dependentes. Ao mudar o universo conhecido, revisar premissas e registrar nova observação. Não usar True sem conferência de todos os custos/apontamentos relevantes.

Reconhecimento de receita é explícito: `none` (desconhecido), `manual` (valor atribuído à competência e aprovado com fonte) ou `at_period_end` (valor contratado apenas quando o corte alcança o fim do período). A regra de fim do período não reconhece excedentes projetados. Receita contratada é distinta de receita reconhecida; **recebimentos e saldo de caixa não existem neste M4**.

## Estimativas, horas e despesas

Estimativa exige demanda vinculada a item do escopo dos termos aprovados, profissional ativo, baseline prevista, minutos restantes e data prevista. Uma série por termos/demanda/profissional; atualizações de restante preservam baseline, versão anterior e autoria. Nova base comercial pode receber novas séries. Cada item do escopo deve ter ao menos uma estimativa aprovada; sem estimativa de algum item, projeção fica incompleta. Zero de restante é declaração explícita, não inferido de ausência ou status operacional.

Apontamento vem do usuário da sessão, com demanda do mesmo projeto/organização, data até hoje e comentário. Mesmo payload/chave retorna mesmo resultado; repetição idêntica com chave diferente é recusada para revisão. Usuário pode registrar trabalho em demanda de sua organização sem mudar a atribuição M0. Manager/admin independente aprova ou rejeita; aprovação sem taxa congela ausência e o relatório fica incompleto. Pendentes são mostrados em separado e não entram como custo realizado.

Não editar/desaparecer linhas: reverter pendente próprio; reverter aprovado exige gestor/admin diferente do usuário das horas. Correção cria novo apontamento próprio com `replaces_id` de linha revertida/rejeitada; origem preservada, uma substituição por linha. Custo antigo sai dos cálculos novos, permanece no histórico, e a substituição captura nova taxa explicitamente aprovada. Reversão não muda relatórios já gerados.

Despesa direta/externa é uma série por referência única e termos, com classificação `external`/`expense` e **três parcelas explícitas**: orçamento, incorrido e restante. EAC usa incorrido + restante, nunca soma orçamento como terceira despesa. Revisão substitui a série inteira atomicamente para não manter duas parcelas completas de “restante”/“incorrido” do mesmo lançamento. A fonte deve prevenir duplicidade física entre referências diferentes. Trabalho/overhead têm classes próprias e não entram aqui. “Incorrido” é consumo/obrigação declarada, não saída bancária.

## Fórmulas determinísticas · motor m4.1

Todos os termos monetários abaixo estão na mesma moeda/competência; `R()` é arredondamento especificado por linha:

```text
Trabalho incorrido = Σ custo_minor congelado nas horas aprovadas e não revertidas
Trabalho baseline  = Σ R(minutos_previstos × taxa_snapshot / 60)
Trabalho restante = Σ R(minutos_restantes × taxa_snapshot / 60)
Overhead incorrido/previsto/restante = R(minutos agregados correspondentes × taxa_overhead / 60)
Deduções(receita) = R(receita × tributos_bps / 10000)
                   + R(receita × comissão_bps / 10000)
Custo incorrido = trabalho incorrido + externos incorridos + overhead incorrido
ETC = trabalho restante + externos restantes + overhead restante
EAC = custo incorrido + ETC + Deduções(receita projetada)
Orçamento de custo = trabalho baseline + externos orçados + overhead previsto
                     + Deduções(receita contratada)
Desvio de custo = EAC − orçamento de custo
Desvio de minutos = aprovados + restantes − baseline
Margem projetada = receita projetada − EAC
Margem projetada % = margem projetada / receita projetada
Custo realizado relevante = custo incorrido + Deduções(receita reconhecida)
Margem realizada = receita reconhecida − custo realizado relevante
Margem realizada % = margem realizada / receita reconhecida
```

Margem usa **receita** no denominador, não custo (markup). Receita zero deixa percentual null, sem Infinity ou lucro artificial; valor absoluto pode ser negativo. Incorrido mostrado sem tributos/comissões sobre receita é identificado assim na UI; custo realizado relevante inclui deduções da receita reconhecida. Nunca chamar ETC/EAC de realizado.

```text
Preço fechado: receita projetada = receita contratada
Retainer:
  saldo de minutos = incluídos + entrada_rollover − minutos aprovados
  excedente registrado = max(0, minutos aprovados − incluídos − entrada)
  excedente projetado = max(0, aprovados + restantes − incluídos − entrada)
  receita projetada = receita contratada
                     + R(excedente projetado × preço_hora_excedente / 60)
                       somente quando overage_rule = billable
```

Sem configuração/tributação/overhead, taxa/snapshot, estimativa de item, capacidade ou declarações relevantes, indicadores dependentes ficam null com listas exatas `projection_missing`/`actual_missing`. Não confundir soma de minutos **registrados/aprovados** com certeza de que todo esforço foi registrado. Horas pendentes bloqueiam margens dependentes. Margem realizada exige reconhecimento explícito e completude de custos/apontamentos; projeção exige também restante/baseline/capacidade e cobertura M3 atual.

## Exemplos sintéticos conferidos independentemente

### Preço fechado · BRL

Valor contratado 1.000.000 centavos; reconhecido manualmente 400.000. Tributos 1000 bps e comissão 500 bps. Trabalho 6000 centavos/hora; overhead 1200 centavos/hora. Baseline 600 minutos; aprovados 120; restantes 480. Externos: orçamento 20.000; incorrido 5.000; restante 15.000. Capacidade explicitamente alocada 1000 minutos. Declarações de custos/apontamentos completas, nenhuma pendência.

- Trabalho incorrido 12.000; overhead incorrido 2400; externos incorridos 5000 → incorrido **19.400**.
- Trabalho restante 48.000; overhead restante 9600; externos restantes 15.000 → ETC **72.600**.
- Deduções na conclusão 150.000 → EAC **242.000**; orçamento **242.000**.
- Margem projetada **758.000**, **75,80%**.
- Deduções sobre reconhecido 60.000 → custo realizado relevante **79.400**; margem realizada **320.600**, **80,15%** sobre reconhecido.
- Atualizar restante para 1200 minutos muda ETC para 159.000, EAC para **328.400**, margem projetada para **671.600** (**67,16%**); incorrido e margem realizada ficam iguais. Alertas: estouro de horas, EAC acima da baseline/erosão e restante maior que capacidade declarada. Snapshot anterior não muda.

### Retainer · BRL · outubro sintético

Valor do mês 100.000 centavos; incluídos 600 minutos. Período anterior com 600 incluídos e 480 aprovados transfere **120 minutos**, com regra/teto aprovados de 120. Outubro registra 780 minutos aprovados e zero restante explicitamente estimado; baseline 720; capacidade 720. Trabalho 6000/h e overhead 1200/h; tributos/comissão iguais ao exemplo. Ausência de externos declarada explicitamente.

- Saldo = 600 + 120 − 780 = **−60 minutos**; excedente 60.
- Preço explícito do excedente 6000/h → receita projetada **106.000**, sem alterar receita contratada **100.000** ou reconhecer automaticamente excedente.
- Trabalho 78.000 + overhead 15.600 = incorrido 93.600. Deduções sobre projeção 15.900 → EAC **109.500**; margem projetada **−3500**.
- Outra competência com valor 200.000 não recebe horas, receita ou saldo de outubro implicitamente. Uma entrada de rollover maior que saldo/tetos é recusada.

## Observações, consolidação e rastreabilidade

Relatório captura IDs e dados completos de termos/decisão, premissas, taxas de linhas, estimativas, parcelas externas, capacidade/calendário, apontamentos e base comercial (`CommercialBasis`), além de cliente, corte e engine version. Hash SHA-256 de JSON canônico é reproduzível após armazenamento JSONB/restauração. Recalcular o input congelado com motor m4.1 deve produzir exatamente o resultado armazenado; teste de restore comprova isso. O hash atesta correspondência dos inputs, não uma assinatura externa ou comprovação contábil.

Histórico de até 100 observações mostra evolução com fonte/data; gerar novas observações explicitamente, não substituir as antigas. Painel não representa fluxo de caixa nem promete conhecimento em tempo real. Consolidação por cliente usa a última observação por projeto/moeda/competência, excluindo observações repetidas. Nunca soma moedas ou competências diferentes nem faz média simples dos percentuais: margem consolidada usa soma de receitas/custos comparáveis. Projetos do cliente sem observação comparável impedem margem consolidada completa e ficam identificados; totais de receita/custo apresentados são o recorte observado, não números presumidos dos projetos ausentes.

## API M4

Todas exigem sessão/tenant servidor; POST exige CSRF, origem exata, UUID Idempotency-Key. Limite JSON 32 KiB. Séries, decisões, apontamentos e relatórios são transacionais com evento/auditoria/idempotência. Advisory lock por organização serializa duplicidade, decisões e revisões; conflitos/revisões/estados desatualizados retornam 409. Falha tardia de auditoria desfaz todas as escritas e a chave. Cache idempotente mantém TTL 24h M1.1; após isso, conferir a trilha antes de tentar de novo. Respostas financeiras em cache continuam exigindo papel financeiro atual.

| Método | Rota                                | Dados/resultado                                                                                                        |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/economics`                    | Visão filtrada por papel; gestor recebe registros/decisões, horas, últimas 100 observações, consolidação e 200 eventos |
| POST   | `/api/economics/records`            | `{kind,project_id,currency,valid_from,valid_until,source,payload,previous_id}`; config/rate exigem project_id null     |
| POST   | `/api/economics/records/:id/decide` | `{revision,decision:'approved'/'rejected',reason,cost_role?:null/função}`; independente e alçada M3                    |
| POST   | `/api/economics/times`              | `{project_id,request_id,work_date,minutes,comment,replaces_id:null/UUID}`; usuário da sessão                           |
| POST   | `/api/economics/times/:id/action`   | `{expected_state,action:'approved'/'rejected'/'reversed',reason,cost_role?:null/função}`                               |
| POST   | `/api/economics/reports`            | `{terms_id,as_of}`; observa termos atualmente aprovados e guarda inputs/resultado/hash                                 |

Payloads por tipo e contratos TS estão em `src/server/economics/validation.ts` e `src/shared/economics.ts`. UI fornece os campos sem exigir SQL/JSON técnico. Detalhes JSON são fontes/revisões opcionais para inspeção de gestores, não um fluxo obrigatório. Não há endpoint para alterar histórico ou valores pelo LLM.

## Homologação reproduzível e próximos limites

1. Executar setup e suítes sequencialmente. Preservar módulos/dados existentes. Confirmar migração sem valores automáticos e usuário externo sem leitura/escrita.
2. Com dados identificados como sintéticos: admin configura alçada M3; PO registra contrato/escopo/demanda; gestor independente aprova base M3 e PO vincula cobertura.
3. Gestor prepara premissas com números do exemplo, fonte e vigência; admin/segundo gestor independente aprova. Preparar/aprovar taxas, termos completos, capacidade e despesa, conferindo zero/null declarados.
4. PO estima 600 previstos/480 restantes, gestor independente aprova. Desenvolvedor aponta 120 minutos; verificar pendentes sem custo realizado e nenhuma taxa no payload desse usuário. Gestor aprova conferindo taxa individual ou função de custo explicitamente declarada.
5. Gestor gera observação; conferir os centavos acima, fórmula, fonte/hash e competência. Atualizar restante para 1200 em nova revisão; aprovar e gerar observação. Conferir EAC/margem/alertas alterados e realizado/histórico intactos.
6. Repetir retainer de duas competências, rollover e excedente do exemplo. Não aceitar saldo de período não encerrado, pendências no período anterior ou valor acima dos tetos. Conferir que novembro não incorpora horas/receita de outubro.
7. Remover taxa/estimativa/overhead num cenário separado e conferir incompletude, não lucro fictício. Demanda sem cobertura/contrato encerrado não recebe base aprovada automaticamente. Role/payload não concedem alçada; nenhuma autoaprovação econômica.
8. Executar concorrência/replay/reversão/rollback e backup/restore; comparar dados M4 e recalcular inputs restaurados. CI do SHA entregue deve passar; evidências em PROGRESS.md.

Limitações explícitas: cálculo gerencial proporcional, não contabilidade/fiscal/faturamento; sem câmbio, recebimentos, ERP ou feriados importados; capacidade exige alocação declarada com períodos alinhados; um conjunto de termos por projeto/período; despesas não detectam duplicidade física entre referências humanas diferentes; certificação de completude e reconciliação de rollover requerem gestor. Observações antigas são imutáveis e não se atualizam sozinhas. Paginação/volumes de dados e retenção corporativa podem evoluir em trabalho posterior.

OIDC Google/LLM reais continuam pendentes do proprietário e não foram simulados como testes externos. IA não participa da aritmética M4 nem recebe números. As referências, completude, margem/custos e cobertura M3 preparam **dados de entrada** para política econômica M5; não conferem elegibilidade automática, não executam agentes e não substituem limites/aprovação de engenharia. Sem merge, deploy, main/default ou exposição pública.
