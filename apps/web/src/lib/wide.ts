import { useEffect, useState } from 'react';

/**
 * Is this a screen with room for a back-office layout?
 *
 * The same 64rem the stylesheet uses for the sidebar, asked in JavaScript because a list is a
 * **table** on a desktop and a stack of cards on a phone — and those are different markup, not
 * two skins of the same markup. Rendering both and hiding one with CSS would send every row
 * twice and read both to a screen reader; rendering the wrong one on a phone would undo the
 * work that makes this usable one-handed at 360 px (spec 2.10.2).
 */
const WIDE = '(min-width: 64rem)';

export function useIsWide(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === 'undefined' ? false : (window.matchMedia?.(WIDE).matches ?? false),
  );

  useEffect(() => {
    const query = window.matchMedia?.(WIDE);
    if (!query) return;
    const update = (): void => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return wide;
}
