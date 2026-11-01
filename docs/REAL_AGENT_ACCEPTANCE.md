# M5.1 — aceite sintético controlado (issue #4)

Baseline: `aec7a5ac439132fbd8752f7c64798c6973474960`, branch
`feat/m5-acceptance`. Fase A **PREPARED**; inferência real
**NOT_VERIFIED**, PR do agente **NOT_CREATED**.

## Decisão de contrato

Preservar no-tools, uma chamada, sem storage, limites independentes e executor
Docker com allowlists. Read-only/approval never não demonstram ausência de
ferramentas no protocolo. O Codex SDK 0.166.0 executa o harness CLI;
`outputSchema` não transforma esse harness em cliente Responses puro.
Qualquer tools anunciado deve continuar recusado, sem remover ferramentas
silenciosamente para fingir compatibilidade.

Auditoria e reprodução sem credenciais reais devem separar o SDK do adaptador
Responses direto. Este último deve usar `text.format: json_schema`, retorno
completo validado, tools vazio, uma chamada e identificação própria de harness.
Sucesso desse adaptador não comprova Codex SDK/Codex Cloud.

Fontes oficiais consultadas em 01/11/2026:
[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) e
[Responses create](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create).

## Gates externos

O proprietário configura conta/projeto/chave de teste somente no gateway privado,
modelo que aceite o schema, tarifas explícitas, orçamento da conta e egress TLS
restrito. Assinatura ChatGPT não é evidência de billing da API. Preferir crédito
pré-pago sem recarga automática, quando disponível. Nunca enviar chave por chat.

Runner dedicado sem banco, dados financeiros/clientes ou credenciais GitHub;
rede Docker internal para agente/gateway, testes sem rede, imagens por digest,
mirror/ref/SHA revisados. Somente tema e demanda sintéticos autorizados.

PR exige repo/base de teste existentes e credencial separada mínima. Ausência
mantém PR NOT_CREATED; patch e SHA são a entrega revisável. Sem merge/deploy.

## Prova reproduzível do SDK e contrato escolhido

```sh
npm ci
npm --prefix runner ci --ignore-scripts
npm run test:sdk-contract
node_modules/.bin/bun test tests/responses-contract.test.ts tests/delivery-readiness.test.ts
npm run delivery:diagnose
```

O primeiro comando de contrato executa SDK/CLI fixados contra servidor loopback
que sempre recusa com 422; usa HOME/CODEX_HOME temporários e credencial inválida
sintética, sem chave real. A evidência registra apenas rota, nomes de ferramentas,
streaming e tipo do schema. Em 01/11/2026 foram observados seis requests rejeitados
com request_user_input, view_image, multi_agent_v1 e ferramentas de goal, mesmo com
shell/apply_patch desativados. Zero requests ao provedor. O SDK também repete as
recusas; não satisfaz o contrato de chamada única. Mudança de versão exige nova
auditoria; o teste falha se não observar tools em vez de declarar compatibilidade.

Responses usa HTTP JSON não streaming, schema estrito de arquivos existentes,
`tools: []`, `tool_choice: none`, `store: false`; sem SDK ou CLI na imagem ativa.
O gateway aceita somente input textual e campos conhecidos, fixa modelo/schema e
limite de saída, rejeita estado anterior/background/storage/stream/tools antes do
upstream. Rejeita resposta não concluída, recusa, tool call, JSON truncado,
paths/campos extras, segredos, duplicatas, bytes/usage inválidos ou excessivos.
Ausência de usage também falha fechada. Validação é repetida no cliente e executor.
Há um único fetch, com redirect error, timeout e cancelamento; nenhuma repetição.
Falha após iniciar upstream mantém autorização consumida e reserva conservadora.

## Diagnóstico sem inferência

`delivery:diagnose` é offline, termina código 2 e lista dez fronteiras sem imprimir
valores/URLs/credenciais. `CONFIGURED_NOT_VERIFIED` significa somente presença,
nunca inferência comprovada. Docker e mirror usam checagens locais finitas; não
fazem claim, login, chamada ao provedor ou publicação. Rodar por papel com env-file
0600 privado: o gateway pode informar chave presente; o runner deve informar
provider access DENIED porque não deve receber essa chave. Não reunir segredos no
mesmo processo apenas para colorir o diagnóstico. Fixture, custo e PR requerem
revisão externa; o diagnóstico não certifica essa revisão por uma flag.

## Pacote sintético e sequência operacional

Fixture versionado em `tests/fixtures/nuvemshop-theme`: `templates/home.tpl` contém
h1 Loja e teste em `theme-check.fixture`. Copiar esse dado para
`tests/theme.test.mjs` somente no repo sintético autorizado. Nunca importá-lo como
fallback no runner de produção. Demanda: “Corrigir o título acessível para
Bem-vindo à loja sintética, preservando a seção hero”. Único write path:
`templates/home.tpl`; read paths e comando fixo `node --test tests/theme.test.mjs`
no manifest revisado. Teste pré-correção deve falhar; depois da geração válida deve
passar. Resultado esperado: somente h1 muda, base SHA original, patch, testes reais
e limpeza confirmada; nenhuma integração automática.

