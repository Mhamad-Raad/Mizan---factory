import { Injectable } from '@nestjs/common';
import { todayInBaghdad } from '@mizan/i18n';
import { ApiError } from '../common/errors.js';

/**
 * Business dates (FR-601). "today" is an Asia/Baghdad day whatever the server's clock
 * (spec 2.10.4), and a document may be back-dated but never post-dated.
 */
@Injectable()
export class PeriodService {
  today(): string {
    return todayInBaghdad();
  }

  /**
   * A business date some whole months back, in Baghdad days — the default range of a document
   * that covers a period rather than an account's whole life (D-025).
   */
  monthsAgo(months: number): string {
    return monthsBefore(this.today(), months);
  }

  /** Back-dating is allowed and logged; a date in the future is not (FR-601). */
  assertNotFuture(isoDate: string, path = 'order_date'): void {
    if (isoDate > this.today()) {
      throw ApiError.validation([
        {
          path,
          code: 'FUTURE_DATE',
          message_key: 'errors:field.future_date',
          params: { date: isoDate },
        },
      ]);
    }
  }
}

/**
 * The same day some months earlier, clamped to that month's last day: 31 May less three
 * months is 28 or 29 February, not "31 February" rolled over into 3 March (review).
 */
export function monthsBefore(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
