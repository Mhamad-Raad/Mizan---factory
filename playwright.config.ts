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
    /**
     * The fixture is seeded through the API as a setup project rather than in `globalSetup`,
     * because the web servers below are started *after* global setup and the seeding needs
     * the API to be answering.
     */
    { name: 'setup', testMatch: /fixture\.setup\.ts/ },
    {
      name: 'phone',
      dependencies: ['setup'],
      testIgnore: /fixture\.setup\.ts/,
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } },
    },
  ],
  /**
   * The SPA and the API, so the screens are photographed with real data. The API is started
   * from its build output (CI builds before this step) against the test database, never the
   * development one.
   */
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: 'pnpm --filter @mizan/api start',
          url: 'http://localhost:3000/api/v1/health',
          reuseExistingServer: true,
          timeout: 60_000,
          env: {
            DATABASE_URL:
              process.env.TEST_DATABASE_URL ?? 'postgresql://mizan_app:mizan_app@localhost:5432/mizan_test',
            DATABASE_MIGRATE_URL:
              process.env.TEST_MIGRATE_URL ?? 'postgresql://mizan_migrate:mizan_migrate@localhost:5432/mizan_test',
            SESSION_PEPPER: process.env.SESSION_PEPPER ?? 'e2e-pepper-not-a-secret-0123456789',
            APP_BASE_URL: 'http://localhost:5173',
            NODE_ENV: 'development',
            TZ: 'Asia/Baghdad',
          },
        },
        {
          command: 'pnpm --filter @mizan/web dev',
          url: 'http://localhost:5173',
          reuseExistingServer: true,
          timeout: 60_000,
        },
      ],
});
