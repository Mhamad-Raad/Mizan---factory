import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ACCOUNTANT, WAREHOUSE } from './accounts.js';
import { shot } from './shot.js';

/**
 * The buying screens of Iteration 2 on a 360 px phone (spec 3.3, Definition of done items 2
 * and 6): the Companies list, the company profile with its rate and accounting, the purchase
 * form and the purchase detail — in Kurdish and Arabic right-to-left, English left-to-right,
 * both themes, and at the largest text size.
 *
 * They are photographed as the two people who actually use them: the warehouse employee who
 * records a purchase on a phone, and the accountant who pays for it.
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
  await page.locator('.mz-button--primary').first().click();
  await expect(page.locator('nav.mz-tabbar')).toBeVisible();
}

const CASES: { lang: Locale; theme: Theme; name: string }[] = [
  { lang: 'ckb-IQ', theme: 'light', name: 'ckb-light' },
  { lang: 'ckb-IQ', theme: 'dark', name: 'ckb-dark' },
  { lang: 'en', theme: 'light', name: 'en-light' },
];

test.describe('the buying screens', () => {
  for (const testCase of CASES) {
    test(`companies and purchases render in ${testCase.name}`, async ({ page }) => {
      await withPreferences(page, testCase);
      await signIn(page, ACCOUNTANT);

      await page.goto('/companies');
      await expect(page.getByRole('link').filter({ hasText: 'Al-Noor' }).first()).toBeVisible();
      await shot(page, `companies-${testCase.name}.png`);

      await page.goto('/purchases');
      await expect(page.getByRole('link', { name: /#/ }).first()).toBeVisible();
      await shot(page, `purchases-${testCase.name}.png`);
    });
  }

  test('the company profile leads with the rate and what we owe', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/companies');
    await page.getByRole('link').filter({ hasText: 'Al-Noor' }).first().click();
    await expect(page).toHaveURL(/\/companies\/[0-9a-f-]{36}$/);
    await expect(page.locator('.mz-segmented')).toBeVisible();
    await expect(page.getByText('Al-Noor Steel Co.').first()).toBeVisible();

    // The company's own rate, not the global one (FR-703): 1,305 against the global 1,310.
    await expect(page.getByText('1,305', { exact: false }).first()).toBeVisible();

    // Both currencies, always (FR-1302), with ≈ on the converted side of a derived balance.
    const balance = page.locator('.mz-dual').first();
    await expect(balance).toContainText('د.ع');
    await expect(balance).toContainText('$');

    await shot(page, 'company-profile-ckb-light.png');
  });

  test('the accounting tab shows the ledger and what we owe per purchase', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/companies');
    await page.getByRole('link').filter({ hasText: 'Al-Noor' }).first().click();
    await page.getByRole('button', { name: 'Accounting' }).click();

    // The purchase and the payment, with the running balance the API computed in posting order.
    await expect(page.getByText('Purchase').first()).toBeVisible();
    await expect(page.getByText('What we owe per purchase')).toBeVisible();
    await shot(page, 'company-accounting-en-light.png');
  });

  test('the purchase detail shows the lines, the total and what we owe for it', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/purchases');
    await page.getByRole('link', { name: /#/ }).first().click();
    await expect(page.getByText('Copper wire 2 mm')).toBeVisible();
    await shot(page, 'purchase-detail-ckb-light.png');
  });

  test('the purchase form takes a company, a line and its bought price on one screen', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, WAREHOUSE);

    await page.goto('/purchases/new');
    // The company picker, with "No company — stock only" pinned at the top (FR-407).
    await page.locator('.mz-button--secondary').first().click();
    await expect(page.locator('input[type="search"]')).toBeVisible();
    await page.getByRole('button').filter({ hasText: 'Al-Noor Steel Co.' }).first().click();

    await page.getByRole('button').filter({ hasText: /کەرەستەیەکی تر/ }).first().click();
    await page.locator('input[type="search"]').fill('copper');
    await page.getByRole('button').filter({ hasText: 'Copper wire 2 mm' }).first().click();

    // The bought price arrived from this month's price list; 700 × 20 kg = 14,000 IQD.
    const kg = page.locator('input[inputmode="decimal"]').first();
    await kg.fill('20');
    await expect(page.locator('.mz-sticky-footer')).toContainText('14,000');

    await shot(page, 'new-purchase-ckb-light.png');
  });

  test('a stock-only purchase says so instead of naming a company', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, WAREHOUSE);

    await page.goto('/purchases/new');
    await expect(page.getByText('No company — stock only')).toBeVisible();
    await expect(page.getByText('Stock goes up and nobody is owed.')).toBeVisible();
  });

  test('the company payment sheet is usable one-handed and previews the new balance', async ({ page }) => {
    await withPreferences(page, { lang: 'ar-IQ', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/companies');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.getByRole('link').filter({ hasText: 'Al-Noor' }).first().click();
    // The profile has to be the screen before the primary button is reached for: since the
    // routes are split (I6) the list is still painted for a frame after the tap, and its own
    // primary button is "New company".
    await expect(page.getByRole('heading', { name: 'Al-Noor Steel Co.' }).first()).toBeVisible();
    await page.locator('.mz-button--primary').first().click();

    const iqd = page.locator('input[inputmode="numeric"]').first();
    await iqd.fill('100000');
    // The live preview of what the account will read after this payment (wireframe 3.4.2):
    // 3,050,000 owed less the 100,000 being handed over.
    const sheet = page.locator('.mz-sheet, .mz-bottom-sheet').first();
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('2,950,000');
    await shot(page, 'company-payment-ar-light.png');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('the purchase form does not scroll horizontally at 360 px and the largest text size', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light', fontScale: 1.25 });
    await signIn(page, WAREHOUSE);
    await page.goto('/purchases/new');
    await expect(page.locator('.mz-sticky-footer')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('every control on the purchase form is at least 44 px tall', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, WAREHOUSE);
    await page.goto('/purchases/new');
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
