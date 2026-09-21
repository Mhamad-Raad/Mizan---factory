import { z } from 'zod';

/**
 * The system settings of specification 2.2.3. A key becomes editable in the iteration that
 * uses it, so nothing is built ahead of its brief: I0 opened the device and lock keys, I1
 * opens the money, stock, edit-window and period-lock keys that selling needs.
 */
export const SETTING_SCHEMAS = {
  week_start: z.enum(['sat', 'sun', 'mon']),
  date_format: z.literal('dd/MM/yyyy'),
  idle_lock_shared_minutes: z.number().int().min(1).max(120),
  idle_lock_default_minutes: z.number().int().min(1).max(1440),
  allow_negative_stock: z.boolean(),
  default_customer_currency: z.enum(['IQD', 'USD']),
  rate_guard_percent: z.number().int().min(1).max(100),
  settle_tolerance_iqd: z.number().int().min(0),
  settle_tolerance_usd_cents: z.number().int().min(0),
  pin_min_length_shared: z.number().int().min(4).max(6),
  pin_min_length_personal: z.number().int().min(4).max(6),
  allow_pin_switch_on_shared: z.boolean(),
  /** `null` = editable until the period is locked; a number of days when the admin sets one. */
  order_edit_window_days: z.number().int().min(0).max(365).nullable(),
  purchase_edit_window_days: z.number().int().min(0).max(365).nullable(),
  allow_edit_after_payment: z.boolean(),
  /** Proposed — not requested (FR-1109): business dates on or before this are frozen. */
  locked_through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  /** Proposed — not requested (FR-1106): days before the global rate is called stale. */
  rate_stale_days: z.number().int().min(1).max(60),
  go_live_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;

/**
 * What an admin may change through `PATCH /settings` today: the I0 device keys plus the keys
 * Iteration 1 puts on the Settings → System card (FR-1107, brief 4.3).
 */
export const EDITABLE_KEYS: readonly SettingKey[] = [
  'idle_lock_shared_minutes',
  'idle_lock_default_minutes',
  'week_start',
  'date_format',
  'allow_negative_stock',
  'default_customer_currency',
  'rate_guard_percent',
  'settle_tolerance_iqd',
  'settle_tolerance_usd_cents',
  'order_edit_window_days',
  // Iteration 2 opens the buying side's own window (FR-405).
  'purchase_edit_window_days',
  'allow_edit_after_payment',
  'locked_through',
  'rate_stale_days',
  // Iteration 5 puts the shared-tablet rules in the admin's hands (FR-106, 2.8): how long a
  // PIN must be on each kind of device, and whether a PIN may sign anybody in on a tablet
  // everybody holds.
  'pin_min_length_shared',
  'pin_min_length_personal',
  'allow_pin_switch_on_shared',
];

/**
 * Everyone may read these; the rest are admin-only (FR-1107). Beyond the two formatting keys
 * they are the rules an employee's own forms are subject to, so a screen can warn before the
 * API refuses instead of surprising them after a save.
 */
export const PUBLIC_SETTING_KEYS: readonly SettingKey[] = [
  'week_start',
  'date_format',
  'allow_negative_stock',
  'default_customer_currency',
  'settle_tolerance_iqd',
  'settle_tolerance_usd_cents',
  'order_edit_window_days',
  'purchase_edit_window_days',
  'allow_edit_after_payment',
  'locked_through',
  // The PIN form says the rule before the API refuses it, and a client that is about to lock
  // needs to know whether its lock screen may offer a PIN at all (FR-106).
  'pin_min_length_shared',
  'pin_min_length_personal',
  'allow_pin_switch_on_shared',
];

export type Settings = {
  [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]>;
};

export const DEFAULT_SETTINGS: Settings = {
  week_start: 'sat',
  date_format: 'dd/MM/yyyy',
  idle_lock_shared_minutes: 5,
  idle_lock_default_minutes: 30,
  allow_negative_stock: true,
  default_customer_currency: 'IQD',
  rate_guard_percent: 20,
  settle_tolerance_iqd: 250,
  settle_tolerance_usd_cents: 25,
  pin_min_length_shared: 6,
  pin_min_length_personal: 4,
  allow_pin_switch_on_shared: true,
  order_edit_window_days: null,
  purchase_edit_window_days: null,
  allow_edit_after_payment: false,
  locked_through: null,
  rate_stale_days: 3,
  go_live_date: null,
};
