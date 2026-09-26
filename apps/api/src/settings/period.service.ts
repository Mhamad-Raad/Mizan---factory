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
    const [year, month, day] = this.today().split('-').map(Number) as [number, number, number];
    const shifted = new Date(Date.UTC(year, month - 1 - months, day));
    return shifted.toISOString().slice(0, 10);
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
