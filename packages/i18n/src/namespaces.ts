/**
 * One namespace per module plus `common`, `errors` and `glossary` (spec 2.10.3).
 * The glossary namespace is separate on purpose: when the client ticks a different word in
 * section 1.6, exactly one file per language changes and no screen is touched (Q-A-04).
 */
export const NAMESPACES = [
  'common',
  'glossary',
  'errors',
  'auth',
  'users',
  'permissions',
  'history',
  'settings',
  'materials',
  'customers',
  'orders',
] as const;

export type Namespace = (typeof NAMESPACES)[number];
