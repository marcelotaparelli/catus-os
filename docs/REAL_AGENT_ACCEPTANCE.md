# M5.1 — aceite sintético controlado (issue #4)

Baseline: `aec7a5ac439132fbd8752f7c64798c6973474960`, branch
`feat/m5-acceptance`. Preparação em andamento; inferência real
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
