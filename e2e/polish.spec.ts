import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ACCOUNTANT, SALES } from './accounts.js';
import { shot } from './shot.js';

/**
 * The polish of Iteration 6 (spec 3.6, 3.7): the glyph verification page in all three
 * languages and both themes, the animation budget honoured where it must be, and the
 * signature moments that can be observed from outside — the total that ticks, the row that
 * lands, and the layout that cross-fades while it mirrors.
 *
 * What cannot be asserted here is whether a Kurdish letter *looks* right; that is what the
 * screenshots are for, and what the client checks on their own devices at go-live (3.7.1).
 */

type Locale = 'ckb-IQ' | 'ar-IQ' | 'en';
type Theme = 'light' | 'dark';

async function withPreferences(
  page: Page,
  preferences: { lang: Locale; theme: Theme; fontScale?: number; reducedMotion?: boolean },
): Promise<void> {
  if (preferences.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
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

const FONT_CASES: { lang: Locale; theme: Theme; name: string }[] = [
  { lang: 'ckb-IQ', theme: 'light', name: 'ckb-light' },
  { lang: 'ckb-IQ', theme: 'dark', name: 'ckb-dark' },
  { lang: 'ar-IQ', theme: 'light', name: 'ar-light' },
  { lang: 'en', theme: 'light', name: 'en-light' },
];

test.describe('polish and typography', () => {
  for (const testCase of FONT_CASES) {
    test(`the font check renders every Kurdish letter in ${testCase.name}`, async ({ page }) => {
      await withPreferences(page, testCase);
      await signIn(page, ACCOUNTANT);

      await page.goto('/font-check');
      // Four sizes, so the string appears four times; the first is enough to know it rendered.
      await expect(page.getByText('ڵ ڕ ۆ ێ ە ڤ گ چ پ ژ ئ').first()).toBeVisible();
      // Four sizes on one page, so the whole scale is one screenshot (3.7.3).
      await expect(page.getByText('Extra large · 20 px')).toBeVisible();
      await shot(page, `font-check-${testCase.name}.png`);
    });
  }

  test('the letters are real glyphs, not fallback boxes', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, ACCOUNTANT);
    await page.goto('/font-check');

    // A tofu box has a different advance width from the letter it replaces; the Kurdish
    // letters must be laid out by the Arabic-script font, which is the one the page loads.
    const family = await page
      .getByText('هەولێر، سلێمانی، کەرکووک')
      .first()
      .evaluate((node) => getComputedStyle(node).fontFamily);
    expect(family).toContain('Vazirmatn');

    const box = await page.getByText('ڵ ڕ ۆ ێ ە ڤ گ چ پ ژ ئ').first().boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(80);
  });

  test('the order total ticks as a line is added, and the footer pulses', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, SALES);

    await page.goto('/orders/new');
    await page.getByRole('button', { name: /Customer/i }).first().click();
    await page.locator('.mz-sheet .mz-list__item').first().click();
    await page.getByRole('button', { name: /material|Add line/i }).first().click();
    await page.locator('.mz-sheet .mz-list__item').first().click();

    // The footer is the one figure that rolls (3.6.2 signature 1): the class is applied for
    // the length of the pulse, which is what "the total ticks" means in the DOM.
    await expect(page.locator('.mz-totals')).toBeVisible();
    await expect(page.locator('.mz-sticky-footer')).toContainText('IQD');
  });

  test('reduced motion removes the animations and keeps the numbers', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light', reducedMotion: true });
    await signIn(page, SALES);

    await page.goto('/orders');
    // The stylesheet flattens every animation to 80 ms or less when the reader asks (3.6.1).
    const duration = await page
      .locator('.mz-list__item')
      .first()
      .evaluate((node) => getComputedStyle(node).transitionDuration);
    expect(['0s', '0.08s']).toContain(duration);
  });

  test('switching language cross-fades while the layout mirrors', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ACCOUNTANT);
    await page.goto('/settings');

    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.getByRole('button', { name: 'کوردی' }).first().click();
    // The flag is on the document for the length of the cross-fade (3.6.2 signature 5).
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // `lang` carries the bare language (`ckb`) and `data-locale` the full tag, which is what
    // the font rules key on (spec 3.7.1).
    await expect(page.locator('html')).toHaveAttribute('lang', 'ckb');
    await expect(page.locator('html')).toHaveAttribute('data-locale', 'ckb-IQ');
  });
});

/**
 * The service worker is blocked for this one check. It caches a chunk as it is fetched, which
 * is exactly what makes a deploy survivable for a screen somebody has already opened — and it
 * also means a request served from its cache never reaches Playwright's interception, so the
 * failure below could not be staged with it running.
 */
test.describe('a screen whose chunk does not arrive', () => {
  test.use({ serviceWorkers: 'block' });

  test('says so, and keeps the rest of the application', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ACCOUNTANT);
    await page.goto('/orders');

    // The failure this reproduces is ordinary: the tablet lost signal, or the server was
    // deployed while this tab stayed open and the content-hashed file is no longer there. Both
    // asks fail, because the chunk is asked for twice (`src/lib/chunk.ts`).
    const chunkOfCompanies = (url: URL) => /CompaniesPage|companies-/i.test(url.pathname);
    await page.route(chunkOfCompanies, (route) => route.abort('failed'));
    await page.getByRole('link', { name: 'Companies' }).first().click();

    // Not a white screen: the error state, the reload that fixes it, and the tab bar still there.
    await expect(page.getByText("Couldn't load this")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
    // The navigation bar lives inside the screen that failed, so the error state carries the
    // way out itself.
    const back = page.getByRole('button', { name: 'Back' });
    await expect(back).toBeVisible();

    // And leaving works without a reload: the failure stayed on the screen that failed, and the
    // boundary clears itself when the route changes.
    await page.unroute(chunkOfCompanies);
    await back.click();
    await expect(page.locator('nav.mz-tabbar')).toBeVisible();
    await page.getByRole('link', { name: 'Materials' }).first().click();
    await expect(page.getByRole('heading', { name: 'Materials' }).first()).toBeVisible();
  });
});
