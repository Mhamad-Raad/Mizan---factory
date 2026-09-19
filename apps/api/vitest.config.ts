import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * NestJS resolves constructor dependencies from `design:paramtypes`, which esbuild cannot
 * emit. SWC can, so the API's tests are transformed with it — the same metadata `tsc`
 * produces for the production build. The options are inline rather than in `.swcrc` so the
 * suite behaves identically whether it is run from this package or from the repository root.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
  test: {
    name: 'api',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /** The API tests share one database, so the files run in sequence. */
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
