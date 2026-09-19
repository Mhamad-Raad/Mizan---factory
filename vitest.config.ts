import { defineConfig } from 'vitest/config';

/**
 * The whole suite (spec 2.12). Files run one at a time: the API integration tests share one
 * database, and the kernel tests are milliseconds, so serialising costs nothing and removes a
 * class of flakiness that would otherwise appear only in CI.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      'packages/money',
      'packages/text',
      'packages/permissions',
      'packages/i18n',
      'packages/ledger',
      'apps/api',
      'apps/web',
    ],
  },
});
