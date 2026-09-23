import { useEffect } from 'react';
import { useApp } from './store.js';

/**
 * What the shell's header should say while this screen is open.
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
}
