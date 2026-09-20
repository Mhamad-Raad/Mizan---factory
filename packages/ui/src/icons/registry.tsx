import type { SVGProps } from 'react';

/**
 * The icon registry (spec 2.10.6 point 2). Every icon declares whether it mirrors in RTL:
 * a back arrow does, a clock does not. Mirroring is one CSS rule on `[data-mirror]`, so
 * there are never two copies of an asset to keep in step.
 */
export type IconName =
  | 'back'
  | 'chevron'
  | 'next'
  | 'search'
  | 'plus'
  | 'check'
  | 'close'
  | 'lock'
  | 'unlock'
  | 'user'
  | 'users'
  | 'history'
  | 'settings'
  | 'eye'
  | 'eye-off'
  | 'warning'
  | 'clock'
  | 'refresh'
  | 'trash'
  | 'logout'
  | 'shield'
  | 'orders'
  | 'materials'
  | 'customers'
  | 'companies'
  | 'purchases'
  | 'more';

/** Icons that imply a direction, and therefore mirror (spec 2.10.6). */
export const MIRRORED_ICONS: ReadonlySet<IconName> = new Set<IconName>([
  'back',
  'chevron',
  'next',
  'logout',
]);

const PATHS: Record<IconName, string> = {
  back: 'M19 12H5m7-7-7 7 7 7',
  chevron: 'm9 6 6 6-6 6',
  next: 'M5 12h14m-7-7 7 7-7 7',
  search: 'M21 21l-4.35-4.35M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z',
  plus: 'M12 5v14M5 12h14',
  check: 'm20 6-11 11-5-5',
  close: 'M18 6 6 18M6 6l12 12',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  unlock: 'M7 11V7a5 5 0 0 1 9.9-1M5 11h14v10H5z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87',
  history: 'M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8m9-1v5l4 2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.1l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.9-1.1L14.6 3h-4l-.4 2.6c-.7.3-1.3.7-1.9 1.1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.2l-2 1.6 2 3.4 2.4-1c.6.5 1.2.8 1.9 1.1l.4 2.6h4l.4-2.6c.7-.3 1.3-.6 1.9-1.1l2.4 1 2-3.4-2-1.6c.1-.4.1-.7.1-1.1Z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'eye-off': 'M17.9 17.9A10.8 10.8 0 0 1 12 20c-7 0-11-8-11-8a19.8 19.8 0 0 1 5.1-6M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a19.5 19.5 0 0 1-2.2 3.2M1 1l22 22M9.9 9.9a3 3 0 1 0 4.2 4.2',
  warning: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  clock: 'M12 6v6l4 2m6-2a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  trash: 'M3 6h18M8 6V4h8v2m1 0v14H7V6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  orders: 'M8 3h8a2 2 0 0 1 2 2v16l-6-3-6 3V5a2 2 0 0 1 2-2Zm0 5h8m-8 4h5',
  materials: 'M3 8.5 12 4l9 4.5-9 4.5-9-4.5Zm0 6L12 19l9-4.5',
  customers: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
  // A warehouse front for a supplier company, and a crate coming in for a purchase.
  companies: 'M3 21V7l7-4v18M10 21h11V11l-5-2M6 11h1m-1 4h1m7-4h2m-2 4h2m-2 4h2',
  purchases: 'M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8m-1 0h20l-2-4H4L2 8Zm7 4h6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-mirror={MIRRORED_ICONS.has(name) ? 'true' : undefined}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
