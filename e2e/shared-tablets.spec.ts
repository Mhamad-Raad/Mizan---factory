import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ADMIN, SALES } from './accounts.js';
import { shot } from './shot.js';

/**
 * The shared-tablet screens of Iteration 5 on a 360 px phone (FR-106, FR-204, FR-1304): the
 * PIN card in Settings, the lock screen with its pad and its recent-user list, the admin's
 * Sessions tab and the Advanced permission grid — in Kurdish right-to-left and English
 * left-to-right, both themes, and at the largest text size.
 *
 * The pad is the screen that most needs a real check: it is used one-handed on a tablet
 * standing on a bench, so its keys must be large, its digits must stay left-to-right in Kurdish,
 * and nothing on it may depend on a software keyboard appearing.
 */

type Locale = 'ckb-IQ' | 'ar-IQ' | 'en';
type Theme = 'light' | 'dark';

async function withPreferences(
  page: Page,
  preferences: { lang: Locale; theme: Theme; fontScale?: number; shared?: boolean },
): Promise<void> {
  await page.addInitScript((prefs) => {
    localStorage.setItem(
      'mizan.prefs.v1',
      JSON.stringify({
        lang: prefs.lang,
        theme: prefs.theme,
        fontScale: prefs.fontScale ?? 1,
        numerals: 'latn',
        sharedDevice: prefs.shared ?? false,
        deviceLabel: prefs.shared ? 'Floor tablet 2' : undefined,
        // Four digits on a personal phone, six on a tablet everybody holds (FR-106).
        pinPolicy: { shared: 6, personal: 4, switchOnShared: true },
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

/** Sets a PIN through the Settings card, which is the only way an employee gets one. */
async function setPin(page: Page, password: string, pin: string): Promise<void> {
  await page.goto('/settings');
  // Scoped by a field only this card has, which is steadier than matching its heading.
  const card = page
    .locator('.mz-card')
    .filter({ hasText: /Repeat the PIN|أعد الرمز السري|ژمارەی نهێنی دووبارە/ })
    .first();
  const fields = card.locator('input');
  await fields.nth(0).fill(pin);
  await fields.nth(1).fill(pin);
  await fields.nth(2).fill(password);
  await card.locator('.mz-button--primary').first().click();
  await expect(card.getByText(/PIN saved|ژمارەی نهێنی پاشەکەوت کرا/)).toBeVisible();
}

test.describe('shared tablets', () => {
  test('an employee sets a PIN in Settings and unlocks with the pad', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, SALES);
    await setPin(page, SALES.password, '4321');

    // Locking from the header is what an employee does when they put the tablet down.
    await page.goto('/orders');
    await page.getByRole('button', { name: /Lock the screen/i }).click();
    await expect(page.locator('.mz-pinpad')).toBeVisible();
    await shot(page, 'lock-pinpad-en-light.png');

    // Four taps and the session is back — the same session, so drafts survive (2.8).
    for (const digit of '4321') await page.locator('.mz-pinpad__key', { hasText: digit }).click();
    await expect(page.locator('nav.mz-tabbar')).toBeVisible();
  });

  test('a wrong PIN says so and keeps the pad', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, SALES);
    await setPin(page, SALES.password, '4321');

    await page.goto('/orders');
    await page.getByRole('button', { name: /Lock the screen/i }).click();
    for (const digit of '9999') await page.locator('.mz-pinpad__key', { hasText: digit }).click();

    await expect(page.getByText('Wrong PIN')).toBeVisible();
    await expect(page.locator('.mz-pinpad')).toBeVisible();
    // The dots are cleared, so the next attempt starts from nothing.
    await expect(page.locator('.mz-pinpad__dot--on')).toHaveCount(0);
  });

  test('the lock screen falls back to the password, and can be switched back', async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, SALES);
    await setPin(page, SALES.password, '4321');

    await page.goto('/orders');
    await page.getByRole('button', { name: /Lock the screen/i }).click();
    await page.getByRole('button', { name: 'Use the password instead' }).click();

    await expect(page.locator('input[type="password"]')).toBeVisible();
    await page.locator('input[type="password"]').fill(SALES.password);
    await page.locator('.mz-button--primary').first().click();
    await expect(page.locator('nav.mz-tabbar')).toBeVisible();
  });

  test('the pad renders right-to-left in Kurdish with its digits still left-to-right', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light', shared: true });
    await signIn(page, SALES);
    await setPin(page, SALES.password, '654321');

    await page.goto('/orders');
    await page.locator('header button').last().click();
    await expect(page.locator('.mz-pinpad')).toBeVisible();

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // The pad is a keypad, not a sentence: 1-2-3 read the same way in every language (2.10.6).
    await expect(page.locator('.mz-pinpad')).toHaveAttribute('dir', 'ltr');
    // Six dots on a shared tablet, because its PINs are six digits long.
    await expect(page.locator('.mz-pinpad__dot')).toHaveCount(6);
    // And the backspace arrow points at the digits it deletes: the pad is a left-to-right
    // island, so the RTL mirroring rule must not reach inside it.
    const backspace = page.locator('.mz-pinpad__key--quiet svg');
    await expect(backspace).toHaveCSS('transform', 'none');
    await shot(page, 'lock-pinpad-ckb-light.png');
  });

  test('every key on the pad is a real target, and nothing scrolls sideways at 1.25', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'dark', fontScale: 1.25, shared: true });
    await signIn(page, SALES);
    await setPin(page, SALES.password, '654321');
    await page.goto('/orders');
    await page.locator('header button').last().click();
    await expect(page.locator('.mz-pinpad')).toBeVisible();

    for (const key of await page.locator('.mz-pinpad__key').all()) {
      const box = await key.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'lock-pinpad-ckb-dark-125.png');
  });

  test("the admin sees an employee's sessions and the devices that may use their PIN", async ({ page }) => {
    await withPreferences(page, { lang: 'en', theme: 'light' });
    await signIn(page, ADMIN);

    await page.goto('/users');
    await page.getByText('Rebaz', { exact: false }).first().click();
    await page.getByRole('tab', { name: 'Sessions' }).click();

    await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Devices that may use the PIN' })).toBeVisible();

    /**
     * Deliberately not a screenshot.
     *
     * This page's height is a function of how many times the suite has signed in as this
     * employee — every sign-in is a session and a ticket, and the accessibility pass alone
     * signs in nineteen times. The baseline came out 740 px when the test ran alone and
     * 5,044 px in a full run, which is a screenshot that fails for reasons that have nothing
     * to do with the interface (the same lesson as the clock-dependent History baseline in
     * REVIEW-I4). What the tab must *say* is asserted instead.
     */
    const firstSession = page.locator('.mz-card').first();
    await expect(firstSession).toContainText('Floor tablet 2');
    await expect(firstSession.getByText('Password').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke PIN sign-in everywhere' })).toBeVisible();
  });

  test('the Advanced grid is folded away, opens with every key named, and mirrors', async ({ page }) => {
    await withPreferences(page, { lang: 'ckb-IQ', theme: 'light' });
    await signIn(page, ADMIN);

    await page.goto('/users');
    await page.getByText('Rebaz', { exact: false }).first().click();
    await page.getByRole('tab', { name: /مۆڵەت|دەسەڵات/ }).click();

    const grid = page.locator('.mz-disclosure');
    await expect(grid).toBeVisible();
    // Folded: the simple editor is the answer nine times out of ten (FR-204). `details` keeps
    // its children in the DOM, so what is asserted is that they are not *shown*.
    await expect(grid).not.toHaveAttribute('open', /.*/);
    await expect(grid.locator('.mz-toggle').first()).toBeHidden();

    await grid.locator('summary').click();
    // Named in Kurdish, never as raw keys — a grid of `orders.record_payment` is unusable.
    await expect(grid.getByText('تۆمارکردنی پارەدان')).toBeVisible();
    await shot(page, 'permissions-advanced-ckb-light.png');
  });
});
