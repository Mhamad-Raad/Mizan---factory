-- System-wide review — three indexes on the customer ledger that nothing reads.
--
-- An index is not free: every ledger row written maintains all of them, for ever, on a table
-- that grows by roughly a million rows a year at the design point of NFR-13. The review
-- measured `pg_stat_user_indexes` after a year of seeded trading, every demo script, the whole
-- test suite and the endpoint budgets, and then proved each fallback by dropping the index
-- inside a transaction and re-planning the queries that could have wanted it.
--
--   * `customer_ledger_order_sum_idx` — `(order_id) INCLUDE (amounts) WHERE order_id IS NOT
--     NULL`, 69 MB, **never chosen**. It was built to group the ledger per order, which is the
--     job `order_remaining` took over in migration 0015 (D-040). The per-order lookups that
--     remain are served by `customer_ledger_order_idx`, which has the same predicate and the
--     same leading column and is smaller — which is why the planner picks it 8.3 million times
--     and this one not once.
--   * `customer_ledger_date_idx` — `(customer_id, entry_date)`, 37 MB. Every query that used it
--     re-plans onto `customer_ledger_receivables_idx`, which leads with the same two columns
--     and carries the amounts as well: the same bitmap index scan, measured at the same time.
--   * `customer_ledger_running_idx` — `(customer_id, posting_seq)`, 65 MB, **never chosen**.
--     Reading one account in posting order sorts 20,000 rows in 2 ms either way; the planner
--     ignored the index with it present, so dropping it changes no plan at all.
--
-- 171 MB of index, and its share of every INSERT, for three queries that do not use it. What is
-- kept is the narrow, hot set: the balance sum, the per-order lookup, the receivables pass, the
-- date range, the reversal and voucher keys, and idempotency.

DROP INDEX IF EXISTS customer_ledger_order_sum_idx;
DROP INDEX IF EXISTS customer_ledger_date_idx;
DROP INDEX IF EXISTS customer_ledger_running_idx;

ANALYZE customer_ledger;
