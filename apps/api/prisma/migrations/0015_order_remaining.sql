-- Iteration 6 — the maintained sum specification 2.2.6 names as the optimisation of last
-- resort, for the one figure that cannot be computed on demand at the design point of NFR-13.
--
-- 2.2.6: "If a list of 10,000 customers with balances ever becomes slow, the reversal-safe
-- optimisation is a materialised view refreshed after each ledger transaction — **still a sum
-- over the ledger, never an edited field**."
--
-- The figure is *what is still owed on one order*. Every screen that asks "which orders are
-- unpaid?" has to ask it of every order: the dashboard tile (1.0 s at 1.2 million orders), the
-- unpaid count beside a customer on Receivables, and the status of an order in a list. Summing
-- the ledger per order is one pass over a million rows, and no index makes a pass shorter.
--
-- So the sum is *maintained* rather than materialised: one row per order, updated by a trigger
-- as each ledger row is inserted. This is legitimate precisely because the ledger is
-- append-only (2.4.1): there is no UPDATE and no DELETE to keep in step, a correction is
-- another INSERT, and a reversal adds its own negative row — so the maintained figure cannot
-- drift from the ledger unless the trigger is dropped. `scripts/check-integrity.mjs` compares
-- the two on every restore drill, because a cached number nobody checks is a number that lies.
--
-- It is not an editable column: the application role may not write it at all (0016), nothing
-- but the trigger touches it, and every screen still derives balances from the ledger itself.

CREATE TABLE order_remaining (
  order_id uuid PRIMARY KEY REFERENCES orders (id),
  -- Both currencies, as rule 1 requires of every stored amount; which one *is* the remaining
  -- depends on the customer's settlement currency, and the reader decides that.
  remaining_iqd bigint NOT NULL DEFAULT 0,
  remaining_usd_cents bigint NOT NULL DEFAULT 0,
  entries integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE order_remaining IS
  'A maintained sum over customer_ledger per order (spec 2.2.6). Written only by the trigger below; the application role has no privileges on it. Verified against the ledger by scripts/check-integrity.mjs.';

-- ── the trigger ──────────────────────────────────────────────────────────────────────
--
-- One upsert by primary key per ledger row: a few microseconds inside a transaction that is
-- already writing a ledger row, an order and an audit row.

CREATE OR REPLACE FUNCTION mizan_order_remaining_apply()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO order_remaining (order_id, remaining_iqd, remaining_usd_cents, entries, updated_at)
  VALUES (NEW.order_id, NEW.amount_iqd, NEW.amount_usd_cents, 1, now())
  ON CONFLICT (order_id) DO UPDATE
     SET remaining_iqd = order_remaining.remaining_iqd + EXCLUDED.remaining_iqd,
         remaining_usd_cents = order_remaining.remaining_usd_cents + EXCLUDED.remaining_usd_cents,
         entries = order_remaining.entries + 1,
         updated_at = now();

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_ledger_order_remaining
AFTER INSERT ON customer_ledger
FOR EACH ROW EXECUTE FUNCTION mizan_order_remaining_apply();

-- ── the backfill ─────────────────────────────────────────────────────────────────────
--
-- In the migration rather than a script, because the table is worthless until it agrees with
-- the ledger and the trigger only sees rows written from now on.

INSERT INTO order_remaining (order_id, remaining_iqd, remaining_usd_cents, entries)
SELECT l.order_id, sum(l.amount_iqd), sum(l.amount_usd_cents), count(*)
  FROM customer_ledger l
 WHERE l.order_id IS NOT NULL
 GROUP BY l.order_id
ON CONFLICT (order_id) DO UPDATE
   SET remaining_iqd = EXCLUDED.remaining_iqd,
       remaining_usd_cents = EXCLUDED.remaining_usd_cents,
       entries = EXCLUDED.entries;

-- The dashboard asks "how many orders are still owed", which is a filter on this table joined
-- to the order's customer; both currencies are indexed because either can be the settlement one.
CREATE INDEX order_remaining_owed_idx ON order_remaining (remaining_iqd, remaining_usd_cents);

ANALYZE order_remaining;
