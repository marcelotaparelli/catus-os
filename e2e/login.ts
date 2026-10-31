import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { codeFor } from '../tests/support/oidc-provider';
export async function login(page: Page, email: string) {
  // Simulate only the IdP authorization screen. Execute the real login endpoint,
  // preserve its state cookie, then return a code to the real callback without DNS/network to .test.
  await page.route('**/api/auth/login', async (route) => {
    const start = await route.fetch({ maxRedirects: 0 });
    expect(start.status()).toBe(303);
    const auth = new URL(start.headers().location!);
    await route.fulfill({
      response: start,
      headers: {
        ...start.headers(),
        location: `http://127.0.0.1:5173/api/auth/callback?state=${auth.searchParams.get('state')}&code=${codeFor(auth, email)}`,
      },
    });
  });
  await page.goto('/');
  await page
    .getByRole('link', { name: 'Entrar com conta corporativa' })
    .click();
  await expect(page).toHaveURL('http://127.0.0.1:5173/');
  await expect(page.getByText(email, { exact: false }).first()).toBeVisible();
}
