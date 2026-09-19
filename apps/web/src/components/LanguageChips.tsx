import { LANGUAGE_NAMES, LOCALES } from '@mizan/i18n';
import type { Locale } from '@mizan/i18n';
import { useApp } from '../lib/store.js';

/** Language names are always shown in their own script (FR-1104). */
export function LanguageChips() {
  const current = useApp((state) => state.preferences.lang);
  const setPreference = useApp((state) => state.setPreference);

  return (
    <div className="mz-row" role="group">
      {LOCALES.map((locale: Locale) => (
        <button
          key={locale}
          type="button"
          className={`mz-chip${locale === current ? ' mz-chip--primary' : ''}`}
          style={{ minBlockSize: '44px', paddingInline: 'var(--space-3)', cursor: 'pointer', border: 0 }}
          aria-pressed={locale === current}
          onClick={() => setPreference('lang', locale)}
          lang={locale.split('-')[0]}
        >
          {LANGUAGE_NAMES[locale]}
        </button>
      ))}
    </div>
  );
}
