import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ADMIN } from './accounts.js';

/**
 * Every screen, in every language, at the largest text size, on the narrowest phone
 * (Definition of done item 6, spec 2.10.2).
 *
 * The suite checked five screens for horizontal overflow — the login page and the three forms
 * and one report that were being built at the time. This sweep walks **every** route an admin
 * can open, in Kurdish, Arabic and English at 1.25× text, because a system that will not get
 * another update cannot rely on somebody noticing a sideways scroll later. One assertion per
 * screen: nothing may scroll sideways at 360 px, which is the one layout failure that makes a
 * screen unusable one-handed rather than merely ugly.
 */
const LANGUAGES = ['ckb-IQ', 'ar-IQ', 'en'] as const;

/** The routes that need no id. The detail routes are resolved from the fixture below. */
const STATIC_ROUTES = [
  '/orders',
  '/orders/new',
  '/materials',
  '/materials/new',
  '/customers',
  '/customers/new',
  '/purchases',
  '/purchases/new',
  '/damages',
  '/damages/new',
  '/users',
  '/users/new',
  '/history',
  '/reports',
  '/reports/sales',
  '/reports/receivables',
  '/reports/stock',
  '/dashboard',
  '/search',
  '/settings',
  '/import',
  '/font-check',
] as const;

async function signIn(page: Page, lang: string): Promise<void> {
  await page.addInitScript((language) => {
    localStorage.setItem(
      'mizan.prefs.v1',
      JSON.stringify({
        lang: language,
        theme: 'light',
        // The largest size of 3.7.2: whatever fits here fits at every smaller one.
        fontScale: 1.25,
        numerals: 'latn',
        sharedDevice: false,
      }),
    );
  }, lang);
  await page.goto('/login');
  const fields = page.locator('input');
  await fields.nth(0).fill(ADMIN.username);
  await fields.nth(1).fill(ADMIN.password);
  await page.locator('.mz-button--primary').first().click();
  await expect(page.locator('nav.mz-tabbar')).toBeVisible();
}

/** One id per kind, so the detail screens are swept too. */
async function detailRoutes(page: Page): Promise<string[]> {
  const of = async (path: string, route: string): Promise<string[]> => {
    const response = await page.request.get(`http://localhost:3000/api/v1${path}`);
    if (!response.ok()) return [];
    const body = (await response.json()) as { items?: { id: string }[] };
    const id = body.items?.[0]?.id;
    return id ? [`${route}/${id}`] : [];
  };
  return [
    ...(await of('/orders?page_size=1', '/orders')),
    ...(await of('/items?page_size=1', '/materials')),
    ...(await of('/customers?page_size=1', '/customers')),
    ...(await of('/customers?page_size=1&side=supplier', '/customers')),
    ...(await of('/purchases?page_size=1', '/purchases')),
    ...(await of('/damages?page_size=1', '/damages')),
    ...(await of('/users?page_size=1', '/users')),
  ];
}

for (const lang of LANGUAGES) {
  test(`no screen scrolls sideways at 360 px and 1.25× text in ${lang}`, async ({ page }) => {
    await signIn(page, lang);
    const routes = [...STATIC_ROUTES, ...(await detailRoutes(page))];
    const sideways: string[] = [];

    for (const route of routes) {
      await page.goto(route);
      // A screen still loading is not a layout; wait for it to settle first.
      await expect(page.locator('.mz-skeleton')).toHaveCount(0);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) sideways.push(`${route} overflows by ${overflow} px`);
    }

    expect(sideways, `${routes.length} screens checked`).toEqual([]);
  });
}
