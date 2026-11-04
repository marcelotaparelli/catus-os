# Design system Catus

A identidade do Catus OS vem do site da agência, `https://dev.catus.com.br/`, lido em 04/11/2026 com Playwright (CSS computado, folha inline e arquivos servidos). Nenhum valor de marca foi escolhido por gosto. Capturas do site: `docs/quality/catus-brand/site/`.

Onde mora cada coisa:

| O quê               | Arquivo                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| Tokens e fontes     | `src/web/ui/tokens.css`                                                  |
| Componentes (CSS)   | `src/web/style.css`, só com tokens                                       |
| Logo e favicon      | `index.html` (`<symbol id="catus-logo">` e `data:` no `<link rel=icon>`) |
| Licenças das fontes | `src/web/fonts/OFL-*.txt`                                                |

## Cores e origem

| Token           | Valor                | Origem no site                                         | Uso                                 |
| --------------- | -------------------- | ------------------------------------------------------ | ----------------------------------- |
| `--navy`        | `#203c5e`            | `.home-v2 { --navy }`; botão primário, títulos         | Títulos, botão primário, navegação  |
| `--navy-hover`  | `#15293f`            | `.home-v2 { --navy-hover }`                            | Hover do botão primário             |
| `--blue`        | `#1e6bd0`            | `.home-v2 { --blue }`; eyebrow, link, foco             | Links, eyebrow, foco, item atual    |
| `--blue-tint`   | `#f0f4f9`            | `.v2-tags span`                                        | Fundo de chip, próximo passo, hover |
| `--blue-soft`   | `#9fbfe8`            | `.v2-method-image:after`, avatar de `.v2-project-card` | Parte "Falta" da barra de horas     |
| `--text`        | `#3d4b5c`            | `.home-v2 { --text }`                                  | Texto corrido                       |
| `--muted`       | `#5b6878`            | `.home-v2 { --muted }`                                 | Texto secundário                    |
| `--surface`     | `#f5f7f9`            | `.home-v2 { --surface }`                               | Fundo da aplicação, blocos de dados |
| `--disabled`    | `#eef1f4`            | `.v2-case-image`                                       | Botão desabilitado, selo neutro     |
| `--line`        | `#e3e7eb`            | `.home-v2 { --line }`                                  | Bordas de cartão e divisórias       |
| `--line-strong` | `#c9d0d8`            | `.v2-button-secondary`                                 | Borda do botão secundário           |
| `--good`, `-bg` | `#1e5b33`, `#ecf6ef` | `.v2-form-message.is-success`                          | Estado positivo                     |
| `--bad`, `-bg`  | `#8a1f17`, `#fdf0ef` | `.v2-form-message.is-error`                            | Estado crítico                      |

Dois tokens **não vêm do site**, e por isso são declarados como funcionais:

| Token           | Valor                | Motivo                                                                                                                       |
| --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--field-line`  | `#8590a0`            | O campo do site usa `#cfd5dc`, 1,5:1 sobre branco. A WCAG 1.4.11 pede 3:1 para identificar um campo: este tem 3,23:1.        |
| `--warn`, `-bg` | `#7a4a0c`, `#fdf1dc` | O site não tem cor de atenção, e uma operação financeira precisa de uma. O âmbar é o que o Catus OS já usava antes da marca. |

### Contraste (WCAG 2.2 AA)

A cor da marca passa em AA em todos os fundos em que é usada, então **não foi preciso criar variante de texto**.

| Texto sobre fundo             | Razão |
| ----------------------------- | ----- |
| Branco sobre `--navy`         | 11,23 |
| `--navy` sobre branco         | 11,23 |
| `--blue` sobre branco         | 5,16  |
| `--blue` sobre `--surface`    | 4,81  |
| `--blue` sobre `--blue-tint`  | 4,67  |
| `--text` sobre branco         | 8,90  |
| `--muted` sobre branco        | 5,68  |
| `--muted` sobre `--surface`   | 5,29  |
| `--muted` sobre `--blue-tint` | 5,14  |
| `--muted` sobre `--disabled`  | 5,01  |
| `--good` sobre `--good-bg`    | 7,31  |
| `--bad` sobre `--bad-bg`      | 8,25  |
| `--warn` sobre `--warn-bg`    | 6,68  |

## Tipografia

O site usa duas famílias: **Inter** (variável, 100–900) em títulos, botões, navegação e campos, e **Lexend** no texto corrido.

| Papel                 | Fonte e peso                  | Tamanho no app        | No site              |
| --------------------- | ----------------------------- | --------------------- | -------------------- |
| `h1`                  | Inter 600, −0,025em           | 28 px (24 no celular) | 37,44 px, −0,025em   |
| `h2`                  | Inter 600, −0,02em            | 20 px                 | 32 px, −0,02em       |
| `h3`                  | Inter 600, −0,01em            | 16 px                 | 17 px, −0,01em       |
| Eyebrow               | Inter 600, 0,14em, maiúsculas | 11 px                 | 12 px, igual         |
| Botão                 | Inter 600                     | 13 px                 | 15 px                |
| Rótulo, campo, tabela | Inter 400–500                 | 13–14 px              | 12–14 px             |
| Número principal      | Inter 600                     | 20–28 px              | até 44 px            |
| Texto corrido         | Lexend 400                    | 13–14 px              | Lexend 300, 16–17 px |

**Diferença intencional:** o site escreve o corpo em Lexend 300 a 16–17 px. O Catus OS é denso, com texto de 13–14 px, onde o peso leve perde legibilidade. Por isso usa Lexend 400, face que o próprio site declara, e carrega só ela. Os números usam Inter com `tabular-nums`: a Lexend não tem o recurso `tnum`.

