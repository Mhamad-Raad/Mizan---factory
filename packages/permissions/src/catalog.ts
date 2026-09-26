/**
 * The permission catalog (spec 1.5.2). This file is the *only* place permissions are
 * defined: the API guard, the CI route test, the admin editor and the client's `<Can>`
 * all read it, and an unknown key is rejected on write (spec 2.6.1).
 */

export type Page =
  | 'materials'
  | 'purchases'
  | 'orders'
  | 'customers'
  | 'companies'
  | 'damages'
  | 'history'
  | 'reports'
  | 'settings'
  | 'dashboard'
  | 'fields';

export interface PermissionDefinition {
  key: string;
  page: Page;
  /** Keys the editor turns on automatically, and the guard expands at check time. */
  implies: readonly string[];
  /** i18n key for the label; the catalog carries no user-visible text itself. */
  labelKey: string;
  /** Marked "Proposed — not requested" in the specification (spec 1.8). */
  proposed?: true;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  // Materials
  { key: 'materials.view', page: 'materials', implies: [], labelKey: 'permissions.materials.view' },
  { key: 'materials.create', page: 'materials', implies: ['materials.view'], labelKey: 'permissions.materials.create' },
  { key: 'materials.edit', page: 'materials', implies: ['materials.view'], labelKey: 'permissions.materials.edit' },
  {
    key: 'materials.set_prices',
    page: 'materials',
    implies: ['materials.view', 'fields.see_bought_price'],
    labelKey: 'permissions.materials.set_prices',
  },
  {
    key: 'materials.opening_stock',
    page: 'materials',
    implies: ['materials.view'],
    labelKey: 'permissions.materials.opening_stock',
  },

  // Purchases
  { key: 'purchases.view', page: 'purchases', implies: [], labelKey: 'permissions.purchases.view' },
  {
    key: 'purchases.create',
    page: 'purchases',
    // A purchase cannot be typed without its prices (spec 1.5.2).
    implies: ['purchases.view', 'materials.view', 'fields.see_bought_price'],
    labelKey: 'permissions.purchases.create',
  },
  { key: 'purchases.edit', page: 'purchases', implies: ['purchases.view'], labelKey: 'permissions.purchases.edit' },
  { key: 'purchases.void', page: 'purchases', implies: ['purchases.view'], labelKey: 'permissions.purchases.void' },

  // Orders
  { key: 'orders.view', page: 'orders', implies: [], labelKey: 'permissions.orders.view' },
  {
    key: 'orders.create',
    page: 'orders',
    implies: ['orders.view', 'customers.view', 'materials.view'],
    labelKey: 'permissions.orders.create',
  },
  { key: 'orders.edit', page: 'orders', implies: ['orders.view'], labelKey: 'permissions.orders.edit' },
  { key: 'orders.void', page: 'orders', implies: ['orders.view'], labelKey: 'permissions.orders.void' },
  {
    key: 'orders.change_payment_type',
    page: 'orders',
    implies: ['orders.view'],
    labelKey: 'permissions.orders.change_payment_type',
  },
  {
    key: 'orders.record_payment',
    page: 'orders',
    implies: ['orders.view', 'customers.view'],
    labelKey: 'permissions.orders.record_payment',
  },
  {
    key: 'orders.credit',
    page: 'orders',
    implies: ['orders.view', 'customers.view'],
    labelKey: 'permissions.orders.credit',
  },

  // Customers
  { key: 'customers.view', page: 'customers', implies: [], labelKey: 'permissions.customers.view' },
  {
    key: 'customers.view_all',
    page: 'customers',
    implies: ['customers.view'],
    labelKey: 'permissions.customers.view_all',
  },
  { key: 'customers.create', page: 'customers', implies: ['customers.view'], labelKey: 'permissions.customers.create' },
  { key: 'customers.edit', page: 'customers', implies: ['customers.view'], labelKey: 'permissions.customers.edit' },
  { key: 'customers.assign', page: 'customers', implies: ['customers.view'], labelKey: 'permissions.customers.assign' },
  {
    key: 'customers.opening_balance',
    page: 'customers',
    implies: ['customers.view', 'fields.see_customer_balances'],
    labelKey: 'permissions.customers.opening_balance',
  },
  {
    key: 'customers.set_rate',
    page: 'customers',
    implies: ['customers.view'],
    labelKey: 'permissions.customers.set_rate',
  },

