import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SALES } from './accounts.js';

/**
 * The idle sign-out (D-078) as a person meets it: fifteen minutes with nothing done ends the
 * session, the last minute warns, and the sign-in page says why. The browser's clock is moved
 * rather than waited for.
 */

async function signIn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (localStorage.getItem('mizan.prefs.v1')) return;
    localStorage.setItem(
      'mizan.prefs.v1',
      JSON.stringify({ lang: 'en', theme: 'light', fontScale: 1, numerals: 'latn', sharedDevice: false }),
    );
  });
  await page.goto('/login');
  const fields = page.locator('input');
  await fields.nth(0).fill(SALES.username);
  await fields.nth(1).fill(SALES.password);
  await page.locator('.mz-button--primary').first().click();
  await expect(page.locator('nav.mz-tabbar')).toBeVisible();
}

test.describe('the idle sign-out', () => {
  test('warns in the last minute, and a press keeps the session', async ({ page }) => {
    await page.clock.install();
    await signIn(page);

    await page.clock.runFor('14:30');
    const warning = page.getByRole('dialog', { name: 'Are you still there?' });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Signing out in');

    await warning.getByRole('button', { name: 'Stay signed in' }).click();
    await expect(warning).toBeHidden();
    await page.clock.runFor('10:00');
    await expect(page.locator('nav.mz-tabbar')).toBeVisible();
  });

  test('signs out after fifteen minutes, says why, and the session is over on the server', async ({ page }) => {
    await page.clock.install();
    await signIn(page);

    await page.clock.runFor('15:01');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('You were signed out after 15 minutes without activity')).toBeVisible();

    // The cookie left in the browser is worth nothing: a reload stays on the sign-in page.
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
    const me = await page.request.get('/api/v1/auth/me');
    expect(me.status()).toBe(401);
  });

  test('a browser opened again after the limit starts signed out', async ({ page }) => {
    await signIn(page);
    // As if the last activity in this browser were twenty minutes ago, and the tab closed since.
    await page.evaluate(() => localStorage.setItem('mizan.lastActivity.v1', String(Date.now() - 20 * 60_000)));
    await page.goto('/orders');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('You were signed out after 15 minutes without activity')).toBeVisible();
  });

  test('a tab follows a sign-out made in another', async ({ context, page }) => {
    await signIn(page);
    const other = await context.newPage();
    await other.goto('/');
    await expect(other.locator('nav.mz-tabbar')).toBeVisible();

    // Signed out in the first tab, as the account menu does it.
    await page.evaluate(async () => {
      const csrf = document.cookie.match(/(?:^|;\s*)mizan_csrf=([^;]+)/)?.[1] ?? '';
      await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
      localStorage.removeItem('mizan.lastActivity.v1');
    });
    await expect(other).toHaveURL(/\/login$/);
    // Signed out on purpose is not "signed out for inactivity".
    await expect(other.getByText('without activity')).toBeHidden();
  });
});
