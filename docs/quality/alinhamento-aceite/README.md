# Alinhamento e Aceite: evidência

Dados sintéticos, em bancos descartáveis. Nenhum dado real foi lido, e nenhuma pessoa real usou esta tela. Ganho de negócio só o piloto mede.

## Linha de base

```sh
bun run baseline:alinhamento [AAAA-MM-DD]
```

Só lê, em transação `READ ONLY`, e funciona também em banco ainda na migration `010`. Devolve agregados por modelo de demanda, sem título, cliente ou pessoa:

| Pergunta                  | Campos                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Quanto retrabalho há?     | `reaberturas`, `taxa_retrabalho`                                                      |
| Quanto demora?            | `ciclo_horas_mediana`                                                                 |
| Quantas idas e vindas?    | `contatos_com_cliente_mediana`, `trocas_de_proxima_acao_mediana`, `bloqueios_mediana` |
| Quanto custa ao PO?       | `acoes_do_po_por_demanda_mediana`, `horas_do_po_por_demanda_mediana`                  |
| As horas são previsíveis? | `horas_sobre_estimativa_mediana`, `demandas_com_estimativa`                           |

**Limites:** reaberturas anteriores à `010` não existem no histórico; `historico_de_eventos_desde` diz desde quando há dados. Com menos de 20 demandas concluídas, `amostra_pequena` é `true`. A margem em si não entra: o relatório mede horas sobre estimativa, que é o que a alimenta.

**Valores reais: ainda não medidos.** Rode o comando antes de usar o incremento e guarde a saída.

## Esforço

Medido com o `Meter`, em `esforco.json`, e exigido por `e2e/alinhamento.spec.ts`:

| Tarefa                                 | Cliques | Campos |
| -------------------------------------- | ------- | ------ |
| Combinado com critérios já existentes  | 2       | 0      |
| Confirmação com atendimento registrado | 2       | 0      |
| Marcar como entregue                   | 1       | 0      |
| Aceite com atendimento registrado      | 2       | 0      |
| Aceite sem atendimento                 | 2       | 1      |
| Recusa sem atendimento                 | 2       | 2      |

Manutenção simples sem combinado não ganhou nenhum passo: os limites de `e2e/ops-followup.spec.ts` continuam iguais e passando.

## Tamanho

Build de produção, `scripts/perf-budget.mjs`, em bytes:

| Medida          | `f1067b8` | Este PR | Limite  |
| --------------- | --------- | ------- | ------- |
| JS inicial      | 75.625    | 75.669  | 90.000  |
| JS inicial gzip | 27.630    | 27.650  | 33.000  |
| JS total        | 214.424   | 218.028 | 218.500 |
| JS total gzip   | 76.009    | 77.449  | 80.000  |
| CSS             | 19.527    | 19.527  | 20.000  |
| CSS gzip        | 4.965     | 4.965   | 5.000   |

O limite de JS total subiu de 215.000 para 218.500. O código novo fica no arquivo carregado só ao abrir Solicitações. A primeira versão da interface custava 6.125 bytes e foi reduzida para 3.604. Duas tentativas foram descartadas: opções mais agressivas do minificador rendiam só 559 bytes, com risco, e unificar os `select` de Economia aumentou o bundle.

## Latência

`GET /api/followup` como PO, com 650 demandas abertas, 40 leituras, 3 execuções, no mesmo ambiente:

| Cenário                       | Mediana      | p95          |
| ----------------------------- | ------------ | ------------ |
| `f1067b8`                     | 17,7–17,9 ms | 19,5–20,0 ms |
| Este PR, sem nenhum combinado | 19,9–20,3 ms | 22,2–23,2 ms |
| Este PR, todas com combinado  | 22,1–23,0 ms | 24,3–26,3 ms |

## Migration

Sobre um banco na `010` com dados sintéticos, a `011` deixou idêntico o hash de linhas de todas as tabelas existentes. A versão anterior da aplicação passou nos testes de `followup`, `api` e `operations` sobre o schema novo, com uma exceção registrada no PR: o `db:roles` antigo recusa a tabela nova.