1. Preparar host/conta privada dedicada, Docker/cgroup, imagens fixadas por digest,
   rede internal `catus-codex-*` com alias delivery-gateway sem portas publicadas.
   Gateway tem egress separado somente ao provedor HTTPS autorizado; testes sem
   rede. Nunca remover proxy/TLS, usar full-access ou montar socket no agente.
2. Configurar chave legítima somente no gateway com env-file privado 0600 e
   `CODEX_UPSTREAM_RESPONSES_URL`/`CODEX_MODEL` explícitos. Configurar preço atual
   e limites também na conta do provedor. Sem dados privados neste repo público.
3. Criar repo fixture autorizado, ref de teste e mirror sem hooks; registrar SHA
   revisado nos manifests API/runner, substituindo zeros dos exemplos. Manifests
   são carregados no startup; reiniciar/revalidar após mudanças.
4. Configurar runner separado conforme AGENTIC_DELIVERY, imagem Responses em
   `DELIVERY_CODEX_IMAGE`, rede em `DELIVERY_CODEX_NETWORK`; nomes históricos de
   variáveis não significam SDK. Token do broker org/projeto/8h, nunca banco ou
   token amplo GitHub. Launcher remove credenciais alheias.
5. Refazer autorização humana da política com harness `responses-api`,
   `DELIVERY_RUNNER_ATTESTATION=isolated-responses-capped-gateway-v1`, M3/M4 atuais
   e conteúdo synthetic. Política antiga `codex-sdk` e attestation anterior não
   habilitam o adaptador. `DELIVERY_ENABLED` continua OFF por padrão.
6. Executar uma demanda, um claim e uma chamada autorizada. Registrar somente
   job/base SHA/harness/modelo/ID do provedor redigido, status, latência, usage,
   custo estimado e teto, patch/testes/limpeza e revisão humana. Interromper em
   falha/ambiguidade; nova tentativa exige revisão explícita, nunca retry pago.
7. Aceite Responses comprovado deve ser rotulado `RESPONSES_REAL_VERIFIED`;
   jamais `CODEX_REAL_VERIFIED`. Para este último será necessário novo contrato e
   prova do SDK. `llm_verified` em resultado não é certificação global do marco.
8. Sem credencial mínima/repo/base para publicação, guardar patch verificado e
   manter PR NOT_CREATED. O executor atual não publica PR. Implementação de
   publicador separado é trabalho condicionado a esses pré-requisitos.

## Custo e evidência de falhas

MicroUSD inteiro; teto por execução:
`ceil((max_input_tokens * input_micro_usd_per_million + max_output_tokens * output_micro_usd_per_million) / 1000000)`.
A política deve cobrir esse máximo e respeitar tetos diário/total, jobs/dia,
concorrência e uma tentativa. Input usa limite conservador de bytes + 2048, não
uma promessa de tokenizer exato; pode recusar payload legítimo. Tarifa incorreta
não é detectável; confirmar tarifas na conta. Uso/reserva estimados não são fatura
nem margem BRL M4. Chamada ambígua debita reserva inteira.

Testar recusa por chave ausente, egress, modelo/schema, timeout, JSON/refusal,
usage/custo, cancelamento/revogação e mudança de escopo antes/depois de claim.
M0–M5 incluem testes Docker reais de paths, execução fixa, timeout/limpeza,
revogação e backup/restore; restauração revoga tokens, encerra jobs e desativa
políticas, nunca reativa inferência. Leases do gateway são voláteis: reinício
invalida tokens; não realocar manualmente job ambíguo. Broker durável e revisão
humana são obrigatórios para evitar repetição após reinício.

## Regressão e limites de aceite

CI executa instalação fixada, prova loopback SDK, testes adversariais Responses,
PostgreSQL/grants/migrações, tipagem/build, APIs M0–M5, backup/restore real,
formatação e cinco Playwright sequenciais. Imagens Responses/gateway também devem
ser construídas e importadas sem rede. Nenhuma etapa CI usa chave real.

Ambiente desta retomada é root, sem Docker/socket/capabilities: PostgreSQL do
launcher recusou root e testes Docker locais não foram declarados executados.
As regressões completas são verificadas no GitHub Actions por SHA; checks locais
limitam-se aos contratos sem Docker, tipagem, build, formatação e diagnóstico.
Fase A somente PREPARED após CI do HEAD aprovado. Fase B permanece NOT_VERIFIED
até configuração legítima do proprietário; parar nesse gate, sem iniciar M6.
