import { PERMISSIONS } from './catalog.js';

export type PresetKey = 'sales' | 'warehouse' | 'accountant';

export interface Preset {
  key: PresetKey;
  version: number;
  labelKey: string;
  keys: readonly string[];
}

/**
 * Presets (spec 1.5.3) are code constants with a version, so the editor can show
 * "differs from preset" and changing a preset later never rewrites existing users
 * (FR-105). They are a starting point, not a role.
 */
export const PRESETS: Readonly<Record<PresetKey, Preset>> = {
  sales: {
    key: 'sales',
    version: 1,
    labelKey: 'permissions.preset.sales',
    keys: [
      'orders.view',
      'orders.create',
      'orders.edit',
      'orders.change_payment_type',
      'orders.record_payment',
      'customers.view',
      'customers.create',
      'customers.edit',
      'materials.view',
      'damages.view',
      'damages.create',
      'history.view',
      'reports.view',
      'dashboard.view',
      'fields.see_customer_balances',
    ],
  },
  warehouse: {
    key: 'warehouse',
    version: 1,
    labelKey: 'permissions.preset.warehouse',
    keys: [
      'materials.view',
      'materials.create',
      'materials.edit',
      'materials.opening_stock',
      'purchases.view',
      'purchases.create',
      'purchases.edit',
      'companies.view',
      'damages.view',
      'damages.create',
      'damages.edit',
      'damages.mark_returned',
      'history.view',
      'dashboard.view',
      'fields.see_bought_price',
    ],
  },
  accountant: {
    key: 'accountant',
    version: 1,
    labelKey: 'permissions.preset.accountant',
    keys: [
      'companies.view',
      'companies.create',
      'companies.edit',
      'companies.set_rate',
      'companies.record_payment',
      'companies.adjust_owed',
      'companies.record_credit',
      'companies.opening_balance',
      'purchases.view',
      'orders.view',
      'orders.change_payment_type',
      'orders.record_payment',
      'orders.credit',
      'customers.view',
      'customers.view_all',
      'customers.opening_balance',
      'materials.view',
      'materials.set_prices',
      'damages.view',
      'damages.mark_returned',
      'history.view',
      'history.view_all',
      'reports.view',
      'reports.view_all',
      'settings.set_global_rate',
      'dashboard.view',
      'fields.see_bought_price',
      'fields.see_profit',
      'fields.see_company_balances',
      'fields.see_customer_balances',
    ],
  },
};

export type ExtraKey =
  | 'can_void'
  | 'sees_bought_prices'
  | 'sees_all_customers'
  | 'sees_balances'
  | 'can_adjust_owed'
  | 'can_set_rates';

export interface Extra {
  key: ExtraKey;
  labelKey: string;
  keys: readonly string[];
}

/**
 * The six everyday extras of the simple editor (spec 1.5.3, FR-204). Each maps to a fixed
 * group of catalog keys; simple mode and the Advanced grid edit one and the same set.
 */
export const EXTRAS: readonly Extra[] = [
  { key: 'can_void', labelKey: 'permissions.extra.can_void', keys: ['orders.void', 'purchases.void', 'damages.void'] },
  {
    key: 'sees_bought_prices',
    labelKey: 'permissions.extra.sees_bought_prices',
    keys: ['fields.see_bought_price'],
  },
  {
    key: 'sees_all_customers',
    labelKey: 'permissions.extra.sees_all_customers',
    keys: ['customers.view_all'],
  },
  {
    key: 'sees_balances',
    labelKey: 'permissions.extra.sees_balances',
    keys: ['fields.see_company_balances', 'fields.see_customer_balances'],
  },
  {
    key: 'can_adjust_owed',
    labelKey: 'permissions.extra.can_adjust_owed',
    keys: ['companies.adjust_owed', 'companies.record_credit'],
  },
  {
    key: 'can_set_rates',
    labelKey: 'permissions.extra.can_set_rates',
    keys: ['companies.set_rate', 'settings.set_global_rate'],
  },
];

/** Sanity net: a preset or extra may never name a key outside the catalog. */
const KNOWN = new Set(PERMISSIONS.map((p) => p.key));
for (const preset of Object.values(PRESETS)) {
  for (const key of preset.keys) {
    if (!KNOWN.has(key)) throw new Error(`preset ${preset.key} names an unknown key: ${key}`);
  }
}
for (const extra of EXTRAS) {
  for (const key of extra.keys) {
    if (!KNOWN.has(key)) throw new Error(`extra ${extra.key} names an unknown key: ${key}`);
  }
}
