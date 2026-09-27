/**
 * The date presets every list and report offers — Today, This week, This month, Last month,
 * This year — worked out in one place, so "this week" means the same seven days on every screen.
 *
 * Each takes today's **Baghdad** business date (`formatter.today()`, spec 2.10.4) as a
 * `YYYY-MM-DD` string and does its arithmetic on that calendar date alone; nothing here reads the
 * device's clock or time zone, which named yesterday for the first three hours of every Baghdad
 * day when it did.
 */
export interface Period {
  from: string;
  to: string;
}

/** The calendar date `days` after (or, negative, before) `day`. */
export function shiftDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The day before. */
export function yesterdayOf(today: string): string {
  return shiftDays(today, -1);
}

/** The last `count` days, today included. */
export function lastDays(today: string, count: number): Period {
  return { from: shiftDays(today, -(count - 1)), to: today };
}

/** "This week": the last seven days, today included. */
export function thisWeek(today: string): Period {
  return lastDays(today, 7);
}

/** The first of this month to today. */
export function thisMonth(today: string): Period {
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/** The whole of last month, its first day to its last. */
export function lastMonth(today: string): Period {
  const last = shiftDays(`${today.slice(0, 7)}-01`, -1);
  return { from: `${last.slice(0, 7)}-01`, to: last };
}

/** The first of January to today. */
export function thisYear(today: string): Period {
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

/** The same day a year earlier to today — the twelve months a statement covers (FR-507). */
export function lastTwelveMonths(today: string): Period {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return { from: date.toISOString().slice(0, 10), to: today };
}
