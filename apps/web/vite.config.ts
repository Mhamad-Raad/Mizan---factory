import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // The repository's one `.env` names both ports — `WEB_PORT` for this server, `PORT` for the
  // API it proxies to — so another project on 5173 or 3000 is moved away from in one place.
  const env = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '');
  const apiPort = Number(env.PORT ?? 3000);
  return {
    plugins: [react()],
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      proxy: {
        // The SPA and the API share an origin in production (spec 2.14: Caddy serves the SPA
        // and proxies /api), so development mirrors that rather than inventing CORS.
        '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      },
    },
    build: {
      target: 'es2022',
      /**
       * Splitting the long-lived dependencies away from application code keeps repeat loads
       * near-instant on the floor: a deploy that only changes a screen leaves these cached
       * (NFR-03).
       */
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (/[\\/]react(-dom|-router[^/]*)?[\\/]/.test(id)) return 'vendor';
            if (id.includes('@tanstack')) return 'query';
            if (id.includes('i18next')) return 'i18n';
            return undefined;
          },
        },
      },
    },
  };
});
