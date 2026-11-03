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
| JS total bruto / gzip (soma dos chunks)        | 153,3 kB / 51,1 kB       | 166,2 kB / 61,7 kB   | 180 kB / 70 kB |
| CSS bruto / gzip                               | 10,4 kB / 3,0 kB         | 11,7 kB / 3,3 kB     | 16 kB / 5 kB   |
| Chamadas de API na abertura                    | 10–11 (todos os módulos) | 4                    | 4              |
| Tela inicial utilizável (preview)              | 240–517 ms (tudo)        | 240–243 ms           | 1000 ms        |
| Troca para o Comercial (chunk + dados, 1ª vez) | —                        | 143–149 ms           | 500 ms         |
| LCP / CLS                                      | 92–156 ms / 0,004        | 72–96 ms / 0,004     | 1000 ms / 0,05 |
| Interação M3 (abrir formulário / escopo)       | 32–66 ms                 | 38 ms                | 150 ms         |

O total cresce porque cada chunk é comprimido separadamente e pela navegação (cerca de 5 kB gzip); o que o usuário baixa para começar caiu 44%.

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

## Backlog priorizado

1. ~~Página longa~~: resolvido com a navegação por módulo (rotas `#/…`, `src/web/routes.ts`).
2. Estender a regressão visual e as capturas de UX a M4 (horas/rentabilidade), atendimento inteligente e M5.
3. Formato de data `mm/dd/yyyy` no renderizador do CI (locale do navegador sem dados pt-BR); avaliar campos de data com formato explícito.
4. Espaço superior excessivo no cartão de item do escopo (padding do cartão + margem do título).
5. Ordem de cabeçalhos (h3 → h4) dentro do detalhe do escopo (`heading-order`, prática recomendada, não WCAG).
6. Jornada visual ponta a ponta cliente → projeto → atendimento → solicitação → triagem → escopo → execução → horas → rentabilidade. Hoje a jornada funcional é coberta por `e2e/pilot-journey.spec.ts`; o visual cobre Mission Control e M3.
