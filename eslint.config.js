import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-restricted-syntax': [
        'error',
        {
          // Rule 1 of CLAUDE.md: money is never floating point.
          selector: "NewExpression[callee.name='Number'][arguments.0.type='Literal']",
          message: 'Do not wrap money literals in Number(); amounts are integers in minor units.',
        },
        {
          // Rule 6: formatting goes through the formatting service, never raw Intl for ckb.
          selector: "MemberExpression[object.name='Intl'][property.name=/^(NumberFormat|DateTimeFormat|PluralRules|RelativeTimeFormat)$/]",
          message:
            'Use @mizan/i18n formatting service instead of Intl directly (Intl has no usable ckb data — spec 2.10.4).',
        },
      ],
    },
  },
  {
    // The formatting service is the one place allowed to call Intl.
    files: ['packages/i18n/src/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**', '**/vitest.config.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    // The k6 load test of 2.12 runs inside k6, not node: `__ENV` is its own global, and its
    // `k6/*` imports resolve in that runtime. It is linted for style and not for environment.
    files: ['load/**'],
    languageOptions: { globals: { __ENV: 'readonly' } },
    rules: { 'import/no-unresolved': 'off', 'no-undef': 'off' },
  },
);
