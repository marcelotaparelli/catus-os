/**
 * Layout integrity at 360/390/768/1280/1440 px with every <details> expanded:
 * no horizontal page overflow, no visible control cut off by the viewport and
 * no overlapping interactive controls.
 */
import { test, expect, expandAll } from './fixtures';
import type { QualityRole } from './fixtures';

const WIDTHS = [360, 390, 768, 1280, 1440];
const ROLES: QualityRole[] = ['administrator', 'developer'];

for (const role of ROLES)
  for (const width of WIDTHS)
    test(`${role} at ${width}px`, async ({ page, as }) => {
      await page.setViewportSize({ width, height: 900 });
      await as(role);
      await expandAll(page);
      const report = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const visible = (e: Element) => {
          const r = e.getBoundingClientRect();
          const s = getComputedStyle(e);
          return (
            r.width > 0 &&
            r.height > 0 &&
            s.visibility !== 'hidden' &&
            s.display !== 'none'
          );
        };
        const name = (e: Element) =>
          `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} "${(e.textContent || (e as HTMLInputElement).name || '').trim().slice(0, 40)}"`;
        // Elements inside intentionally scrollable containers (mobile nav strip, <pre>) are exempt.
        const inScroller = (e: Element) =>
          !!e.parentElement?.closest('.mobile-nav, pre, [data-scroll-x]');
        const controls = [
          ...document.querySelectorAll(
            'main button, main a[href], main input, main select, main textarea, main summary',
          ),
        ].filter((e) => visible(e) && !inScroller(e));
        const cut = controls
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.left < -1 || r.right > vw + 1;
          })
          .map(name);
        const overlaps: string[] = [];
        const boxes = controls.map(
          (e) => [e, e.getBoundingClientRect()] as const,
        );
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            const [a, ra] = boxes[i]!;
            const [b, rb] = boxes[j]!;
            if (a.contains(b) || b.contains(a)) continue;
            const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (x > 2 && y > 2) overlaps.push(`${name(a)} × ${name(b)}`);
          }
        return {
          overflow: document.documentElement.scrollWidth - vw,
          cut,
          overlaps,
          controls: controls.length,
        };
      });
      expect(report.controls).toBeGreaterThan(5);
      expect(
        report.overflow,
        'horizontal page overflow (px)',
      ).toBeLessThanOrEqual(0);
      expect(report.cut, 'controls cut by the viewport').toEqual([]);
      expect(report.overlaps, 'overlapping controls').toEqual([]);
    });
