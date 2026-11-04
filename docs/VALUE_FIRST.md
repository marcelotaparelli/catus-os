# Value-first MVP: inteligência operacional e econômica

Incremento sobre M0–M4. Nenhuma migration, nenhuma tabela, nenhuma regra econômica nova. M5 continua desligado e M6 não foi iniciado.

## O que muda para cada papel

`GET /api/overview` é uma leitura sem escrita, filtrada no servidor por papel. O Mission Control abre nela:

| Papel         | Primeira tela                                                                                                                      | Fronteira preservada                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Gestor        | **Visão executiva**: situação de cada projeto, o que fazer agora, responsável e motivo; horas, custo, receita e margem por projeto | Mesma leitura financeira de `/api/economics`                 |
| PO            | **Operação do PO**: ações, demandas, prazos, bloqueios, cobertura e escopos em andamento                                           | Nenhum valor monetário; estimativas que o PO já podia ver    |
| Desenvolvedor | **Meu trabalho**: prioridades, próxima ação, minhas horas e correção de rejeitadas; apontar com projeto e demanda preenchidos      | Apenas os próprios apontamentos; nenhuma estimativa ou custo |
| Administrador | **Governança**: alçada, aprovação independente, decisões pendentes, responsáveis, auditoria; visão executiva recolhida             | Mesma permissão financeira que já tinha                      |

## Como cada número é obtido

A visão executiva chama `observe()` e `calculate()`, as mesmas funções de `POST /api/economics/reports`. O teste `tests/value-first.test.ts` exige igualdade total entre os dois resultados. Corte: hoje, limitado ao fim da competência. Sem termos aprovados não há cálculo. Abrir a tela não grava observação: o histórico continua sendo gerado explicitamente em Economia, e cada cartão informa se a última observação preservada coincide com o cálculo atual.

Valores de moedas ou competências diferentes não são somados em nenhum lugar da tela, seguindo a regra de `docs/ECONOMICS.md`.

## Situação do projeto

Regras em `src/server/economics/insights.ts`, sem percentual-alvo inventado:

| Situação            | Condição, na ordem                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Sem base econômica  | Não há termos aprovados com início até hoje                                                                                    |
| Dados insuficientes | O motor devolveu margem projetada `null`                                                                                       |
| Margem negativa     | Margem projetada < 0                                                                                                           |
| Em risco            | Margem = 0, desvio de horas > 0, desvio de custo > 0, restante acima da capacidade, demanda bloqueada ou demanda sem cobertura |
| Margem positiva     | Nenhuma das anteriores                                                                                                         |

## Próxima ação e responsável

A lista é ordenada pelo que protege o lucro primeiro: margem negativa; horas pendentes; registros pendentes; bloqueios; lacuna comercial; cobertura; estouro de horas; capacidade; prazo vencido; dados ausentes. Cada ação traz nomes reais, a base da responsabilidade e o motivo com os valores. O aprovador sugerido exclui quem preparou o registro ou apontou as horas, preservando a decisão independente.

O sistema não tem dono de projeto. Por isso, decisões apontam para quem tem alçada ("Alice Admin ou Marina Gestora") e trabalho aponta para o responsável pela demanda. Limitação conhecida: em projetos com muitas alçadas o responsável é um grupo, não uma pessoa.

Cada recomendação tem um link que abre o painel certo em Economia ou o escopo e a demanda certos em Comercial, com tipo, projeto e demanda já preenchidos.

## Formulários

- Registrar contexto: cada registro salvo já fica selecionado no próximo passo, e a tela diz qual é ele.
- Termos: escolher o contrato preenche moeda e período e, havendo um só, o escopo aprovado. Preço fechado não pergunta mais saldo, excedente nem rollover, que o servidor já recusava. No retainer, rollover fica em "Avançado".
- Estimativa e despesa: moeda e competência vêm dos termos.
- Premissas: dias úteis e minutos por dia vêm preenchidos e editáveis; o preparador e o aprovador independente continuam vendo os valores. Tributos e comissões mostram o percentual ao digitar.
- Decisões pendentes aparecem primeiro, e Economia avisa quantas aguardam e o que falta para habilitá-las.

Nenhum requisito financeiro foi removido: o servidor valida exatamente o mesmo payload.

## Cenário sintético e conferência manual

`tests/support/ecommerce-scenario.ts` monta uma agência pela API pública, com sessões reais e aprovações independentes. Roda apenas em banco descartável: `tests/value-first.test.ts` cria e apaga o próprio banco, e a jornada de navegador usa uma organização exclusiva do harness. O banco de homologação não é acessado. As datas derivam do dia atual.

Premissas: tributos 8%, comissão 2%, overhead R$ 30/h, Davi R$ 120/h, Bia R$ 90/h.

| Projeto                     | Regime        | Previsto                                                | Realizado         | Falta | Orçamento                                        | Incorrido | EAC    | Desvio | Margem projetada |
| --------------------------- | ------------- | ------------------------------------------------------- | ----------------- | ----- | ------------------------------------------------ | --------- | ------ | ------ | ---------------- |
| Loja Aurora: novo checkout  | Preço fechado | 40h                                                     | 28h               | 24h   | 8.700                                            | 5.110     | 10.590 | +1.890 | 4.410 (29,40%)   |
| Performance e mídia         | Retainer 30h  | 30h                                                     | 38h               | 10h   | 4.200                                            | 4.560     | 6.360  | +2.160 | −360 (−6,00%)    |
| Integração ERP              | Preço fechado | 50h                                                     | 20h               | 30h   | 9.500                                            | 3.000     | 9.500  | 0      | 10.500 (52,50%)  |
| App de fidelidade (inicial) | Preço fechado | 20h                                                     | 0h + 6h pendentes | 14h   | Sem margem: faltam decisão de horas e capacidade |           |        |        | Indisponível     |
| App de fidelidade (depois)  | Preço fechado | 20h                                                     | 6h                | 14h   | 4.200                                            | 900       | 4.200  | 0      | 7.800 (65,00%)   |
| Landing de Black Friday     | Sem termos    | Sem base econômica: escopo submetido aguardando decisão |                   |       |                                                  |           |        |        |                  |

Exemplo, Loja Aurora (receita R$ 15.000):

```text
Trabalho incorrido   25h×120 + 3h×90            = 3.270
Trabalho restante    20h×120 + 4h×90            = 2.760
Trabalho previsto    30h×120 + 10h×90           = 4.500
Overhead             28h / 24h / 40h × 30       = 840 / 720 / 1.200
Externos             orçado / incorrido / resta = 1.500 / 1.000 / 500
Deduções             10% × 15.000               = 1.500
Incorrido            3.270 + 1.000 + 840        = 5.110
ETC                  2.760 + 500 + 720          = 3.980
EAC                  5.110 + 3.980 + 1.500      = 10.590
Orçamento            4.500 + 1.500 + 1.200 + 1.500 = 8.700
Margem               15.000 − 10.590            = 4.410 (29,40%)
Realizada            9.000 − (5.110 + 900)      = 2.990 (33,22%)
```

## Executar

```sh
node_modules/.bin/bun test --preload ./tests/setup.ts tests/value-first.test.ts
npx playwright test --project=journeys e2e/value-first.spec.ts   # capturas em test-results/value-first/
```

Capturas conferidas em `docs/quality/value-first/`.
