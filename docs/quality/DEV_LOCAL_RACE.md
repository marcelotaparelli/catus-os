# Condição de corrida no teste do `dev:local`

**Estado:** preexistente, não corrigida, isolada. Não é causada pelo M6.1 nem pelo escopo de status por lista. Correção proposta abaixo, para um PR próprio.

## Sintoma

No CI, a verificação `usa as portas de sempre` de `scripts/test-dev-local.mjs` falhou uma vez com:

```
{"api":null,"db":null,"web":5173}
```

O mesmo commit (`0fa16ef`) passou na execução de push e passou de novo quando a execução do PR foi reexecutada, sem mudança de código. O resultado depende do momento em que a saída chega, não do código testado.

## Causa

`scripts/dev-local.mjs` anuncia a prontidão em duas escritas separadas:

```js
say(`pronto: ${origin}`);
say(`API na porta ${apiPort}; PostgreSQL na porta ${dbPort}`);
```

O teste acumula a saída do processo em `s.out` a cada evento `data` do pipe e consulta esse texto a cada 100 ms:

- `ready(s)` conclui assim que `[dev] pronto` aparece;
- `portsOf(s)` roda logo depois e procura `API na porta (\d+); PostgreSQL na porta (\d+)`.

Quando as duas linhas chegam em eventos `data` diferentes e a consulta cai entre eles, `ready` já é verdadeiro, mas a segunda linha ainda não chegou. A porta do web vem da primeira linha, por isso aparece; as outras duas ficam `null`. O valor observado no CI é exatamente esse.

## Por que não é regressão

- O texto e a ordem das duas linhas não mudaram nas branches do M6.1.
- Nenhum arquivo de `scripts/dev-local.mjs`, `scripts/lib/dev-local.mjs` ou `scripts/test-dev-local.mjs` foi alterado.
- A mesma versão do código passou e falhou em execuções diferentes.

## Correção proposta (PR separado)

Uma das duas opções, de preferência a primeira, porque fica no teste e não muda o que o desenvolvedor vê:

1. `ready` espera pela linha das portas: `s.out.includes('PostgreSQL na porta')`. Isso também cobre as chamadas posteriores de `portsOf`.
2. `dev-local.mjs` escreve as duas informações numa única chamada.

Critério de aceite: o job `dev-local` passa em pelo menos 20 execuções seguidas no CI.

## Enquanto não for corrigida

Uma falha isolada em `usa as portas de sempre` com `api` e `db` nulos e `web` preenchido é essa condição de corrida. Pode ser reexecutada, e a reexecução deve ser registrada no PR. Qualquer outro valor, ou falha repetida, é investigado como defeito.
