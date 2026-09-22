import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ACCOUNTANT, WAREHOUSE } from './accounts.js';
import { shot } from './shot.js';

/**
 * The damage screens of Iteration 3 on a 360 px phone (spec 3.3, 3.4.3, Definition of done
 * items 2 and 6): the Damaged items list with its chips and period totals, the record form with
 * its attribution tiles and stock-effect sentence, and the record itself with its return
 * actions — in Kurdish and Arabic right-to-left, English left-to-right, both themes, and at the
 * largest text size.
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

test.describe('the damage screens', () => {
  for (const testCase of CASES) {
    test(`the damaged items list renders in ${testCase.name}`, async ({ page }) => {
      await withPreferences(page, testCase);
      await signIn(page, WAREHOUSE);

      await page.goto('/damages');
      await expect(page.getByRole('link').filter({ hasText: 'Copper' }).first()).toBeVisible();
      await shot(page, `damages-${testCase.name}.png`);
    });
  }

  test('the list totals the period and says how many records it counted', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, WAREHOUSE);

    await page.goto('/damages');
    // 4 kg from the supplier and 2.5 kg back from a customer.
    await expect(page.getByText('6.500', { exact: false })).toBeVisible();
    await expect(page.getByText('2 records')).toBeVisible();
    // The value of the period, in both currencies, because this employee sees bought prices.
    const value = page.locator('.mz-dual').first();
    await expect(value).toContainText('IQD');
    await expect(value).toContainText('$');
  });

  test('the record form says what the save will do to stock, before it is tapped', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, WAREHOUSE);

    await page.goto('/damages/new');
    await page.locator('.mz-button--secondary').first().click();
    await page.locator('input[type="search"]').fill('copper');
    await page.getByRole('button').filter({ hasText: 'Copper wire 2 mm' }).first().click();

    const kg = page.locator('input[inputmode="decimal"]').first();
    await kg.fill('4');
    await expect(page.locator('.mz-sticky-footer')).toContainText('Stock will decrease by 4.000');

    // Attributed to a customer order, the same quantity leaves stock alone (A-30, FR-804).
    await page.getByRole('button', { name: 'Customer order' }).click();
    await expect(page.locator('.mz-sticky-footer')).toContainText('No stock change');

    await shot(page, 'new-damage-en-light.png');
  });

  test('the attribution tiles are four large targets in Kurdish too', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, WAREHOUSE);

    await page.goto('/damages/new');
    const tiles = page.locator('.mz-tile');
    await expect(tiles).toHaveCount(4);
    for (const tile of await tiles.all()) {
      const box = await tile.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await shot(page, 'new-damage-ckb-light.png');
  });

  test('a supplier record offers the return and its credit, pre-filled from the purchase', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/damages');
    // The 4 kg record is the supplier's; the 2.500 kg one came back from a customer.
    await page.getByRole('link').filter({ hasText: '4.000' }).first().click();
    await expect(page.getByText('Returnable — pending')).toBeVisible();
    await expect(page.getByText('Al-Noor Steel Co.')).toBeVisible();
    await shot(page, 'damage-detail-en-light.png');

    await page.getByRole('button', { name: 'Mark returned' }).click();
    // 4 kg × 5,900 د.ع on the purchase line, at the company's own rate (A-39, flow 3.5.5).
    await expect(page.getByText('From the purchase line')).toBeVisible();
    const amount = page.locator('input[inputmode="numeric"]').first();
    await expect(amount).toHaveValue('23600');
    await shot(page, 'damage-return-en-light.png');
  });

  test("a customer's record says the balance has not moved, and offers the two ways out", async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/damages');
    // The customer-order record is the 2.500 kg one.
    await page.getByRole('link').filter({ hasText: '2.500' }).first().click();
    await expect(page.getByText('Customer balance unchanged', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record customer credit' })).toBeVisible();
    await expect(page.getByText('No stock change', { exact: false })).toBeVisible();
  });

  test('the damage screens are right-to-left in Arabic', async ({ page }) => {
    await withPreferences(page, { lang: 'ar-IQ', theme: 'light' });
    await signIn(page, WAREHOUSE);

    await page.goto('/damages');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await shot(page, 'damages-ar-light.png');
  });

  test('the record form does not scroll horizontally at 360 px and the largest text size', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light', fontScale: 1.25 });
    await signIn(page, WAREHOUSE);
    await page.goto('/damages/new');
    await expect(page.locator('.mz-sticky-footer')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('every control on the record form is at least 44 px tall', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, WAREHOUSE);
    await page.goto('/damages/new');
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
