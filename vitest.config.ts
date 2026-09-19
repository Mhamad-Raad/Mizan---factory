import { defineConfig } from 'vitest/config';

/** The whole suite: every package and app project (spec 2.12). */
export default defineConfig({
  test: {
    projects: [
      'packages/money',
      'packages/text',
      'packages/permissions',
      'packages/i18n',
      'packages/ledger',
    ],
  },
});
