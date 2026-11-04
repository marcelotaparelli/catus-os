# Qualidade automatizada do frontend

Todo PR roda dois jobs no CI (`.github/workflows/ci.yml`). Ambos são obrigatórios.

| Job        | O que bloqueia                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate` | typecheck (`svelte-check` + `tsc`), build, formatação, testes unitários/API (Bun + PostgreSQL descartável), orçamento de bundle (`npm run perf:budget`), jornadas E2E M0–M5 navegando pelo menu de módulos (`npm run test:e2e`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `quality`  | `npm run test:quality` com navegador da imagem Playwright **fixada por digest**: regressão visual (comparação exata), axe-core WCAG 2.2 A/AA em todos os módulos de cada papel, layout de todos os módulos em 360/390/768/1280/1440 px (sem overflow, corte ou sobreposição de controles), foco visível em cada parada de Tab, M3 e menu operáveis por teclado, navegação (menu e rotas por papel, rotas restritas sem download do módulo, link direto através do login, recarregar, voltar/avançar, âncoras antigas, rota inexistente, carregamento sob demanda, rascunhos e filtros preservados, desmontagem ao sair), matriz de papéis, recusas diretas da API, feedback de carregamento/falha de rede/resposta inválida, edição concorrente, orçamento de runtime (build de produção) |

Qualquer falha publica o artefato `quality-evidence` (ou `journeys-evidence`), com relatório HTML, traces, capturas, diffs visuais (`*-diff.png`), `axe.json` e medições de desempenho.

Dados: `e2e/quality/seed.setup.ts` cria dados sintéticos determinísticos pela API pública, com sessões reais, no banco descartável de teste. Nenhum dado real e nenhum bypass de autenticação no runtime.

## Executar localmente

```sh
npm run build && npm run test:quality          # Chromium local: o visual pode divergir do CI
CATUS_PW_WS=ws://127.0.0.1:3001/ npm run test:quality   # idêntico ao CI, com o servidor da imagem fixada:
# docker run --rm --network host --init --user pwuser mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a… \
#   node /opt/catus/node_modules/playwright/cli.js run-server --port 3001 --host 127.0.0.1   # com -v "$PWD/node_modules:/opt/catus/node_modules:ro"
```

## Baselines visuais

- Ficam em `e2e/quality/__screenshots__/`, renderizadas pela imagem fixada. Horários são mascarados.
- **Nunca** atualize baselines só para o CI passar. Para uma mudança visual intencional:
  1. Rode o workflow manualmente (_Run workflow_, `propose_baselines=true`).
  2. Baixe o artefato `proposed-baselines`.
  3. Revise as imagens e versione-as no mesmo PR da mudança.
- O revisor do PR vê a diferença das imagens no diff do GitHub.

## Acessibilidade

- Violações `serious`/`critical` novas falham o CI.
- Dívida legada só entra em `e2e/quality/a11y-baseline.json` (regra → máximo de nós, por tela), com prioridade registrada aqui.
- O teste também falha quando uma entrada registrada deixa de ocorrer, para que o arquivo só diminua. Hoje ele está **vazio**: corrigimos contraste, regiões roláveis e foco.
- Violações moderadas/menores ficam no `axe.json` de cada tela, sem bloquear.

## Desempenho

`perf-budget.json` registra os orçamentos e as medições de referência (CI 41629444027 e 41629496779). Telas de módulo são carregadas na primeira visita (chunks separados); o JS inicial é o script de entrada mais os `modulepreload` do `index.html`.

| Métrica                                        | Antes (página única)     | Navegação por módulo | Orçamento      |
| ---------------------------------------------- | ------------------------ | -------------------- | -------------- |
| JS inicial bruto / gzip                        | 153,3 kB / 51,1 kB       | 76,5 kB / 28,6 kB    | 90 kB / 33 kB  |
| JS total bruto / gzip (soma dos chunks)        | 153,3 kB / 51,1 kB       | 190,2 kB / 70,9 kB   | 215 kB / 80 kB |
| CSS bruto / gzip                               | 10,4 kB / 3,0 kB         | 11,7 kB / 3,3 kB     | 16 kB / 5 kB   |
| Chamadas de API na abertura                    | 10–11 (todos os módulos) | 5 (`/api/overview`)  | 5              |
| Tela inicial utilizável (preview)              | 240–517 ms (tudo)        | 240–243 ms           | 1000 ms        |
| Troca para o Comercial (chunk + dados, 1ª vez) | —                        | 143–149 ms           | 500 ms         |
| LCP / CLS                                      | 92–156 ms / 0,004        | 72–96 ms / 0,004     | 1000 ms / 0,05 |
| Interação M3 (abrir formulário / escopo)       | 32–66 ms                 | 38 ms                | 150 ms         |

Value-first MVP: a leitura por papel do Mission Control é um chunk próprio, e o JS inicial segue dentro do orçamento original. O total cresce porque cada chunk é comprimido separadamente e pela navegação (cerca de 5 kB gzip); o que o usuário baixa para começar caiu 44%.

Lighthouse não foi adicionado: traria uma dependência pesada e um segundo navegador, e não mede nada além do que estas métricas cobrem para um SPA autenticado em rede local.

## Revisor de UX por IA (procedimento para o agente)

1. `npm run build`, depois rode `npm run test:quality -- e2e/quality/visual.spec.ts --update-snapshots` numa cópia de trabalho descartável para gerar capturas desktop e mobile com dados sintéticos. Para jornadas adicionais, acrescente casos em `visual.spec.ts`.
2. Inspecione cada captura e registre os problemas numa tabela (tela, evidência, gravidade, impacto operacional): hierarquia, legibilidade, densidade, alinhamento, rótulos, próximo passo.
3. Corrija primeiro o problema de maior impacto e menor risco. Preserve nomes acessíveis usados pelas jornadas.
4. Reexecute `npm run check`, `npm run test:e2e` e `npm run test:quality`. Compare antes e depois com as mesmas condições de dados e renderizador.
5. Só considere concluído com evidência independente da própria opinião: testes verdes, diff visual revisado no PR, `axe.json` sem violações graves novas e métricas dentro do orçamento. Decisões de produto ficam com o proprietário.
6. Bloqueios reais (por exemplo, falta de renderizador fixado) vão para o backlog abaixo, com motivo.

## Revisão M3 (02–03/11/2026)

| Problema (evidência: `docs/quality/*-before.png`)                                                                            | Gravidade   | Correção                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Checkboxes a ~550 px do rótulo: a regra global de largura 100% dos campos também valia para checkboxes (afetava M3, M4 e M5) | Alta        | Checkbox/radio com tamanho natural, ao lado do rótulo, em grupo com legenda (`fieldset`)                                   |
| Sem hierarquia entre política, contratos, escopos e cobertura                                                                | Alta        | Blocos com títulos, contadores e separadores; selos de estado em contratos e escopos                                       |
| Sem orientação de próxima ação                                                                                               | Média       | "Próximo passo" derivado dos dados carregados e dependente do papel (o servidor continua decidindo)                        |
| Formulários com largura total (até 1090 px)                                                                                  | Média       | Contrato em 2 colunas e no máximo 760 px; seletores com até 560 px; formulários de change request e decisão com até 760 px |
| Tipografia inconsistente no detalhe do escopo (16 px contra 12–13 px)                                                        | Baixa       | 13 px, título 15 px                                                                                                        |
| Contraste abaixo de 4,5:1 (cinzas de texto, rótulos superiores, selo, estados vazios)                                        | Alta (WCAG) | Paleta de cinzas ajustada (≥ 4,5:1)                                                                                        |
| `<pre>` roláveis inacessíveis por teclado; campo de data sem anel de foco                                                    | Alta (WCAG) | `tabindex="0"` nas regiões roláveis; `:focus-within` e `:focus-visible`                                                    |

## Revisão UX Comercial e Economia (03/11/2026)

Evidência em `docs/quality/ux-comercial-economia/`: `before-*.png`, `after-*.png`, `metrics-before.json` e `metrics-after.json`, com o mesmo cenário sintético e o mesmo Chromium local. A única diferença de dados é o e-mail no cabeçalho (`demo.*` antes, `ux.*` depois), porque a medição passou a ter organização própria no harness. O "antes" foi medido no commit `50eec4d` com `measure-before.spec.ts.txt`; o "depois" é `e2e/ux-tasks.spec.ts`, que também falha se uma tarefa passar a custar mais.

Regra de contagem: um clique por clique, dois por seletor nativo (abrir e escolher), um campo por campo digitado.

| Papel         | Tarefa (entrando pelo menu)               | Antes (cliques + campos) | Depois (cliques + campos) |
| ------------- | ----------------------------------------- | ------------------------ | ------------------------- |
| Gestor        | Decidir horas pendentes                   | 2 + 1                    | 1 + 1                     |
| Administrador | Decidir registro, vendo o valor           | 3 + 1                    | 1 + 1                     |
| Gestor        | Preparar custo por hora                   | 6 + 4                    | 5 + 2                     |
| Gestor        | Calcular a rentabilidade de um projeto    | 3 + 0                    | 2 + 0                     |
| Gestor        | Decidir escopo submetido                  | 3 + 1                    | 2 + 1                     |
| PO            | Vincular demanda ao único item disponível | 5 + 0                    | 1 + 0                     |
| PO            | Estimar demanda                           | 8 + 4                    | 3 + 4                     |
| Desenvolvedor | Apontar horas                             | 6 + 2                    | 3 + 2                     |

| Medida na tela                             | Antes    | Depois   |
| ------------------------------------------ | -------- | -------- |
| Altura de Economia com as horas abertas    | 3.439 px | 1.025 px |
| Botões com UUID nessa tela                 | 15       | 0        |
| Botões desabilitados sem explicação        | 15       | 0        |
| Justificativa até o botão de decisão       | 256 px   | 145 px   |
| Altura de Comercial ao abrir (gestor)      | 1.602 px | 2.014 px |
| Controles visíveis ao abrir Economia (PO)  | 8        | 23       |
| Controles visíveis ao abrir Economia (dev) | 6        | 11       |

As três últimas linhas pioraram por escolha: Comercial traz as listas de decisão e de cobertura para o topo, e PO e desenvolvedor abrem direto no formulário em vez de um accordion fechado.

Nada mudou no servidor além dos links das recomendações: payloads, regras e permissões são os mesmos. O servidor continua guardando unidades mínimas, pontos-base e minutos; a conversão fica em `src/shared/units.ts`, que recusa o que não consegue ler com exatidão (`12.50`, ou `0,33` h, que não dá minutos inteiros) e nunca transforma vazio em zero. Economia e Comercial só desenham o conteúdo depois de carregar os dados, para não empurrar a tela (CLS).

## Marca Catus e esforço operacional (04/11/2026)

Identidade e tokens em [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md). Evidência em `docs/quality/catus-brand/`: `before/` e `after/` (mesmo cenário e mesmo Chromium local), `before-tasks/`, `after-tasks/` e o spec de captura.

Mesma regra de contagem da revisão anterior. O "antes" foi medido em `75a9c14`, com `measure-before.spec.ts.txt` e `e2e/ux-tasks.spec.ts`. O "depois" é `e2e/ux-tasks.spec.ts`, que falha se uma tarefa passar a custar mais.

| Papel         | Tarefa                                       | Antes (cliques + campos) | Depois (cliques + campos) |
| ------------- | -------------------------------------------- | ------------------------ | ------------------------- |
| Desenvolvedor | Avançar demanda, a partir do Mission Control | 5 + 0                    | 1 + 0                     |
| Desenvolvedor | Avançar demanda na fila de Solicitações      | 4 + 0                    | 1 + 0                     |
| Gestor        | Recalcular a rentabilidade dos 4 projetos    | 5 + 0                    | 2 + 0                     |
| Gestor        | Ver o escopo de um contrato                  | 2 + 0                    | 1 + 0                     |
| Desenvolvedor | Apontar horas na mesma demanda da última vez | 3 + 2                    | 1 + 2                     |
| PO            | Estimar demanda ainda não iniciada           | 3 + 4                    | 3 + 3                     |

Cada redução vale para o caso indicado. Apontar em outra demanda continua custando 3 + 2, e estimar com restante diferente do previsto continua custando 3 + 4. Bloquear uma demanda continua no formulário, de propósito, porque exige uma nova próxima ação.

O orçamento de CSS bruto subiu de 18,5 kB para 20 kB. A camada de tokens custa 1.082 bytes: a mesma folha sem ela mede 18.619 bytes, ainda acima do orçamento antigo. As fontes têm orçamento próprio, `fontBytes`, fora dos totais de CSS.

## Backlog priorizado

1. ~~Página longa~~: resolvido com a navegação por módulo (rotas `#/…`, `src/web/routes.ts`).
2. Estender a regressão visual e as capturas de UX a atendimento inteligente e M5. M4 tem capturas em `docs/quality/ux-comercial-economia/` e baselines dos formulários, sem dados de horas ou relatórios, porque o seed de qualidade não cria dados econômicos.
3. ~~Formato de data `mm/dd/yyyy` no renderizador do CI~~: resolvido com campos de data em DD/MM/AAAA, independentes do idioma do navegador.
4. Espaço superior excessivo no cartão de item do escopo (padding do cartão + margem do título).
5. Ordem de cabeçalhos (h3 → h4) dentro do detalhe do escopo (`heading-order`, prática recomendada, não WCAG).
6. Jornada visual ponta a ponta cliente → projeto → atendimento → solicitação → triagem → escopo → execução → horas → rentabilidade. Hoje a jornada funcional é coberta por `e2e/pilot-journey.spec.ts`; o visual cobre Mission Control e M3.

## Datas e orçamento de JS

Datas aparecem e são digitadas em DD/MM/AAAA (`UnitField kind="date"`). O `input[type=date]` foi retirado porque ele segue o idioma do navegador, e não o da aplicação: em um navegador em inglês mostrava mm/dd/aaaa, e o calendário nativo deixa de existir. A API e o banco continuam em ISO; `e2e/value-first.spec.ts` confere o valor enviado e o valor persistido.

O JS total fica em 79,8 de 80 kB gzip, sem aumento de orçamento. A economia veio de retirar o polyfill de modulepreload, unir chunks muito pequenos e eliminar duplicações (rótulos, formatador de horário e POST idempotente). A próxima adição exige nova otimização antes de qualquer aumento.
