import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mizan/ui/tokens.css';
import '@mizan/ui/base.css';
import { App } from './App.js';
import { initI18n } from './lib/i18n.js';
import { applyPreferences, readPreferences } from './lib/preferences.js';

const preferences = readPreferences();
// The pre-paint script in index.html has already set these; applying them again keeps the
// document in step when the store is hydrated (spec 2.10.10).
applyPreferences(preferences);
await initI18n(preferences.lang);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Never retry a refusal; retry a flaky connection twice (FR-1305).
        const status = (error as { status?: number }).status;
        if (status && status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
