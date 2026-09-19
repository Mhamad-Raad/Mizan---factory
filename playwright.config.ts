import { defineConfig, devices } from '@playwright/test';

/**
 * Visual and RTL verification (spec 2.12). The screenshot set is deliberately small — the key
 * screens of this iteration in Kurdish (RTL) and English (LTR), both themes, at 360 px and at
 * the Extra large text size — because a large screenshot suite that nobody trusts gets
 * deleted, while eight screens that must not change get looked at.
 *
 * The Definition of done still requires a check on a real phone: this catches regressions, it
 * does not replace a human looking at Kurdish type on a real screen.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  expect: {
    // A few pixels of text antialiasing must not fail a build.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
  },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    locale: 'en-GB',
    timezoneId: 'Asia/Baghdad',
  },
  projects: [
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm --filter @mizan/web dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
