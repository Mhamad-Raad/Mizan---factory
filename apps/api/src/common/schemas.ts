import { z } from 'zod';

/**
 * The request fields every controller shares, defined once (review, DRY): a date, an amount of
 * money and a rate are checked the same way everywhere, and checked *here* — a value the
 * database would refuse is a 422 naming the field, never a failed cast answering 500.
 */

/** A calendar date, `YYYY-MM-DD`, that exists: 2026-02-30 and 2025-13-01 are refused. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, 'not a calendar date');

/**
 * The largest amount a request may carry, in minor units: ten trillion. Far above any real
 * document, and low enough that converting it at any rate stays an exact integer (2.3.1).
 */
export const MAX_MINOR_AMOUNT = 10_000_000_000_000;

/** An amount in minor units (dinars, or cents), signed. */
export const minorAmount = z.number().int().min(-MAX_MINOR_AMOUNT).max(MAX_MINOR_AMOUNT);

/** A rate as typed: dinars per dollar, up to four decimals, and more than zero. */
export const rateString = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,4})?$/)
  .refine((value) => Number(value) > 0, 'rate must be more than zero');