  // Companies
  // A company is a business with `is_supplier` on the one Customers page (D-054), so seeing the
  // companies means opening that page — where the scope rule shows this employee the suppliers.
  {
    key: 'companies.view',
    page: 'companies',
    implies: ['customers.view'],
    labelKey: 'permissions.companies.view',
  },
  { key: 'companies.create', page: 'companies', implies: ['companies.view'], labelKey: 'permissions.companies.create' },
  { key: 'companies.edit', page: 'companies', implies: ['companies.view'], labelKey: 'permissions.companies.edit' },
  { key: 'companies.assign', page: 'companies', implies: ['companies.view'], labelKey: 'permissions.companies.assign' },
  {
    key: 'companies.set_rate',
    page: 'companies',
    implies: ['companies.view'],
    labelKey: 'permissions.companies.set_rate',
  },
  {
    key: 'companies.record_payment',
    page: 'companies',
    implies: ['companies.view', 'fields.see_company_balances'],
    labelKey: 'permissions.companies.record_payment',
  },
  {
    key: 'companies.adjust_owed',
    page: 'companies',
    implies: ['companies.view', 'fields.see_company_balances'],
    labelKey: 'permissions.companies.adjust_owed',
  },
  {
    key: 'companies.record_credit',
    page: 'companies',
    implies: ['companies.view', 'fields.see_company_balances'],
    labelKey: 'permissions.companies.record_credit',
  },
  {
    key: 'companies.opening_balance',
    page: 'companies',
    implies: ['companies.view', 'fields.see_company_balances'],
    labelKey: 'permissions.companies.opening_balance',
  },

  // Damaged items
  { key: 'damages.view', page: 'damages', implies: [], labelKey: 'permissions.damages.view' },
  {
    key: 'damages.create',
    page: 'damages',
    implies: ['damages.view', 'materials.view'],
    labelKey: 'permissions.damages.create',
  },
  { key: 'damages.edit', page: 'damages', implies: ['damages.view'], labelKey: 'permissions.damages.edit' },
  { key: 'damages.void', page: 'damages', implies: ['damages.view'], labelKey: 'permissions.damages.void' },
  {
    key: 'damages.mark_returned',
    page: 'damages',
    implies: ['damages.view'],
    labelKey: 'permissions.damages.mark_returned',
  },

  // History
  { key: 'history.view', page: 'history', implies: [], labelKey: 'permissions.history.view' },
  { key: 'history.view_all', page: 'history', implies: ['history.view'], labelKey: 'permissions.history.view_all' },
  {
    key: 'history.export',
    page: 'history',
    implies: ['history.view'],
    labelKey: 'permissions.history.export',
    proposed: true,
  },

  // Reports
  { key: 'reports.view', page: 'reports', implies: [], labelKey: 'permissions.reports.view' },
  { key: 'reports.view_all', page: 'reports', implies: ['reports.view'], labelKey: 'permissions.reports.view_all' },
  {
    key: 'reports.export',
    page: 'reports',
    implies: ['reports.view'],
    labelKey: 'permissions.reports.export',
    proposed: true,
  },

  // Settings
  { key: 'settings.set_global_rate', page: 'settings', implies: [], labelKey: 'permissions.settings.set_global_rate' },

  // Dashboard
  { key: 'dashboard.view', page: 'dashboard', implies: [], labelKey: 'permissions.dashboard.view', proposed: true },

  // Field-level flags
  { key: 'fields.see_bought_price', page: 'fields', implies: [], labelKey: 'permissions.fields.see_bought_price' },
  {
    key: 'fields.see_profit',
    page: 'fields',
    implies: ['fields.see_bought_price'],
    labelKey: 'permissions.fields.see_profit',
  },
  {
    key: 'fields.see_company_balances',
    page: 'fields',
    implies: [],
    labelKey: 'permissions.fields.see_company_balances',
  },
  {
    key: 'fields.see_customer_balances',
    page: 'fields',
    implies: [],
    labelKey: 'permissions.fields.see_customer_balances',
    proposed: true,
  },
] as const;

export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function permission(key: string): PermissionDefinition {
  const found = BY_KEY.get(key);
  if (!found) throw new Error(`unknown permission key: ${key}`);
  return found;
}

export function isPermissionKey(key: string): boolean {
  return BY_KEY.has(key);
}

export function permissionsOfPage(page: Page): readonly PermissionDefinition[] {
  return PERMISSIONS.filter((p) => p.page === page);
}

export const PAGES: readonly Page[] = [...new Set(PERMISSIONS.map((p) => p.page))];
