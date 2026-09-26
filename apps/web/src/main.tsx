import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
// The other typefaces of Settings (D-061): declared here, and downloaded by the browser only
// when a device chooses one — a @font-face nobody uses costs nothing on the wire.
import '@fontsource-variable/noto-sans-arabic/index.css';
import '@fontsource-variable/noto-kufi-arabic/index.css';
import '@fontsource-variable/noto-naskh-arabic/index.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import '@mizan/ui/tokens.css';
import '@mizan/ui/base.css';
import { App } from './App.js';
import { ApiError } from './lib/api.js';
import { initI18n } from './lib/i18n.js';
import { applyPreferences, readPreferences } from './lib/preferences.js';

const preferences = readPreferences();
// The pre-paint script in index.html has already set these; applying them again keeps the
// document in step when the store is hydrated (spec 2.10.10).
applyPreferences(preferences);
await initI18n(preferences.lang);

/**
 * The API refuses everything but the change-password screen's own calls while the user must
 * choose a new password (security review, finding 6). When that answer arrives — an admin set a
 * temporary password while this tab was open — `me` is read again, and it carries the flag that
 * sends the app to the change-password screen instead of leaving an error on the current page.
 */
function onRefusal(error: unknown): void {
  if (error instanceof ApiError && error.code === 'PASSWORD_CHANGE_REQUIRED') {
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onRefusal }),
  mutationCache: new MutationCache({ onError: onRefusal }),
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
