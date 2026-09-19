import { describe, expect, it } from 'vitest';
import {
  EXTRAS,
  PERMISSIONS,
  PERMISSION_KEYS,
  PRESETS,
  applyExtra,
  applyPreset,
  diffSets,
  expandImplied,
  extraState,
  hasPermission,
  isCustomisedBeyondExtras,
  isPermissionKey,
  keysRequiring,
  matchesPreset,
  setKey,
  toSet,
} from './index.js';

describe('catalog integrity (spec 1.5.2)', () => {
  it('has unique keys, all of shape page.action', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const key of PERMISSION_KEYS) expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it('only implies keys that exist, and never implies itself', () => {
    for (const definition of PERMISSIONS) {
      for (const implied of definition.implies) {
        expect(isPermissionKey(implied)).toBe(true);
        expect(implied).not.toBe(definition.key);
      }
    }
  });

  it('every non-view key of a page implies that page view', () => {
    const pagesWithView = new Set(
      PERMISSIONS.filter((p) => p.key.endsWith('.view')).map((p) => p.page),
    );
    for (const definition of PERMISSIONS) {
      if (definition.key.endsWith('.view')) continue;
      if (!pagesWithView.has(definition.page)) continue;
      expect([...expandImplied([definition.key])]).toContain(`${definition.page}.view`);
    }
  });

  it('carries the four field flags of the specification', () => {
    expect(PERMISSIONS.filter((p) => p.page === 'fields').map((p) => p.key)).toEqual([
      'fields.see_bought_price',
      'fields.see_profit',
      'fields.see_company_balances',
      'fields.see_customer_balances',
    ]);
  });

  it('marks the Proposed keys as proposed so they can be cut in one pass (spec 1.8)', () => {
    expect(PERMISSIONS.filter((p) => p.proposed).map((p) => p.key).sort()).toEqual([
      'dashboard.view',
      'fields.see_customer_balances',
      'history.export',
      'reports.export',
    ]);
  });
});

describe('implication (spec 1.5.2 rule 5)', () => {
  it('expands transitively: set_prices pulls in bought prices and the materials page', () => {
    expect([...expandImplied(['materials.set_prices'])].sort()).toEqual([
      'fields.see_bought_price',
      'materials.set_prices',
      'materials.view',
    ]);
  });

  it('expands see_profit through see_bought_price', () => {
    expect(expandImplied(['fields.see_profit']).has('fields.see_bought_price')).toBe(true);
  });

  it('a purchase cannot be typed without its prices', () => {
    const expanded = expandImplied(['purchases.create']);
    expect(expanded.has('fields.see_bought_price')).toBe(true);
    expect(expanded.has('materials.view')).toBe(true);
    expect(expanded.has('purchases.view')).toBe(true);
  });

  it('ignores unknown keys instead of throwing during expansion', () => {
    expect([...expandImplied(['nope.nope'])]).toEqual([]);
  });
});

describe('presets (spec 1.5.3)', () => {
  it('Sales sees customer balances but not bought prices', () => {
    const sales = expandImplied(PRESETS.sales.keys);
    expect(sales.has('fields.see_customer_balances')).toBe(true);
    expect(sales.has('fields.see_bought_price')).toBe(false);
    expect(sales.has('customers.view_all')).toBe(false);
  });

  it('Warehouse sees bought prices but no balances', () => {
    const warehouse = expandImplied(PRESETS.warehouse.keys);
    expect(warehouse.has('fields.see_bought_price')).toBe(true);
    expect(warehouse.has('fields.see_company_balances')).toBe(false);
    expect(warehouse.has('fields.see_customer_balances')).toBe(false);
  });

  it('Accountant holds every field flag', () => {
    const accountant = expandImplied(PRESETS.accountant.keys);
    for (const key of PERMISSIONS.filter((p) => p.page === 'fields')) {
      expect(accountant.has(key.key)).toBe(true);
    }
  });

  it('no preset grants a void key — voiding is granted individually (spec 1.5.2 rule 4)', () => {
    for (const preset of Object.values(PRESETS)) {
      expect(preset.keys.filter((key) => key.endsWith('.void'))).toEqual([]);
    }
  });

  it('applying a preset replaces the set and reports the diff', () => {
    const { keys, diff } = applyPreset(['orders.void', 'orders.view'], 'sales');
    expect(keys.has('orders.void')).toBe(false);
    expect(diff.revoked).toContain('orders.void');
    expect(diff.granted).toContain('orders.create');
    expect(matchesPreset(keys, 'sales')).toBe(true);
    expect(matchesPreset(keys, 'warehouse')).toBe(false);
  });
});

