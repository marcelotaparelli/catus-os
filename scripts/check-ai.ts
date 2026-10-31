import { configuredProvider, reservation } from '../src/server/ai/provider';
try {
  const provider = configuredProvider();
  if (!provider) {
    console.log(
      'Inferência indisponível. Configure LLM_ENABLED, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_DATA_POLICY_ID e preços de teste por meio seguro. Nenhuma requisição enviada.',
    );
    process.exitCode = 2;
  } else
    console.log(
      'Configuração local válida (não comprova autorização do provedor):',
      {
        model: provider.config.model,
        promptVersion: provider.config.promptVersion,
        reservedMicroUsdPerAttempt: reservation(provider.config),
        maxInputTokens: provider.config.maxInputTokens,
        maxOutputTokens: provider.config.maxOutputTokens,
        timeoutMs: provider.config.timeoutMs,
        attempts: 1,
      },
    );
} catch {
  console.error(
    'Configuração LLM inválida; inferência bloqueada. Verifique endpoint HTTPS, limites e preços explícitos. Nenhum segredo registrado.',
  );
  process.exitCode = 2;
}
