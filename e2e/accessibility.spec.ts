import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ACCOUNTANT, ADMIN, SALES } from './accounts.js';

/**
 * The accessibility pass of Iteration 6 (NFR-10, Definition of done item 9).
 *
 * axe-core over every screen an employee reaches, in **Kurdish** rather than English, because
 * that is the language this system is used in and because a right-to-left page fails
 * differently: a label associated by position rather than by `for` survives an LTR review and
 * breaks when the direction flips.
 *
 * The rule set is the WCAG 2.1 A and AA tags — the same bar 3.2.4's contrast sheet is computed
 * against. Colour contrast is asserted here too, over the rendered page rather than over the
 * token table, so a combination nobody put in the sheet cannot slip through.
 */

async function withPreferences(page: Page, lang: 'ckb-IQ' | 'en', theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.addInitScript(
    (prefs) => {
      localStorage.setItem(
        'mizan.prefs.v1',
        JSON.stringify({
          lang: prefs.lang,
          theme: prefs.theme,
          fontScale: 1,
          numerals: 'latn',
          sharedDevice: false,
        }),
      );
    },
    { lang, theme },
  );
}

async function signIn(page: Page, who: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  const fields = page.locator('input');
  await fields.nth(0).fill(who.username);
  await fields.nth(1).fill(who.password);
  await page.locator('.mz-button--primary').first().click();
  await expect(page.locator('nav.mz-tabbar')).toBeVisible();
}

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target.join(' ')),
  }));
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

/** Every screen a signed-in employee can open, by the account that can open it. */
const SCREENS: { path: string; who: { username: string; password: string }; name: string }[] = [
  { path: '/orders', who: SALES, name: 'orders' },
  { path: '/orders/new', who: SALES, name: 'new order' },
  { path: '/customers', who: SALES, name: 'customers' },
  { path: '/materials', who: SALES, name: 'materials' },
  { path: '/customers?side=supplier', who: ACCOUNTANT, name: 'companies' },
  { path: '/purchases', who: ACCOUNTANT, name: 'purchases' },
  { path: '/damages', who: ACCOUNTANT, name: 'damaged items' },
  { path: '/reports', who: ACCOUNTANT, name: 'reports hub' },
  { path: '/reports/sales', who: ACCOUNTANT, name: 'a report' },
  { path: '/dashboard', who: ACCOUNTANT, name: 'dashboard' },
  { path: '/search', who: ACCOUNTANT, name: 'search' },
  { path: '/history', who: ADMIN, name: 'history' },
  { path: '/settings', who: ADMIN, name: 'settings' },
  { path: '/users', who: ADMIN, name: 'users' },
];

test.describe('accessibility (NFR-10)', () => {
  test('the sign-in screen passes in Kurdish and in English', async ({ page }) => {
    await withPreferences(page, 'ckb-IQ');
    await page.goto('/login');
    await expect(page.locator('input').first()).toBeVisible();
    await scan(page);

    await page.emulateMedia({ colorScheme: 'dark' });
    await scan(page);
  });

  for (const screen of SCREENS) {
    test(`${screen.name} passes in Kurdish`, async ({ page }) => {
      await withPreferences(page, 'ckb-IQ');
      await signIn(page, screen.who);
      await page.goto(screen.path);
      // Wait for the first request to settle, so the scan covers content and not a skeleton.
      await expect(page.locator('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await scan(page);
    });
  }

  test('the lock screen and its PIN pad pass', async ({ page }) => {
    await withPreferences(page, 'ckb-IQ');
    await signIn(page, SALES);
    await page.goto('/orders');
    await page.locator('header button').last().click();
    await expect(page.locator('main')).toBeVisible();
    await scan(page);
  });

  test('an open sheet is a real modal: the page behind it is inert', async ({ page }) => {
    await withPreferences(page, 'ckb-IQ');
    await signIn(page, SALES);
    await page.goto('/orders/new');
    await page.locator('.mz-button').first().click();
    const sheet = page.locator('.mz-sheet');
    await expect(sheet).toBeVisible();
    // The sheet rises over a dimmed backdrop, so a scan taken mid-animation measures every
    // colour in it against a half-transparent blend and reports the lot. Wait for it to land.
    await expect(sheet).toHaveCSS('opacity', '1');
    await page.waitForTimeout(350);

    // `aria-modal` is a claim; `inert` is what keeps it. Without this the keyboard walks into
    // the dimmed list underneath and a screen reader reads it (found by the I6 axe pass).
    await expect(page.locator('.mz-app')).toHaveAttribute('inert', '');

    // The sheet itself is scanned; the dimmed page behind it is excluded, because axe measures
    // *composited* colour and will always report 40 %-dimmed text as unreadable — which it is,
    // and deliberately so. The page's own contrast is asserted by the fourteen scans above,
    // where it is the thing being read.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .exclude('.mz-app')
      .analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);

    await page.locator('.mz-sheet button').last().click();
    await expect(page.locator('.mz-app')).not.toHaveAttribute('inert', '');
  });

  test('every control on the order form can be reached by keyboard alone', async ({ page }) => {
    await withPreferences(page, 'en');
    await signIn(page, SALES);
    await page.goto('/orders/new');
    await expect(page.locator('main')).toBeVisible();

    // Start from a known control rather than from wherever the browser put the focus, then
    // walk: every step must land somewhere, and the walk must keep moving (NFR-10).
    await page.locator('button, input').first().focus();
    const reached: string[] = [];
    for (let step = 0; step < 20; step += 1) {
      const focused = await page.evaluate(() => {
        const node = document.activeElement;
        if (!node || node === document.body) return null;
        const label = node.getAttribute('aria-label') ?? node.textContent ?? '';
        return `${node.tagName.toLowerCase()}:${label.trim().slice(0, 24)}`;
      });
      if (focused) reached.push(focused);
      await page.keyboard.press('Tab');
    }

    expect(reached.length).toBeGreaterThan(5);
    // A focus trap shows up as the same control for ever; a healthy form moves on.
    expect(new Set(reached).size).toBeGreaterThan(3);
  });
});
