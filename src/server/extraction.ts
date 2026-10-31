/** Future port. No provider is installed; proposals never create approved work implicitly. */
export interface ExtractionInput {
  interactionId: string;
  sourceText: string;
}
export interface RequirementProposal {
  title: string;
  description: string;
  evidence: string[];
  questions: string[];
}
export interface RequirementsExtractor {
  extract(
    input: ExtractionInput,
    signal: AbortSignal,
  ): Promise<RequirementProposal[]>;
}
export const extractionCapability = {
  available: false,
  reason: 'Provedor de extração ainda não implementado',
} as const;
