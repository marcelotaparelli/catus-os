// Bundle size budget for the production build (dist/). Fails when a budget in
// perf-budget.json is exceeded; prints the measured values either way.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const budget = JSON.parse(readFileSync('perf-budget.json', 'utf8')).bundle;
const files = readdirSync('dist/assets');
const sum = (ext, gzip) =>
  files
    .filter((f) => f.endsWith(ext))
    .reduce((n, f) => {
      const b = readFileSync(`dist/assets/${f}`);
      return n + (gzip ? gzipSync(b, { level: 9 }).length : b.length);
    }, 0);
const measured = {
  jsRawBytes: sum('.js', false),
  jsGzipBytes: sum('.js', true),
  cssRawBytes: sum('.css', false),
  cssGzipBytes: sum('.css', true),
};
if (!measured.jsRawBytes)
  throw new Error('dist/assets has no JS: run npm run build first');
let failed = false;
for (const [k, v] of Object.entries(measured)) {
  const ok = v <= budget[k];
  failed ||= !ok;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(13)} ${String(v).padStart(7)} / ${budget[k]}`,
  );
}
mkdirSync('test-results', { recursive: true });
writeFileSync(
  'test-results/perf-bundle.json',
  JSON.stringify({ measured, budget }, null, 2),
);
process.exitCode = failed ? 1 : 0;
