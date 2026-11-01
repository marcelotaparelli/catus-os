// SDK compatibility is NOT_VERIFIED. Production cannot invoke the CLI.
import { RunnerError } from './core.ts';
import type { CodeAgent, Changes } from './core.ts';
export class CodexAgent implements CodeAgent {
  readonly kind = 'codex-sdk' as const;
  async generate(): Promise<Changes> {
    throw new RunnerError('unavailable');
  }
}
