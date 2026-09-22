import { useTranslation } from 'react-i18next';
import { Card } from '@mizan/ui';
import { AppShell } from '../components/AppShell.js';
import { DualAmount } from '../components/DualAmount.js';
import { useApp, useFormatter } from '../lib/store.js';
import type { FontScale } from '../lib/preferences.js';

/**
 * The glyph verification page of specification 3.7.1, repeated in I6.
 *
 * Every Kurdish-specific letter, every joining form, both numeral systems and both currency
 * marks, at every font size and in both themes. It exists because a missing glyph does not
 * announce itself: Vazirmatn or a fallback will happily render ڵ as a tofu box or as a plain ل
 * with the ring dropped, and nobody notices until a customer's name is wrong on a receipt.
 *
 * It is deliberately not in the navigation — it is a test fixture with a URL, screenshotted in
 * three languages and both themes, and checked by eye on the client's own devices at go-live.
 */

/** The string of 3.7.1, letter for letter. */
const KURDISH_LETTERS = 'ڵ ڕ ۆ ێ ە ڤ گ چ پ ژ ئ';
const PLACES = 'هەولێر، سلێمانی، کەرکووک';
const NUMERALS = '١٢٣ ۱۲۳ 123';
const CURRENCIES = 'د.ع $';

/** Each Kurdish letter in its initial, medial, final and isolated forms. */
const JOINING: readonly { letter: string; forms: string }[] = [
  { letter: 'ڵ', forms: 'ڵا ـڵـ ـڵ ڵ' },
  { letter: 'ڕ', forms: 'ڕا ـڕ ـڕ ڕ' },
  { letter: 'ۆ', forms: 'ۆا ـۆ ـۆ ۆ' },
  { letter: 'ێ', forms: 'ێا ـێـ ـێ ێ' },
  { letter: 'ە', forms: 'ەا ـە ـە ە' },
  { letter: 'ڤ', forms: 'ڤا ـڤـ ـڤ ڤ' },
  { letter: 'گ', forms: 'گا ـگـ ـگ گ' },
  { letter: 'چ', forms: 'چا ـچـ ـچ چ' },
  { letter: 'پ', forms: 'پا ـپـ ـپ پ' },
  { letter: 'ژ', forms: 'ژا ـژ ـژ ژ' },
];

const SCALES: readonly { scale: FontScale; label: string }[] = [
  { scale: 0.875, label: 'Small · 14 px' },
  { scale: 1, label: 'Default · 16 px' },
  { scale: 1.125, label: 'Large · 18 px' },
  { scale: 1.25, label: 'Extra large · 20 px' },
];

export function FontCheckPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const preferences = useApp((state) => state.preferences);

  return (
    <AppShell title={t('settings:font_check')}>
      <div className="mz-stack">
        <Card>
          <div className="mz-stack">
            <h2 className="mz-heading">{t('settings:font_check')}</h2>
            <p className="mz-caption">{t('settings:font_check_hint')}</p>
            <p className="mz-caption">
              {preferences.lang} · {preferences.theme} · {preferences.numerals} · {preferences.fontScale}
            </p>
          </div>
        </Card>

        {/* The specification's string at every size, each block carrying its own scale so one
            screenshot covers the whole scale rather than four. */}
        {SCALES.map(({ scale, label }) => (
          <Card key={scale}>
            <div className="mz-stack" style={{ ['--font-scale' as string]: String(scale) }}>
              <span className="mz-caption">{label}</span>
              <p className="mz-title">{KURDISH_LETTERS}</p>
              <p>{PLACES}</p>
              <p data-tabular dir="ltr">
                {NUMERALS} — {CURRENCIES}
              </p>
              {/* An amount through the real component, because that is how numbers are seen. */}
              <DualAmount amount_iqd={1_234_567} amount_usd_cents={94_968} primary="IQD" />
            </div>
          </Card>
        ))}

        <Card>
          <div className="mz-stack">
            <h3 className="mz-heading">{t('settings:font_check_joining')}</h3>
            {JOINING.map(({ letter, forms }) => (
              <div key={letter} className="mz-row mz-row--between">
                <span className="mz-caption" dir="ltr">
                  {letter.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}
                </span>
                <span className="mz-title">{forms}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <div className="mz-stack">
            <h3 className="mz-heading">{t('settings:font_check_numerals')}</h3>
            {/* The same figure through the formatting service in each numeral style, so a
                wrong digit shape shows up beside a right one (spec 2.10.4). */}
            <div className="mz-row mz-row--between">
              <span className="mz-caption">latn</span>
              <span data-tabular>{formatter.number(1234567.891, 3)}</span>
            </div>
            <div className="mz-row mz-row--between">
              <span className="mz-caption">{t('common:date')}</span>
              <span data-tabular>{formatter.date(formatter.today())}</span>
            </div>
            <div className="mz-row mz-row--between">
              <span className="mz-caption">{t('glossary:iqd')} / {t('glossary:usd')}</span>
              <DualAmount amount_iqd={1_300} amount_usd_cents={100} primary="USD" kind="derived" />
            </div>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
