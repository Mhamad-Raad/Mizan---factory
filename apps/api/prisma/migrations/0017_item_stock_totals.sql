-- Iteration 6 review — the second (and last) maintained sum of specification 2.2.6.
--
-- `item_stock` was a view that summed the **whole** stock ledger and grouped it by material,
-- every time anybody asked it anything. That was invisible while the ledger was small; with a
-- year of movements at the design point of NFR-13 (1,347,043 rows) the review measured:
--
--   * `GET /reports/stock`     674 ms — of which 290 ms was aggregating 5,014 materials to
--                                       send the 200 the report shows;
--   * the dashboard's low-stock tile — one sequential pass over the whole ledger per load;
--   * `stockOf()` on every order and purchase line, inside the write transaction, where the
--     negative-stock rule is checked (FR-307).
--
-- It is the same figure and the same remedy as `order_remaining` (2.2.6, D-040): a sum kept up
-- to date by a trigger on an **append-only** ledger, not a materialised copy to refresh and not
-- an editable column. There is no UPDATE and no DELETE on `stock_ledger` to keep in step; a
-- correction is another movement and a reversal is its own negative row, so the maintained
-- figure cannot drift unless somebody drops the trigger. `scripts/check-integrity.mjs` compares
-- it against the ledger on every restore drill.
--
-- The view keeps its name and its columns, so nothing above the database changes: the report,
-- the dashboard tile and the stock service all read the same `item_stock` they always did.

CREATE TABLE item_stock_totals (
  item_id uuid PRIMARY KEY REFERENCES items (id),
  stock_count bigint NOT NULL DEFAULT 0,
  stock_kg numeric(14, 3) NOT NULL DEFAULT 0,
  -- Movements counted, and how many of them left a measure empty. A stock ledger row carries
  -- only the measures the material is actually counted in (2.2.4), so "6,000 kg" and "no
  -- weight was ever recorded" have to stay distinguishable — which is what the view's
  -- `count_complete` / `kg_complete` flags say, and these three counters are how it says it.
  movements bigint NOT NULL DEFAULT 0,
  count_missing bigint NOT NULL DEFAULT 0,
  kg_missing bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE item_stock_totals IS
  'A maintained sum over stock_ledger per material (spec 2.2.6, D-045). Written only by the trigger below; the application role has no privileges on it. Verified against the ledger by scripts/check-integrity.mjs.';

CREATE OR REPLACE FUNCTION mizan_item_stock_apply()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO item_stock_totals
    (item_id, stock_count, stock_kg, movements, count_missing, kg_missing, updated_at)
  VALUES (
    NEW.item_id,
    coalesce(NEW.qty_count, 0),
    coalesce(NEW.qty_kg, 0),
    1,
    CASE WHEN NEW.qty_count IS NULL THEN 1 ELSE 0 END,
    CASE WHEN NEW.qty_kg IS NULL THEN 1 ELSE 0 END,
    now()
  )
  ON CONFLICT (item_id) DO UPDATE
     SET stock_count = item_stock_totals.stock_count + EXCLUDED.stock_count,
         stock_kg = item_stock_totals.stock_kg + EXCLUDED.stock_kg,
         movements = item_stock_totals.movements + 1,
         count_missing = item_stock_totals.count_missing + EXCLUDED.count_missing,
         kg_missing = item_stock_totals.kg_missing + EXCLUDED.kg_missing,
         updated_at = now();

  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_ledger_item_totals
AFTER INSERT ON stock_ledger
FOR EACH ROW EXECUTE FUNCTION mizan_item_stock_apply();

-- ── the backfill ─────────────────────────────────────────────────────────────────────

INSERT INTO item_stock_totals
  (item_id, stock_count, stock_kg, movements, count_missing, kg_missing)
SELECT s.item_id,
       coalesce(sum(s.qty_count), 0),
       coalesce(sum(s.qty_kg), 0),
       count(*),
       count(*) FILTER (WHERE s.qty_count IS NULL),
       count(*) FILTER (WHERE s.qty_kg IS NULL)
  FROM stock_ledger s
 GROUP BY s.item_id
ON CONFLICT (item_id) DO UPDATE
   SET stock_count = EXCLUDED.stock_count,
       stock_kg = EXCLUDED.stock_kg,
       movements = EXCLUDED.movements,
       count_missing = EXCLUDED.count_missing,
       kg_missing = EXCLUDED.kg_missing;

-- ── the view, unchanged above the database ───────────────────────────────────────────
--
-- Still one row per material, including a material nothing has ever moved (which is a stock of
-- zero, and complete in both measures because there is nothing incomplete about it).

CREATE OR REPLACE VIEW item_stock AS
SELECT i.id AS item_id,
       i.pricing_unit,
       coalesce(t.stock_count, 0)::bigint AS stock_count,
       coalesce(t.stock_kg, 0)::numeric(14, 3) AS stock_kg,
       coalesce(t.movements, 0) = 0 OR coalesce(t.count_missing, 0) = 0 AS count_complete,
       coalesce(t.movements, 0) = 0 OR coalesce(t.kg_missing, 0) = 0 AS kg_complete
  FROM items i
  LEFT JOIN item_stock_totals t ON t.item_id = i.id;

-- The dashboard's low-stock tile compares each material's stock with its own minimum, so it
-- reads every row of this table — 5,000 of them, instead of a million movements.
CREATE INDEX item_stock_totals_levels_idx ON item_stock_totals (stock_count, stock_kg);

ANALYZE item_stock_totals;
