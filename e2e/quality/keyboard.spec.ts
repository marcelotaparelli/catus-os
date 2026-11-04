/**
 * Keyboard operation complementing axe: every Tab stop shows a visible focus
 * indicator, M3 disclosure and policy checkboxes work without a mouse, and
 * focus never lands on hidden elements.
 */
import { test, expect, visit } from './fixtures';

for (const module of ['Mission Control', 'Comercial', 'Economia'] as const)
  test(`Tab order shows a visible focus indicator on every stop (administrator, ${module})`, async ({
    page,
    as,
  }) => {
    await as('administrator');
    await visit(page, module);
    await page.locator('body').focus();
    const seen: string[] = [];
    const problems: string[] = [];
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const e = document.activeElement as HTMLElement | null;
        if (!e || e === document.body) return null;
        const s = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return {
          id: `${e.tagName.toLowerCase()}${e.getAttribute('type') ? '[' + e.getAttribute('type') + ']' : ''} "${(e.textContent || e.getAttribute('aria-label') || e.closest('label')?.textContent || '').trim().slice(0, 40)}"`,
          indicator:
            (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1) ||
            s.boxShadow !== 'none',
          visible: r.width > 0 && r.height > 0,
        };
      });
      if (!info) continue;
      seen.push(info.id);
      if (!info.indicator) problems.push(`no focus indicator: ${info.id}`);
      if (!info.visible)
        problems.push(`focus on invisible element: ${info.id}`);
    }
    expect(new Set(seen).size).toBeGreaterThan(12);
    expect(problems).toEqual([]);
  });

test('M3 policy is operable with keyboard only', async ({ page, as }) => {
  await as('administrator');
  await visit(page, 'Comercial');
  const m3 = page.getByRole('region', { name: 'Controle comercial' });
  const summary = m3.getByText('Configurar alçadas comerciais', {
    exact: true,
  });
  await summary.focus();
  await page.keyboard.press('Enter');
  const manager = m3.getByRole('checkbox', { name: 'Gestor pode decidir' });
  await expect(manager).toBeVisible();
  await expect(
    m3.getByRole('group', { name: 'Quem pode decidir escopos' }),
  ).toBeVisible();
  // Label and box sit together: the checkbox is immediately left of its text.
  const box = (await manager.boundingBox())!;
  const label = (await manager.locator('xpath=..').boundingBox())!;
  expect(box.x - label.x).toBeLessThan(4);
  expect(label.width).toBeLessThan(260);
  await manager.focus();
  await page.keyboard.press('Space');
  await expect(manager).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(manager).toBeChecked();
  // Saving is covered in zz-states.spec.ts (runs last: it changes seeded data).
  await expect(
    m3.getByRole('button', { name: 'Salvar alçadas' }),
  ).toBeEnabled();
});

test('module menu works with the keyboard and moves focus to the page title', async ({
  page,
  as,
}) => {
  await as('po');
  const link = page
    .getByRole('navigation', { name: 'Módulos', exact: true })
    .getByRole('link', { name: 'Comercial', exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/comercial$/);
  const title = page.getByRole('heading', { level: 1, name: 'Comercial' });
  await expect(title).toBeFocused();
  await expect(link).toHaveAttribute('aria-current', 'page');
  // The next Tab continues inside the page, not back at the top of the menu. The
  // account bar now sits above the title, so the next stop is in the module itself.
  await expect(
    page.getByRole('button', { name: 'Atualizar comercial' }),
  ).toBeEnabled();
  await page.keyboard.press('Tab');
  const inMain = await page.evaluate(
    () => !!document.activeElement?.closest('main'),
  );
  expect(inMain).toBe(true);
});
