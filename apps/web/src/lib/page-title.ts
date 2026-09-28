import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from './store.js';

/**
 * What the browser tab says: `<page> — Jiyan Management`, like the item-management system, so
 * a row of open tabs tells the pages apart (client review). The page is named in the reader's
 * language; the product's name is English in every language (D-072).
 */
export function useDocumentTitle(title: string | null): void {
  const { t } = useTranslation();
  const product = `${t('common:app_name')} ${t('common:app_tagline')}`;
  useEffect(() => {
    document.title = title ? `${title} — ${product}` : product;
  }, [title, product]);
}

/**
 * What the shell's header — and the browser tab — should say while this screen is open.
 *
 * The shell is a layout now, outside the routes, so a page no longer renders its own header —
 * it names itself and the layout does the rest. Written in an effect rather than during
 * render, because a page must not reach into a component above it mid-render; and the store
 * ignores a write that does not change the title, so a page that re-renders on every keystroke
 * does not re-render the shell with it.
 */
export function usePageTitle(title: string): void {
  const setPageTitle = useApp((state) => state.setPageTitle);
  useEffect(() => {
    setPageTitle(title);
  }, [title, setPageTitle]);
  useDocumentTitle(title);
}

/**
 * A title split into its words and the record number at its end — "Sale #1006" into "Sale" and
 * "#1006", "طلب رقم 1006" into "طلب رقم" and "1006" — so the header can shorten the words and
 * keep the number whole. As one run of text a narrow bar cut it from the wrong end in a
 * right-to-left language: "فرۆشتن #1006" showed "…06#".
 */
export function splitTitle(title: string): { label: string; number: string | null } {
  const match = /^(.*?)\s*(#?\s*[0-9٠-٩۰-۹][0-9٠-٩۰-۹,.-]*)$/u.exec(title);
  if (!match || !match[1]) return { label: title, number: null };
  return { label: match[1], number: match[2] ?? null };
}
