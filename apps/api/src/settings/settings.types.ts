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
  settle_tolerance_iqd: z.number().int().min(0),
  settle_tolerance_usd_cents: z.number().int().min(0),
  go_live_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
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
  'settle_tolerance_iqd',
  'settle_tolerance_usd_cents',
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
  settle_tolerance_iqd: 250,
  settle_tolerance_usd_cents: 25,
  go_live_date: null,
};
