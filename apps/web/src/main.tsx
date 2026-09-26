import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
/**
 * The two families of specification 3.7.1, self-hosted and subset (NFR-03 budgets 120 kB per
 * family; these are 48 kB each) and declared `font-display: swap`, so a slow connection shows
 * the text in a fallback rather than showing nothing.
 *
 * Only the ranges this system writes in: the Arabic range for Kurdish Sorani and Arabic —
 * which is what carries ڵ ڕ ۆ ێ ە ڤ گ چ پ ژ and their joining forms — and Latin for English
 * and for every digit. Until I6 the tokens named these fonts and nothing loaded them, so every
 * screen rendered in whatever the device happened to have; `/font-check` is where that shows.
 */
import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/vazirmatn/index.css';
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
