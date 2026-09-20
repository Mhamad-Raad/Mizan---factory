import { Injectable } from '@nestjs/common';
import { todayInBaghdad } from '@mizan/i18n';
import { firstOfMonth } from '@mizan/money';
import { ApiError } from '../common/errors.js';
import { SettingsService } from './settings.service.js';

/**
 * Business dates and the period lock (FR-601, FR-1109 — Proposed — not requested).
 *
 * Every rule here is about *dates*, which is why it is one service: "today" is an
 * Asia/Baghdad day whatever the server's clock (spec 2.10.4), a document may be back-dated
 * but never post-dated, and once a month has been read in the reports the admin can lock it
 * so nothing rewrites the past (spec 2.5.3 step 1).
 */
@Injectable()
export class PeriodService {
  constructor(private readonly settings: SettingsService) {}

  today(): string {
    return todayInBaghdad();
  }

  /** Back-dating is allowed and logged; a date in the future is not (FR-601). */
  assertNotFuture(isoDate: string, path = 'order_date'): void {
    if (isoDate > this.today()) {
      throw ApiError.validation([
        { path, code: 'FUTURE_DATE', message_key: 'errors:field.future_date', params: { date: isoDate } },
      ]);
    }
  }

  async lockedThrough(): Promise<string | null> {
    return this.settings.get('locked_through');
  }

  /**
   * Refuses a write whose business date falls in a locked period: edits, voids, reversals,
   * new back-dated documents, payments and opening entries alike (spec 2.5.3 step 1).
   */
  async assertNotLocked(isoDate: string): Promise<void> {
    const locked = await this.lockedThrough();
    if (locked && isoDate <= locked) {
      throw new ApiError('PERIOD_LOCKED', { locked_through: locked, date: isoDate });
    }
  }

  /**
   * A month's prices may be edited until that month has *fully ended* on or before the lock
   * date. Locking through 31 August therefore freezes August's prices but leaves September's
   * alone, which is the month people are still working in (spec 2.5.3 step 1).
   */
  async assertMonthNotLocked(isoMonth: string): Promise<void> {
    const locked = await this.lockedThrough();
    if (!locked) return;
    const month = firstOfMonth(isoMonth);
    if (lastDayOfMonth(month) <= locked) {
      throw new ApiError('PERIOD_LOCKED', { locked_through: locked, month });
    }
  }
}

/** `2026-08-01` → `2026-08-31`, computed in UTC because it is calendar arithmetic only. */
function lastDayOfMonth(isoMonth: string): string {
  const [year, month] = isoMonth.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year as number, month as number, 0));
  return lastDay.toISOString().slice(0, 10);
}
