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
