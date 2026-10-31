/** Public integration port. No simulated implementation is shipped with the application. */
export type {
  ExtractionProvider as RequirementsExtractor,
  ProviderResult,
  ModelConfig,
} from './ai/provider';
export { configuredProvider, OpenAiCompatibleProvider } from './ai/provider';
