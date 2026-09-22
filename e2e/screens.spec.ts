import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { shot } from './shot.js';

/**
 * The key screens of Iteration 0, in both directions and both themes. Every case sets the
 * device preferences the way the pre-paint script reads them, then loads the page — which also
 * exercises that contract on every run.
 */

type Locale = 'ckb-IQ' | 'ar-IQ' | 'en';
type Theme = 'light' | 'dark';

async function withPreferences(
  page: Page,
  preferences: { lang: Locale; theme: Theme; fontScale?: number },
): Promise<void> {
  await page.addInitScript((prefs) => {
    localStorage.setItem(
      'mizan.prefs.v1',
      JSON.stringify({
        lang: prefs.lang,
        theme: prefs.theme,
        fontScale: prefs.fontScale ?? 1,
        numerals: 'latn',
        sharedDevice: false,
      }),
    );
  }, preferences);
}

const CASES: { lang: Locale; theme: Theme; name: string }[] = [
  { lang: 'ckb-IQ', theme: 'light', name: 'ckb-light' },
  { lang: 'ckb-IQ', theme: 'dark', name: 'ckb-dark' },
  { lang: 'en', theme: 'light', name: 'en-light' },
];

test.describe('login screen', () => {
  for (const testCase of CASES) {
    test(`renders in ${testCase.name}`, async ({ page }) => {
      await withPreferences(page, testCase);
      await page.goto('/login');
      await expect(page.getByRole('button', { name: /.+/ }).first()).toBeVisible();
      await shot(page, `login-${testCase.name}.png`);
    });
  }

  test('is right-to-left in Kurdish and left-to-right in English', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ckb');

    await withPreferences(page, { lang: 'en', theme: 'light' });
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('applies the theme before the first paint, with no flash', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'dark' });
    await page.goto('/login');
    // The attribute is set by the inline script, so it is already correct in the first frame.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(22, 17, 22)');
  });

  test('does not scroll horizontally at 360 px, even at the largest text size', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light', fontScale: 1.25 });
    await page.goto('/login');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('every interactive control is at least 44 px tall', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await page.goto('/login');
    // The form is rendered after `/auth/me` answers; measuring before that finds nothing.
    await expect(page.locator('input').first()).toBeVisible();
    const controls = await page.locator('button, input, a[class*="mz-button"]').all();
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const box = await control.boundingBox();
      if (!box) continue;
      expect(box.height, await control.getAttribute('class')).toBeGreaterThanOrEqual(44);
    }
  });
});
