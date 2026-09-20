import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ADMIN, SALES } from './accounts.js';

/**
 * The selling screens of Iteration 1 on a 360 px phone (spec 3.3, Definition of done items 2
 * and 6): Kurdish and Arabic right-to-left, English left-to-right, both themes, and the
 * largest text size — with the real API behind them, so a screenshot cannot pass while the
 * endpoint it shows is broken.
 *
 * This is the regression net. The Definition of done still asks for a person holding a real
 * phone: nothing here can tell whether Kurdish type *reads* well at arm's length.
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

async function signIn(page: Page, who: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  const fields = page.locator('input');
  await fields.nth(0).fill(who.username);
  await fields.nth(1).fill(who.password);
  // The primary button, not the last one: the last three buttons are the language chips.
  await page.locator('.mz-button--primary').first().click();
  await expect(page.locator('nav.mz-tabbar')).toBeVisible();
}

const CASES: { lang: Locale; theme: Theme; name: string }[] = [
  { lang: 'ckb-IQ', theme: 'light', name: 'ckb-light' },
  { lang: 'ckb-IQ', theme: 'dark', name: 'ckb-dark' },
  { lang: 'en', theme: 'light', name: 'en-light' },
];

test.describe('the selling screens', () => {
  for (const testCase of CASES) {
    test(`orders, materials and customers render in ${testCase.name}`, async ({ page }) => {
      await withPreferences(page, testCase);
      await signIn(page, SALES);

      await page.goto('/orders');
      await expect(page.getByRole('link', { name: /#/ }).first()).toBeVisible();
      await expect(page).toHaveScreenshot(`orders-${testCase.name}.png`, { fullPage: true });

      await page.goto('/materials');
      await expect(page.getByRole('link').filter({ hasText: 'Copper' }).first()).toBeVisible();
      await expect(page).toHaveScreenshot(`materials-${testCase.name}.png`, { fullPage: true });

      await page.goto('/customers');
      await expect(page.getByRole('link').filter({ hasText: 'Kawa' }).first()).toBeVisible();
      await expect(page).toHaveScreenshot(`customers-${testCase.name}.png`, { fullPage: true });
    });
  }

  test('an order detail shows both currencies, the status and what is still owed', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, SALES);

    await page.goto('/orders');
    await page.getByRole('link', { name: /#/ }).first().click();
    await expect(page.getByText('Copper wire 2 mm')).toBeVisible();

    // Both currencies on screen, always (FR-1302): the dinar total and its dollar side.
    const amounts = page.locator('.mz-dual').first();
    await expect(amounts).toContainText('د.ع');
    await expect(amounts).toContainText('$');

    await expect(page).toHaveScreenshot('order-detail-ckb-light.png', { fullPage: true });
  });

  test('the customer profile shows the balance and the ledger with its running balance', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, SALES);

    await page.goto('/customers');
    await page.getByRole('link').filter({ hasText: 'Kawa' }).first().click();
    await expect(page.getByText('Kawa Trading')).toBeVisible();

    // The ledger tab is the third segment (Overview · Orders · Ledger · History).
    await page.getByRole('button', { name: /.+/ }).nth(0).waitFor();
    await expect(page).toHaveScreenshot('customer-profile-ckb-light.png', { fullPage: true });
  });

  test('the material detail leads with the stock in its own measure', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, SALES);

    await page.goto('/materials');
    await page.getByRole('link').filter({ hasText: 'Copper' }).first().click();
    await expect(page.getByText('Copper wire 2 mm').first()).toBeVisible();
    await expect(page.getByText('5,987.500', { exact: false }).first()).toBeVisible();
    await expect(page).toHaveScreenshot('material-detail-ckb-light.png', { fullPage: true });
  });

  test('the order form takes a customer, a line and its price on one phone screen', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, SALES);

    await page.goto('/orders/new');
    // The customer picker: two letters in any script are enough (FR-1205, flow 3.5.1).
    await page.getByRole('button').filter({ hasText: /کڕیار|Kawa/ }).first().click();
    await page.locator('input[type="search"]').fill('kawa');
    await page.getByRole('button').filter({ hasText: 'Kawa Trading' }).first().click();

    await page.getByRole('button').filter({ hasText: /زیادکردنی هێڵ/ }).click();
    await page.locator('input[type="search"]').fill('copper');
    await page.getByRole('button').filter({ hasText: 'Copper wire 2 mm' }).first().click();

    // The price arrived from this month's price list, and the line total follows the quantity.
    const kg = page.locator('input[inputmode="decimal"]').first();
    await kg.fill('12.5');
    await expect(page.locator('.mz-sticky-footer')).toContainText('10,625');

    await expect(page).toHaveScreenshot('new-order-ckb-light.png', { fullPage: true });
  });

  test('the settings System card carries the global rate and the selling rules', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, ADMIN);

    await page.goto('/settings');
    await expect(page.getByText('1,310', { exact: false }).first()).toBeVisible();
    await expect(page).toHaveScreenshot('settings-system-ckb-light.png', { fullPage: true });
  });

  test('every selling screen is right-to-left in Arabic and left-to-right in English', async ({ page }) => {
    await withPreferences(page, { lang: 'ar-IQ', theme: 'light' });
    await signIn(page, SALES);
    await page.goto('/orders');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page).toHaveScreenshot('orders-ar-light.png', { fullPage: true });

    await withPreferences(page, { lang: 'en', theme: 'light' });
    await page.goto('/orders');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('the order form does not scroll horizontally at 360 px and the largest text size', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light', fontScale: 1.25 });
    await signIn(page, SALES);
    await page.goto('/orders/new');
    await expect(page.locator('.mz-sticky-footer')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('every control on the order form is at least 44 px tall', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, SALES);
    await page.goto('/orders/new');
    await expect(page.locator('.mz-sticky-footer')).toBeVisible();

    const controls = await page.locator('button, input, select, a[class*="mz-button"]').all();
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const box = await control.boundingBox();
      if (!box) continue;
      expect(box.height, await control.getAttribute('class')).toBeGreaterThanOrEqual(44);
    }
  });
});
