-- Iteration 6 — what the load test at the design point of NFR-13 demanded (REVIEW-I6).
--
-- The margin report read every order line of its period and folded them through the money
-- kernel. That was the right *architecture* — one definition of the rule, in `@mizan/money`
-- (D-029) — and at the volumes of I4's fixture it cost 90 ms for a year. At the design point,
-- 1.2 million lines, a year cost **436 seconds**. No amount of batching fixes a read whose cost
-- is the archive.
--
-- So the line keeps its margin the way it already keeps its cost: as a **snapshot written when
-- the line was saved**, by the same kernel, in both currencies. The report then sums stored
-- integers, which is what specification 2.11 says every report does. The rule still lives in
-- exactly one place; what changes is when it runs (D-039).
--
-- Historical margins are not recomputed from a later rate or a later price — they never were,
-- because the cost snapshot froze them; the stored figure freezes the same arithmetic.

ALTER TABLE order_lines
  ADD COLUMN margin_iqd bigint,
  ADD COLUMN margin_usd_cents bigint;

COMMENT ON COLUMN order_lines.margin_iqd IS
  'Margin of this line in dinars, computed by lineMargin() at save time from the cost snapshot; NULL when the line has no cost (cost_source = none).';
COMMENT ON COLUMN order_lines.margin_usd_cents IS
  'The same margin in cents: one computation converted at this line''s own rate, so the two can never disagree in sign (FR-1005).';

-- A margin exists exactly when a cost snapshot does, and both currencies arrive together.
ALTER TABLE order_lines
  ADD CONSTRAINT order_lines_margin_pair CHECK ((margin_iqd IS NULL) = (margin_usd_cents IS NULL));

-- ── the index the report reads ────────────────────────────────────────────────────────
--
-- The report finds the period's orders by date and then sums their lines. With the margin on
-- the line, that sum can be index-only: everything it needs travels in the index payload, so
-- 1.2 million lines are read without touching the heap.
CREATE INDEX order_lines_margin_idx ON order_lines (order_id)
  INCLUDE (item_id, margin_iqd, margin_usd_cents, line_total_iqd, line_total_usd_cents, cost_source)
  WHERE deleted_at IS NULL;

-- ── the index Receivables reads ───────────────────────────────────────────────────────
--
-- `customer_ledger_date_idx` carries (customer_id, entry_date) and no payload, so grouping a
-- million rows by customer went to the heap for every one of them: 2.3 seconds. With the
-- amounts and the type in the index the same pass is index-only.
CREATE INDEX customer_ledger_receivables_idx ON customer_ledger (customer_id, entry_date)
  INCLUDE (amount_iqd, amount_usd_cents, entry_type);
