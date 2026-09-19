import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The SPA and the API share an origin in production (spec 2.14: Caddy serves the SPA
      // and proxies /api), so development mirrors that rather than inventing CORS.
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
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
});