describe('the six extras and their "partly" state (FR-204, spec 2.6.5)', () => {
  it('there are exactly six', () => {
    expect(EXTRAS.map((extra) => extra.key)).toEqual([
      'can_void',
      'sees_bought_prices',
      'sees_all_customers',
      'sees_balances',
      'can_adjust_owed',
      'can_set_rates',
    ]);
  });

  it('a Sales employee shows "Sees balances: partly" — the example in the specification', () => {
    expect(extraState(PRESETS.sales.keys, 'sees_balances')).toBe('partly');
    expect(extraState(PRESETS.accountant.keys, 'sees_balances')).toBe('on');
    expect(extraState(PRESETS.warehouse.keys, 'sees_balances')).toBe('off');
  });

  it('turning on "Can void" grants all three void keys and their views', () => {
    const result = applyExtra(PRESETS.sales.keys, 'can_void', true);
    expect(extraState(result.keys, 'can_void')).toBe('on');
    expect(result.keys.has('orders.void')).toBe(true);
    expect(result.keys.has('purchases.void')).toBe(true);
    expect(result.keys.has('damages.void')).toBe(true);
    expect(result.alsoGranted).toContain('purchases.view');
  });

  it('refuses to turn off "sees bought prices" while purchases.create still implies it', () => {
    const result = applyExtra(PRESETS.warehouse.keys, 'sees_bought_prices', false);
    expect(result.blockedBy).toEqual(['purchases.create']);
    expect(result.keys.has('fields.see_bought_price')).toBe(true);
    expect(result.state).toBe('on');
  });

  it('allows turning it off once nothing implies it', () => {
    const withoutCreate = setKey(PRESETS.warehouse.keys, 'purchases.create', false).keys;
    const result = applyExtra(withoutCreate, 'sees_bought_prices', false);
    expect(result.blockedBy).toBeUndefined();
    expect(result.keys.has('fields.see_bought_price')).toBe(false);
  });

  it('names every granted key that holds another one on', () => {
    expect(keysRequiring(PRESETS.accountant.keys, 'fields.see_bought_price')).toEqual([
      'fields.see_profit',
      'materials.set_prices',
    ]);
  });
});

describe('setKey (spec 2.6.5)', () => {
  it('turning on an action turns on its page view, with a note', () => {
    const result = setKey([], 'orders.create', true);
    expect(result.keys.has('orders.view')).toBe(true);
    expect(result.alsoGranted).toEqual(['customers.view', 'materials.view', 'orders.view']);
  });

  it('turning off a page view turns off that page actions', () => {
    const granted = expandImplied(['orders.create', 'orders.edit', 'orders.record_payment']);
    const result = setKey(granted, 'orders.view', false);
    expect(result.keys.has('orders.create')).toBe(false);
    expect(result.keys.has('orders.edit')).toBe(false);
    expect(result.alsoRevoked).toEqual(['orders.create', 'orders.edit', 'orders.record_payment']);
    // Other pages are untouched.
    expect(result.keys.has('customers.view')).toBe(true);
  });

  it('refuses to remove a key another granted key implies', () => {
    const result = setKey(expandImplied(['orders.create']), 'customers.view', false);
    expect(result.blockedBy).toEqual(['orders.create']);
    expect(result.keys.has('customers.view')).toBe(true);
  });

  it('rejects an unknown key on write (spec 2.6.1)', () => {
    expect(() => setKey([], 'orders.destroy', true)).toThrow(/unknown permission key/);
  });
});

describe('admins and effective checks (spec 2.6.1)', () => {
  it('an admin passes every check without storing a row', () => {
    for (const key of PERMISSION_KEYS) expect(hasPermission(new Set(), key, 'admin')).toBe(true);
  });

  it('an employee with no permissions passes nothing', () => {
    for (const key of PERMISSION_KEYS) expect(hasPermission(new Set(), key)).toBe(false);
  });

  it('reports what changed for the audit row (old set -> new set)', () => {
    const diff = diffSets(['orders.view'], ['orders.view', 'orders.create']);
    expect(diff).toEqual({ granted: ['orders.create'], revoked: [] });
  });
});

describe('simple mode versus Advanced (spec 2.6.5)', () => {
  it('a preset plus extras is still describable in simple mode', () => {
    const withVoid = applyExtra(PRESETS.sales.keys, 'can_void', true).keys;
    expect(isCustomisedBeyondExtras(withVoid, 'sales')).toBe(false);
  });

  it('a single odd key sends the admin to Advanced', () => {
    const odd = setKey(PRESETS.sales.keys, 'damages.edit', true).keys;
    expect(isCustomisedBeyondExtras(odd, 'sales')).toBe(true);
  });

  it('an employee with no preset and no keys is not "customised"', () => {
    expect(isCustomisedBeyondExtras(toSet([]), null)).toBe(false);
  });
});
