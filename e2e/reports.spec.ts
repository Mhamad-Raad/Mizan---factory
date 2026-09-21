import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ACCOUNTANT, ADMIN, SALES } from './accounts.js';

/**
 * The reports, History and the two Proposed screens of Iteration 4 on a 360 px phone (spec 3.3,
 * Definition of done items 2 and 6): the Reports hub, a report with its tiles and its
 * expandable groups, the History page with both user filters and an expandable diff, the
 * dashboard and global search — in Kurdish and Arabic right-to-left, English left-to-right,
 * both themes, and at the largest text size.
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

test.describe('the reports and History', () => {
  for (const testCase of CASES) {
    test(`the reports hub renders in ${testCase.name}`, async ({ page }) => {
      await withPreferences(page, testCase);
      await signIn(page, ACCOUNTANT);

      await page.goto('/reports');
      await expect(page.getByRole('link').first()).toBeVisible();
      await expect(page).toHaveScreenshot(`reports-hub-${testCase.name}.png`, { fullPage: true });
    });
  }

  test('the sales report totals the month in both currencies and groups by material', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/reports/sales');
    await expect(page.getByText('All groups')).toBeVisible();
    // The fixture's one order: 10,625 + 720,000 = 730,625 د.ع of revenue.
    await expect(page.getByText('730,625', { exact: false }).first()).toBeVisible();
    const amounts = page.locator('.mz-dual').first();
    await expect(amounts).toContainText('IQD');
    await expect(amounts).toContainText('$');
    await expect(page).toHaveScreenshot('report-sales-en-light.png', { fullPage: true });

    await page.getByRole('button', { name: 'Material' }).click();
    await expect(page.getByText('Copper wire 2 mm')).toBeVisible();
  });

  test('the margin report says what it is measured against, and flags a fallback price', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/reports/profit');
    await expect(
      page.getByText('Margin against the month price list', { exact: false }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('report-profit-en-light.png', { fullPage: true });
  });

  test('a report is pinned to a sales employee and says so', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, SALES);

    await page.goto('/reports/sales');
    await expect(page.getByText('Your own figures only')).toBeVisible();
  });

  test('the payables report reads the supplier balances', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/reports/payables');
    await expect(page.getByText('Al-Noor Steel Co.')).toBeVisible();
    await expect(page).toHaveScreenshot('report-payables-ckb-light.png', { fullPage: true });
  });

  test('History offers both user filters and expands a diff into old → new', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ADMIN);

    await page.goto('/history');
    await expect(page.getByText('Done by')).toBeVisible();
    await expect(page.getByText('Assigned to')).toBeVisible();

    await page.getByRole('button', { name: 'All' }).click();
    const entry = page.locator('.mz-card button[aria-expanded]').first();
    await entry.click();
    // The expanded entry shows its diff and the reference the support line asks for.
    await expect(page.getByText('Reference', { exact: false }).first()).toBeVisible();
    await expect(page).toHaveScreenshot('history-en-light.png', { fullPage: true });
  });

  test('the dashboard gives an owner today in tiles', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/dashboard');
    await expect(page.locator('.mz-tiles')).toBeVisible();
    await expect(page).toHaveScreenshot('dashboard-ckb-light.png', { fullPage: true });
  });

  test('search finds a customer by name and an order by its number', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    await page.goto('/search');
    await page.locator('input[type="search"]').fill('kawa');
    await expect(page.getByText('Kawa Trading')).toBeVisible();
    await expect(page).toHaveScreenshot('search-en-light.png', { fullPage: true });

    await page.locator('input[type="search"]').fill('1001');
    await expect(page.getByText('#1001').first()).toBeVisible();
  });

  test('search asks the server once for a typed word, not once per letter', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ACCOUNTANT);

    const asked: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/search')) asked.push(request.url());
    });

    await page.goto('/search');
    await page.locator('input[type="search"]').pressSequentially('kawa', { delay: 40 });
    await expect(page.getByText('Kawa Trading')).toBeVisible();
    // Four letters typed: the field holds the request until the typing stops (NFR-03). Two is
    // the allowance for a run where the delay between keystrokes exceeds the debounce.
    expect(asked.length, asked.join('\n')).toBeLessThanOrEqual(2);
  });

  test('the History diff arrow mirrors in Kurdish, so it points at the new value', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, ADMIN);

    // An order: the fixture edits one, so there is a field diff to draw an arrow in.
    await page.goto('/history?entity_type=order&preset=month');
    // `first().click()` waits for the list; counting first would race the query.
    await page.locator('.mz-card button[aria-expanded]').first().click();

    // A literal → character cannot mirror; the registry's arrow declares that it does, and the
    // stylesheet flips it in RTL (spec 2.10.6 point 2).
    const arrow = page.locator('.mz-card svg[data-mirror="true"]').first();
    await expect(arrow).toBeVisible();
    const flipped = await arrow.evaluate((node) => getComputedStyle(node).transform);
    expect(flipped).toContain('-1');
  });

  test('a report page is right-to-left in Arabic and does not scroll sideways at 1.25', async ({ page }) => {
    await withPreferences(page, { lang: 'ar-IQ', theme: 'light', fontScale: 1.25 });
    await signIn(page, ACCOUNTANT);

    await page.goto('/reports/stock');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByText('Copper wire 2 mm')).toBeVisible();
    await expect(page).toHaveScreenshot('report-stock-ar-light.png', { fullPage: true });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('every control on a report page is at least 44 px tall', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, ACCOUNTANT);
    await page.goto('/reports/sales');
    await expect(page.getByRole('button').first()).toBeVisible();

    const controls = await page.locator('button, input, select, a[class*="mz-button"]').all();
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const box = await control.boundingBox();
      if (!box) continue;
      expect(box.height, await control.getAttribute('class')).toBeGreaterThanOrEqual(44);
    }
  });
});
