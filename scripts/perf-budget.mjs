// Bundle size budget for the production build (dist/). Fails when a budget in
// perf-budget.json is exceeded; prints the measured values either way.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const budget = JSON.parse(readFileSync('perf-budget.json', 'utf8')).bundle;
const files = readdirSync('dist/assets');
// Fonts carry a .css name only because the server allows just .js and .css in
// /assets (docs/DESIGN_SYSTEM.md); they are budgeted on their own, not as style.
// Decided by the bytes too, so a stylesheet cannot leave the CSS totals through its name.
const isFont = (f) =>
  f.endsWith('.woff2.css') &&
  readFileSync(`dist/assets/${f}`).subarray(0, 4).toString('latin1') === 'wOF2';
const sum = (ext, gzip) =>
  files
    .filter((f) => f.endsWith(ext) && !isFont(f))
    .reduce((n, f) => {
      const b = readFileSync(`dist/assets/${f}`);
      return n + (gzip ? gzipSync(b, { level: 9 }).length : b.length);
    }, 0);
// Initial JS: entry script plus modulepreloads referenced by index.html. Module
// screens are separate chunks fetched on first visit and only count in the totals.
const html = readFileSync('dist/index.html', 'utf8');
const initial = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map(
  (m) => m[1],
);
const size = (gzip) =>
  initial.reduce((n, f) => {
    const b = readFileSync(`dist/assets/${f}`);
    return n + (gzip ? gzipSync(b, { level: 9 }).length : b.length);
  }, 0);
const measured = {
  initialJsRawBytes: size(false),
  initialJsGzipBytes: size(true),
  jsRawBytes: sum('.js', false),
  jsGzipBytes: sum('.js', true),
  cssRawBytes: sum('.css', false),
  cssGzipBytes: sum('.css', true),
  fontBytes: files
    .filter(isFont)
    .reduce((n, f) => n + readFileSync(`dist/assets/${f}`).length, 0),
};
if (!measured.jsRawBytes)
  throw new Error('dist/assets has no JS: run npm run build first');
let failed = false;
for (const [k, v] of Object.entries(measured)) {
  const ok = v <= budget[k];
  failed ||= !ok;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(18)} ${String(v).padStart(7)} / ${budget[k]}`,
  );
}
mkdirSync('test-results', { recursive: true });
writeFileSync(
  'test-results/perf-bundle.json',
  JSON.stringify({ measured, budget }, null, 2),
);
process.exitCode = failed ? 1 : 0;
