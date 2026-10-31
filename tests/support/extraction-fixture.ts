import { OpenAiCompatibleProvider } from '../../src/server/ai/provider';
import type { ModelConfig } from '../../src/server/ai/provider';
export const syntheticSource = `Reunião sintética da Loja Aurora.
Solicitamos rastreamento de pedidos no portal.
Solicitamos exportação CSV dos pedidos.
Solicitamos alerta de estoque baixo.
Decidimos revisar os requisitos com o PO.
O PO enviará os exemplos de pedidos.
O prazo e o limite de estoque ainda não foram definidos.`;
export function extractionFixture() {
  const fact = (text: string, quote: string) => ({ text, evidence: [quote] });
  const proposed = [
    [
      'Rastreamento de pedidos',
      'Solicitamos rastreamento de pedidos no portal.',
    ],
    ['Exportação CSV', 'Solicitamos exportação CSV dos pedidos.'],
    ['Alerta de estoque', 'Solicitamos alerta de estoque baixo.'],
  ];
  return {
    version: 1,
    summary: fact(
      'Reunião sobre pedidos e estoque.',
      'Reunião sintética da Loja Aurora.',
    ),
    requirements: proposed.map(([, q]) => fact(q!, q!)),
    decisions: [
      fact(
        'Revisar requisitos com o PO.',
        'Decidimos revisar os requisitos com o PO.',
      ),
    ],
    commitments: [
      fact('PO enviará exemplos.', 'O PO enviará os exemplos de pedidos.'),
    ],
    missing_information: ['Prazo e limite de estoque não definidos.'],
    questions: [
      'Qual é o prazo desejado?',
      'Qual limite de estoque deve disparar o alerta?',
    ],
    proposals: proposed.map(([title, quote]) => ({
      title,
      description: quote,
      evidence: [quote],
      acceptance_criteria: [fact(quote!, quote!)],
    })),
  };
}
export const fixtureModel: ModelConfig = {
  baseUrl: 'https://llm.test/v1',
  model: 'test-model',
  policyId: 'synthetic-test-policy',
  clientDataAllowed: false,
  maxInputTokens: 16000,
  maxOutputTokens: 4096,
  timeoutMs: 100,
  promptVersion: 'intake-v1',
  inputPrice: 150000,
  outputPrice: 600000,
};
export function fixtureProvider(
  transform?: (value: ReturnType<typeof extractionFixture>) => unknown,
  usage = true,
) {
  return new OpenAiCompatibleProvider(
    fixtureModel,
    'test-only-llm-key',
    async () =>
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify(
                transform
                  ? transform(extractionFixture())
                  : extractionFixture(),
              ),
            },
          },
        ],
        ...(usage
          ? { usage: { prompt_tokens: 100, completion_tokens: 200 } }
          : {}),
      }),
  );
}
