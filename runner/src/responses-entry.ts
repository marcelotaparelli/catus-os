import { readFile } from 'node:fs/promises';
import { generateResponses } from './responses.ts';
const { task, sources } = JSON.parse(await readFile('/input.json', 'utf8'));
try {
  const result = await generateResponses(
    task,
    sources,
    process.env.CODEX_GATEWAY_URL ?? '',
    process.env.CODEX_GATEWAY_TOKEN ?? '',
    process.env.CODEX_MODEL ?? '',
    AbortSignal.timeout(task.settings.timeout_seconds * 1000),
  );
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stderr.write('responses_unavailable\n');
  process.exitCode = 2;
}
