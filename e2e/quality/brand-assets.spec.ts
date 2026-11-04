/**
 * The journeys run on `vite dev`, which serves any file. This runs the production
 * build through the real static handler (allowlist and CSP): fonts and logo must
 * load there too, with no policy violation. Requires `npm run build` first.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { test, expect } from './fixtures';

const ORIGIN = 'http://127.0.0.1:4175';
let server: ChildProcess;
test.beforeAll(async () => {
  server = spawn('node_modules/.bin/bun', ['tests/support/static-server.ts'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(ORIGIN)).ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('static server did not start');
});
test.afterAll(() => {
  server?.kill('SIGTERM');
});

test('production server delivers brand fonts and logo under its CSP', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { csp: string[] }).csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { csp: string[] }).csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  const fontTypes: string[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('.woff2'))
      fontTypes.push(r.headers()['content-type'] ?? '');
  });
  const response = await page.goto(ORIGIN + '/');
  expect(response!.headers()['content-security-policy']).toContain(
    "style-src 'self'",
  );
  await expect(
    page.getByRole('link', { name: 'Entrar com conta corporativa' }),
  ).toBeVisible();
  const report = await page.evaluate(async () => {
    await document.fonts.ready;
    const box = document.querySelector('.logo use')!.getBoundingClientRect();
    return {
      fonts: [...document.fonts].map((f) => `${f.family} ${f.status}`).sort(),
      logo: box.width > 100 && box.height > 30,
      button: getComputedStyle(document.querySelector('.login-button')!)
        .fontFamily,
      text: getComputedStyle(document.querySelector('.access p')!).fontFamily,
      csp: (window as unknown as { csp: string[] }).csp,
    };
  });
  expect(report.fonts).toEqual(['Inter loaded', 'Lexend loaded']);
  expect(report.logo).toBe(true);
  expect(report.button).toMatch(/^Inter/);
  expect(report.text).toMatch(/^Lexend/);
  expect(report.csp).toEqual([]);
  expect(fontTypes).toEqual(['font/woff2', 'font/woff2']);
});
