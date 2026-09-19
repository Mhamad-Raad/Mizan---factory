import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'ledger', include: ['src/**/*.test.ts'] } });
