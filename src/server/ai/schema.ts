import { InputError, text } from '../../shared/domain';
import type {
  Evidence,
  Grounded,
  ExtractionResult,
  SuggestedProposal,
} from '../../shared/extraction';
const str = { type: 'string', minLength: 1, maxLength: 2000 };
const evidence = { type: 'array', minItems: 1, maxItems: 4, items: str };
const grounded = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'evidence'],
  properties: { text: str, evidence },
};
const proposal = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'evidence', 'acceptance_criteria'],
  properties: {
    title: { ...str, maxLength: 200 },
    description: { ...str, maxLength: 4000 },
    evidence,
    acceptance_criteria: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: grounded,
    },
  },
};
export const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'summary',
    'requirements',
    'decisions',
    'commitments',
    'missing_information',
    'questions',
    'proposals',
  ],
  properties: {
    version: { type: 'integer', const: 1 },
    summary: grounded,
    requirements: { type: 'array', maxItems: 20, items: grounded },
    decisions: { type: 'array', maxItems: 10, items: grounded },
    commitments: { type: 'array', maxItems: 10, items: grounded },
    missing_information: { type: 'array', maxItems: 10, items: str },
    questions: { type: 'array', maxItems: 10, items: str },
    proposals: { type: 'array', maxItems: 8, items: proposal },
  },
};
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Invalid extraction object');
  const obj = value as Record<string, unknown>;
  if (
    Object.keys(obj).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(obj, k))
  )
    throw new InputError('Unexpected extraction fields');
  return obj;
}
function list(value: unknown, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length > max || value.length < min)
    throw new InputError('Invalid extraction list');
  return value;
}
function quotes(value: unknown, source: string): Evidence[] {
  return list(value, 4, 1).map((q) => {
    const quote = text(q, 'Evidence', 2000);
    const start = source.indexOf(quote);
    if (start < 0) throw new InputError('Evidence not present in source');
    return { quote, start, end: start + quote.length };
  });
}
function fact(value: unknown, source: string): Grounded {
  const o = object(value, ['text', 'evidence']);
  return {
    text: text(o.text, 'Fact', 2000),
    evidence: quotes(o.evidence, source),
  };
}
export function validateExtraction(
  value: unknown,
  source: string,
): ExtractionResult {
  const o = object(value, [
    'version',
    'summary',
    'requirements',
    'decisions',
    'commitments',
    'missing_information',
    'questions',
    'proposals',
  ]);
  if (o.version !== 1) throw new InputError('Unsupported extraction version');
  const proposals: SuggestedProposal[] = list(o.proposals, 8).map((v) => {
    const p = object(v, [
      'title',
      'description',
      'evidence',
      'acceptance_criteria',
    ]);
    return {
      title: text(p.title, 'Title'),
      description: text(p.description, 'Description', 4000),
      evidence: quotes(p.evidence, source),
      acceptance_criteria: list(p.acceptance_criteria, 8, 1).map((c) =>
        fact(c, source),
      ),
    };
  });
  return {
    version: 1,
    summary: fact(o.summary, source),
    requirements: list(o.requirements, 20).map((v) => fact(v, source)),
    decisions: list(o.decisions, 10).map((v) => fact(v, source)),
    commitments: list(o.commitments, 10).map((v) => fact(v, source)),
    missing_information: list(o.missing_information, 10).map((v) =>
      text(v, 'Missing', 2000),
    ),
    questions: list(o.questions, 10).map((v) => text(v, 'Question', 2000)),
    proposals,
  };
}
