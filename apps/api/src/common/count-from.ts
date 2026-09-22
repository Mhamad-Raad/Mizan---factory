/**
 * The narrowest `FROM` a count can be built from (the I3 review's lesson, generalised by the
 * system-wide review).
 *
 * A list endpoint asks two questions of the same `WHERE`: "which twenty-five rows?" and "how
 * many altogether?". The page needs the joins and lateral subqueries that produce its
 * *columns* — a balance, what is still owed, the rate — and the count needs none of them
 * unless a filter mentions one. Reusing the page's `FROM` for the count therefore runs a
 * per-row subquery over the **whole** table to produce a single number: the unfiltered Orders
 * list spent 1,783 ms counting 1.16 million orders, of which the answer was 25 rows of data
 * and one integer.
 *
 * Every join listed here must be one whose presence cannot change the number of rows — a
 * `LEFT JOIN`, a `LEFT JOIN LATERAL`, or an inner join on a non-null foreign key whose parent
 * row is never removed (this system soft-deletes). Then dropping it when no condition mentions
 * its alias is exact, not an approximation.
 */
export function countFrom(
  base: string,
  where: string,
  joins: readonly { alias: string; sql: string }[],
): string {
  const needed = joins.filter((join) => where.includes(join.alias));
  return [base, ...needed.map((join) => join.sql)].join('\n');
}
