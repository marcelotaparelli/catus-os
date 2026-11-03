/**
 * Automated WCAG 2.2 A/AA checks (axe-core). Serious/critical violations fail
 * unless recorded in a11y-baseline.json (legacy debt, prioritised in
 * docs/QUALITY.md). A recorded entry only tolerates up to its node count, so
 * new instances still fail; entries that disappear must be removed.
 */
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect, expandAll, visit, MODULES, ROLES } from './fixtures';
import type { QualityRole } from './fixtures';

type Baseline = Record<string, Record<string, number>>;
const baseline: Baseline = JSON.parse(
  readFileSync(new URL('./a11y-baseline.json', import.meta.url), 'utf8'),
).screens;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: import('@playwright/test').Page, screen: string) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const grave = result.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  const found = Object.fromEntries(grave.map((v) => [v.id, v.nodes.length]));
  const allowed = baseline[screen] ?? {};
  const summary = result.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
  }));
  await test.info().attach(`axe-${screen}.json`, {
    body: JSON.stringify(summary, null, 2),
    contentType: 'application/json',
  });
  writeFileSync(
    test.info().outputPath('axe.json'),
    JSON.stringify(summary, null, 2),
  );
  const regressions = Object.entries(found).filter(
    ([rule, n]) => n > (allowed[rule] ?? 0),
  );
  expect(
    regressions,
    `new serious/critical axe violations on ${screen}`,
  ).toEqual([]);
  const fixed = Object.keys(allowed).filter((rule) => !(rule in found));
  expect(
    fixed,
    `remove fixed entries from a11y-baseline.json for ${screen}`,
  ).toEqual([]);
}

test('login screen', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: 'Entrar com conta corporativa' }),
  ).toBeVisible();
  await scan(page, 'login');
});

for (const role of Object.keys(ROLES) as QualityRole[])
  test(`every module as ${role} with all sections expanded`, async ({ as }) => {
    test.setTimeout(90000);
    const page = await as(role);
    for (const module of MODULES[role]) {
      await visit(page, module);
      await expandAll(page);
      // Mission Control keeps its historical baseline key.
      await scan(
        page,
        module === 'Mission Control'
          ? `mission-control-${role}`
          : `${slug(module)}-${role}`,
      );
    }
  });

test('restricted and unknown routes', async ({ as }) => {
  const page = await as('developer');
  await page.goto('/#/acesso');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Acesso restrito' }),
  ).toBeVisible();
  await scan(page, 'restricted-developer');
  await page.goto('/#/inexistente');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Página não encontrada' }),
  ).toBeVisible();
  await scan(page, 'not-found-developer');
});

function slug(s: string) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '-');
}