### Licença e hospedagem

As tabelas `name` dos arquivos servidos indicam SIL Open Font License: `Copyright 2016 The Inter Project Authors` e `Copyright 2019 The Lexend Project Authors`. A OFL permite redistribuir e converter sem pagar nada. As fontes são auto-hospedadas, e os textos da licença estão em `src/web/fonts/`. O texto foi obtido dos pacotes `@fontsource` das mesmas famílias, porque o site não publica a licença.

- `inter-var.woff2`: os bytes exatos do site, 48.256 bytes.
- `lexend-400.woff2`: conversão sem alterações de `lexend-400.ttf` do site, de 70.700 para 25.908 bytes.

### Como as fontes são servidas

`src/server/http.ts` entrega `/assets/*.woff2` com `Content-Type: font/woff2`, recebido do PR #14. A CSP cobre fontes por `default-src 'self'` e recusa `data:`, por isso `assetsInlineLimit` é zero no `vite.config.ts`.

Na pilha real (`deploy/catus.sh install`, borda HTTPS e CSP do servidor), as duas fontes carregam em Chromium 145, Firefox 146 e WebKit 26, com os mesmos bytes de `src/web/fonts` e sem violação de CSP (relatórios em `docs/quality/catus-brand/fonts-docker/`). `e2e/quality/brand-assets.spec.ts` confere o MIME em cada execução da suíte.

## Logo

- Origem: `/home-v2/assets/logo-catus.svg`, 191×61, vetorial, 8 caminhos.
- Os caminhos e as cores são os do arquivo. A única remoção foi uma `<mask>` que cobria todo o desenho e não muda nada na imagem: ela trazia um `style` inline, que a CSP (`style-src 'self'`) bloquearia.
- Fica em `index.html`, porque o servidor não entrega `.svg`. Assim também não pesa no orçamento de JS.
- Favicon: `/favicon.ico` do site, como `data:`, que a CSP permite em `img-src`.
- **Só existe a versão escura.** O logo é cinza (`#474747`, `#484848`), e não há versão clara no site. Por isso o menu lateral é branco, como o cabeçalho do site. Não use o logo sobre fundo escuro nem o recolora.

## Componentes

| Componente       | Regra                                                                                  | Origem                               |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| Botão            | Raio 4 px, `--navy`, Inter 600; secundário branco com `--line-strong`. Mínimo de 36 px | `.v2-button`, `.v2-button-secondary` |
| Cartão           | Branco, 1 px `--line`, raio 6 px, sem sombra                                           | `.v2-solution-card`                  |
| Selo             | Raio 3 px, sempre com texto, e ícone onde o estado é crítico                           | `.v2-tags span`                      |
| Eyebrow          | Maiúsculas, `--blue`. Dentro de cartões vira texto neutro, sem maiúsculas              | `.v2-eyebrow`                        |
| Título duplo     | Primeira linha `--navy`, segunda `--blue` (tela de entrada)                            | `h1` da página inicial               |
| Faixa de números | Número em cima, rótulo embaixo, divisória vertical                                     | `.v2-numbers`                        |
| Foco             | 2 px `--blue`, com afastamento de 2 px. O site usa 3 px; aqui 2 px, pela densidade     | `:focus-visible`                     |
| Desabilitado     | `--disabled` com texto `--muted`, em vez de opacidade, para continuar legível          | Decisão do app                       |

## Dados e gráficos

Seguem a skill `dataviz`:

- **Número antes de gráfico.** Cada grupo de projeto mostra um número principal (`.figure`) e, abaixo, os detalhes.
- **Texto usa tokens de texto, nunca a cor do dado.** Margem negativa aparece pelo sinal e pelo selo com ícone, nunca só por cor.
- **Dado ausente** continua como "Indisponível", nunca zero. Valores de moedas ou competências diferentes não são somados.
- **Barra de horas:** uma só família de cor (`--blue` e `--blue-soft`), com 2 px de separação, traço `--navy` no previsto e legenda. `--blue-soft` tem 1,89:1 sobre branco, abaixo dos 3:1. Por isso a barra é apoio: os mesmos valores estão em texto ao lado dela, e ela fica `aria-hidden`.
- O validador da skill reprova o par como paleta **categórica** (faixa de luminosidade e croma), o que é esperado: a barra é uma escala de um único tom, e a separação entre as duas cores passa (ΔE 26,2 no pior caso de daltonismo, contra o alvo de 8).

## Responsivo

| Largura  | Comportamento                                                            |
| -------- | ------------------------------------------------------------------------ |
| Até 760  | Sem menu lateral. Logo na barra da conta e faixa de módulos fixa no topo |
| Até 1000 | "Prioridades" e "Bloqueios" em uma coluna                                |
| Até 1200 | Grupos de projeto e cartões em 2 colunas                                 |
| Até 560  | Grupos de projeto em 1 coluna                                            |

O site usa outros pontos de quebra (559, 899, 1099). Estes já existiam no app e são cobertos pelos testes em 360, 390, 768, 1280 e 1440 px.

## Como usar

- Use sempre um token. Cor literal em `style.css` só existe para o branco (`#fff`).
- Fonte nova ou peso novo exigem atualizar `fontBytes` em `perf-budget.json` com justificativa.
- `style-src 'self'` proíbe `style=""` no HTML. O `style:` do Svelte funciona, porque usa CSSOM.
