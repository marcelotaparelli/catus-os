/**
 * Runtime baseline of the production build (vite preview, same /api proxy):
 * time until Mission Control is usable, LCP, CLS, API calls at start, first
 * switch to a module (on-demand chunk + data) and latency of critical M3
 * interactions. Median of 3 runs against budgets in perf-budget.json.
 * Requires `npm run build` first (CI builds before this suite).
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { login } from '../login';

const budget = JSON.parse(readFileSync('perf-budget.json', 'utf8')).runtime;
const PREVIEW = 'http://127.0.0.1:4173';
let preview: ChildProcess;

test.beforeAll(async () => {
  expect(
    existsSync('dist/index.html'),
    'run npm run build before the quality suite',
  ).toBe(true);
  preview = spawn(
    'node_modules/.bin/vite',
    ['preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
    {
      stdio: 'ignore',
    },
  );
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(PREVIEW)).ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('vite preview did not start');
});
test.afterAll(() => {
  preview?.kill('SIGTERM');
});

const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test('production build: load, LCP, CLS, module switch and M3 interaction latency', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, 'po@browser.test'); // session cookie is host-scoped, valid on the preview port
  const samples: {
    ready: number;
    lcp: number;
    cls: number;
    startApiCalls: number;
    route: number;
    disclose: number;
    select: number;
  }[] = [];
  let apiCalls = 0;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) apiCalls++;
  });
  for (let run = 0; run < 3; run++) {
    apiCalls = 0;
    await page.goto(PREVIEW + '/', { waitUntil: 'commit' });
    await expect(
      page.getByRole('region', { name: 'Minhas prioridades' }),
    ).toBeVisible();
    const vitals = await page.evaluate(
      () =>
        new Promise<{ ready: number; lcp: number; cls: number }>((resolve) => {
          let lcp = 0,
            cls = 0;
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) lcp = e.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
          new PerformanceObserver((l) => {
            for (const e of l.getEntries() as (PerformanceEntry & {
              value: number;
              hadRecentInput: boolean;
            })[])
              if (!e.hadRecentInput) cls += e.value;
          }).observe({ type: 'layout-shift', buffered: true });
          setTimeout(
            () => resolve({ ready: performance.now(), lcp, cls }),
            100,
          );
        }),
    );
    await page.waitForLoadState('networkidle');
    const startApiCalls = apiCalls;
    const m3 = page.getByRole('region', { name: 'Controle comercial' });
    const tr = Date.now();
    await page
      .getByRole('navigation', { name: 'Módulos', exact: true })
      .getByRole('link', { name: 'Comercial', exact: true })
      .click();
    await expect(
      m3.getByRole('heading', { name: 'Contrato Portal B2B 2026' }),
    ).toBeVisible();
    const route = Date.now() - tr;
    const t0 = Date.now();
    await m3.getByText('Cadastrar contrato', { exact: true }).click();
    await expect(m3.getByLabel('Título do contrato')).toBeVisible();
    const disclose = Date.now() - t0;
    const select = m3.getByRole('combobox', {
      name: 'Versão de escopo',
      exact: true,
    });
    const value = await select
      .locator('option')
      .filter({ hasText: 'Portal B2B · V1 ·' })
      .getAttribute('value');
    const t1 = Date.now();
    await select.selectOption(value!);
    await expect(m3.getByLabel('Detalhe do escopo')).toBeVisible();
    samples.push({
      ...vitals,
      startApiCalls,
      route,
      disclose,
      select: Date.now() - t1,
    });
  }
  const result = {
    readyMs: median(samples.map((s) => s.ready)),
    lcpMs: median(samples.map((s) => s.lcp)),
    cls: median(samples.map((s) => s.cls)),
    startApiCalls: Math.max(...samples.map((s) => s.startApiCalls)),
    routeMs: median(samples.map((s) => s.route)),
    interactionMs: Math.max(
      median(samples.map((s) => s.disclose)),
      median(samples.map((s) => s.select)),
    ),
  };
  await test.info().attach('perf-runtime.json', {
    body: JSON.stringify({ result, budget, samples }, null, 2),
    contentType: 'application/json',
  });
  console.log('perf runtime', JSON.stringify(result));
  expect(result.readyMs).toBeLessThanOrEqual(budget.readyMs);
  expect(result.lcpMs).toBeLessThanOrEqual(budget.lcpMs);
  expect(result.cls).toBeLessThanOrEqual(budget.cls);
  expect(result.startApiCalls).toBeLessThanOrEqual(budget.startApiCalls);
  expect(result.routeMs).toBeLessThanOrEqual(budget.routeMs);
  expect(result.interactionMs).toBeLessThanOrEqual(budget.interactionMs);
});
