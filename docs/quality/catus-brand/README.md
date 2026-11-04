# Evidência da marca Catus

Mesmo cenário sintético (`e2e/support-ux/meter.ts`) e mesmo Chromium local nas duas pontas. A única exceção são as datas, que derivam do dia da execução.

| Pasta           | Conteúdo                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `site/`         | Capturas de `dev.catus.com.br`, a folha de estilo inline e os estilos computados, de onde saíram os tokens |
| `before/`       | Telas em `75a9c14`, por papel, em 1280 e 390 px, com `metrics.json` e `perf-before.json`                   |
| `after/`        | As mesmas telas e os mesmos passos depois da mudança                                                       |
| `before-tasks/` | Capturas e medições de esforço em `75a9c14`: `metrics-before.json` e `metrics-before-extra.json`           |
| `after-tasks/`  | As mesmas tarefas depois: `metrics-after.json`                                                             |

## Repetir

1. Copie `capture.spec.ts.txt` para `e2e/zz-brand-capture.spec.ts` e rode com `BRAND_EVIDENCE=<pasta> npx playwright test --project=journeys e2e/zz-brand-capture.spec.ts`. Apague a cópia depois: ela usa a mesma organização de `e2e/ux-tasks.spec.ts`.
2. O "depois" do esforço é `UX_EVIDENCE=<pasta> npx playwright test --project=journeys e2e/ux-tasks.spec.ts`.
3. O "antes" das quatro tarefas novas é `measure-before.spec.ts.txt`, rodado em um checkout de `75a9c14`.

As imagens de `before/` e `after/` são de página inteira. Em telas estreitas, a faixa fixa de módulos pode aparecer no meio da captura quando a página foi rolada até um elemento: é efeito da captura, não da tela.

## Capturas finais

`after/` e `after-tasks/` foram refeitas no último estado de tela, com o mesmo Chromium local de `before/`.

## Fontes na pilha Docker real

`fonts-docker/` guarda os relatórios e as capturas das duas verificações, feitas no runner do GitHub com `deploy/catus.sh install`, pela borda HTTPS, sob a CSP do servidor, em Chromium, Firefox e WebKit.

| Pasta                       | Build                                                 | Execução    |
| --------------------------- | ----------------------------------------------------- | ----------- |
| `como-esta/`                | Este PR, com `*.woff2.css`                            | 41816497792 |
| `com-correcao-no-servidor/` | Estado adotado: suporte nativo do #14, sem o contorno | 41816527254 |

O WebKit registra uma recusa de `style-src` só depois da captura de tela: é o `<style>` que o próprio Playwright injeta para fotografar. Antes dela, a página não gera nenhuma mensagem nos três navegadores.

## Experiência de carregamento

`carregamento/` guarda a medição de `75a9c14` (`antes.json`) e deste PR (`depois.json`): build de produção pelo handler real, mediana de 3 execuções em Chromium, com rede e CPU emuladas. Não é um aparelho real. Os arquivos `measure-load*.txt` repetem a medição, se copiados para `e2e/` sem o sufixo `.txt`.
