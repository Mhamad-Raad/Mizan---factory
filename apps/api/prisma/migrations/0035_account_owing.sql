-- Performance review at ten years of data (D-075) — what each account still owes on its orders,
-- maintained.
--
-- "How many orders are still owed, and how much" is asked by the dashboard's first tile and by
-- the Orders list's figures on every load of "All". It is a question about every order that owes
-- anything, and at ten years that was 1.2 million of 1.8 million orders: joining each to its
-- remaining figure (`order_remaining`, 0015) and to its account's settlement currency cost
-- 430–480 ms per request, and no index makes "all of them" shorter.
--
-- So it is summed per account and kept by triggers, like every maintained figure here (2.2.6):
-- nothing but the triggers writes it, the application may only read it, and
-- `scripts/check-integrity.mjs` recomputes it from the orders and `order_remaining` on every
-- restore drill.
--
-- Two sets per account, because which orders owe depends on the account's settlement currency
-- and that can change (D-054): the orders that owe in dinars (remaining_iqd > 0) and the orders
-- that owe in dollars (remaining_usd_cents > 0), each with its count, what is left on them in both
-- currencies and what they came to in both — and the same again for the ones still owed in full
-- ("unpaid" in 2.4.3: what is left is at least the total), so "unpaid", "partly paid" (owing less
-- unpaid) and "paid" (every active order less owing) are all answered without reading the orders.
-- A reader takes the set of the account's currency *today* — exactly the question the
-- ledger-derived status asks — so a change of currency needs nothing from this table. Only active
-- orders count, as the status of 2.4.3 says.

CREATE TABLE account_owing (
  account_id uuid PRIMARY KEY REFERENCES customers (id),
  -- The orders with dinars still owed on them, and of those the ones nothing has been paid on.
  iqd_orders integer NOT NULL DEFAULT 0,
  iqd_remaining_iqd bigint NOT NULL DEFAULT 0,
  iqd_remaining_usd_cents bigint NOT NULL DEFAULT 0,
  iqd_total_iqd bigint NOT NULL DEFAULT 0,
  iqd_total_usd_cents bigint NOT NULL DEFAULT 0,
  iqd_unpaid_orders integer NOT NULL DEFAULT 0,
  iqd_unpaid_remaining_iqd bigint NOT NULL DEFAULT 0,
  iqd_unpaid_remaining_usd_cents bigint NOT NULL DEFAULT 0,
  iqd_unpaid_total_iqd bigint NOT NULL DEFAULT 0,
  iqd_unpaid_total_usd_cents bigint NOT NULL DEFAULT 0,
  -- The orders with dollars still owed on them, and of those the ones nothing has been paid on.
  usd_orders integer NOT NULL DEFAULT 0,
  usd_remaining_iqd bigint NOT NULL DEFAULT 0,
  usd_remaining_usd_cents bigint NOT NULL DEFAULT 0,
  usd_total_iqd bigint NOT NULL DEFAULT 0,
  usd_total_usd_cents bigint NOT NULL DEFAULT 0,
  usd_unpaid_orders integer NOT NULL DEFAULT 0,
  usd_unpaid_remaining_iqd bigint NOT NULL DEFAULT 0,
  usd_unpaid_remaining_usd_cents bigint NOT NULL DEFAULT 0,
  usd_unpaid_total_iqd bigint NOT NULL DEFAULT 0,
  usd_unpaid_total_usd_cents bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 70);

COMMENT ON TABLE account_owing IS
  'What each account still owes on its active orders, summed per settlement currency from order_remaining (spec 2.2.6, D-075). Written only by the triggers below; the application role may only read it. Verified by scripts/check-integrity.mjs.';

-- One order's share, added (sign 1) or taken away (sign -1).
CREATE FUNCTION mizan_account_owing_add(
  account uuid, sign integer, active boolean,
  total_iqd bigint, total_usd_cents bigint, remaining_iqd bigint, remaining_usd_cents bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Still owed in that currency; and owed in full — the "unpaid" of 2.4.3.
  in_iqd integer := CASE WHEN active AND remaining_iqd > 0 THEN sign ELSE 0 END;
  in_iqd_unpaid integer := CASE WHEN active AND remaining_iqd > 0 AND remaining_iqd >= total_iqd THEN sign ELSE 0 END;
  in_usd integer := CASE WHEN active AND remaining_usd_cents > 0 THEN sign ELSE 0 END;
  in_usd_unpaid integer := CASE WHEN active AND remaining_usd_cents > 0 AND remaining_usd_cents >= total_usd_cents
                                THEN sign ELSE 0 END;
BEGIN
  IF account IS NULL OR (in_iqd = 0 AND in_usd = 0) THEN
    RETURN;
  END IF;
  INSERT INTO account_owing AS a
    (account_id,
     iqd_orders, iqd_remaining_iqd, iqd_remaining_usd_cents,
     iqd_total_iqd, iqd_total_usd_cents, iqd_unpaid_orders,
     iqd_unpaid_remaining_iqd, iqd_unpaid_remaining_usd_cents, iqd_unpaid_total_iqd,
     iqd_unpaid_total_usd_cents, usd_orders, usd_remaining_iqd,
     usd_remaining_usd_cents, usd_total_iqd, usd_total_usd_cents,
     usd_unpaid_orders, usd_unpaid_remaining_iqd, usd_unpaid_remaining_usd_cents,
     usd_unpaid_total_iqd, usd_unpaid_total_usd_cents)
  VALUES (account,
          in_iqd, in_iqd * remaining_iqd, in_iqd * remaining_usd_cents,
          in_iqd * total_iqd, in_iqd * total_usd_cents, in_iqd_unpaid,
          in_iqd_unpaid * remaining_iqd, in_iqd_unpaid * remaining_usd_cents, in_iqd_unpaid * total_iqd,
          in_iqd_unpaid * total_usd_cents, in_usd, in_usd * remaining_iqd,
          in_usd * remaining_usd_cents, in_usd * total_iqd, in_usd * total_usd_cents,
          in_usd_unpaid, in_usd_unpaid * remaining_iqd, in_usd_unpaid * remaining_usd_cents,
          in_usd_unpaid * total_iqd, in_usd_unpaid * total_usd_cents)
  ON CONFLICT (account_id) DO UPDATE
     SET iqd_orders = a.iqd_orders + EXCLUDED.iqd_orders,
         iqd_remaining_iqd = a.iqd_remaining_iqd + EXCLUDED.iqd_remaining_iqd,
         iqd_remaining_usd_cents = a.iqd_remaining_usd_cents + EXCLUDED.iqd_remaining_usd_cents,
         iqd_total_iqd = a.iqd_total_iqd + EXCLUDED.iqd_total_iqd,
         iqd_total_usd_cents = a.iqd_total_usd_cents + EXCLUDED.iqd_total_usd_cents,
         iqd_unpaid_orders = a.iqd_unpaid_orders + EXCLUDED.iqd_unpaid_orders,
         iqd_unpaid_remaining_iqd = a.iqd_unpaid_remaining_iqd + EXCLUDED.iqd_unpaid_remaining_iqd,
         iqd_unpaid_remaining_usd_cents = a.iqd_unpaid_remaining_usd_cents + EXCLUDED.iqd_unpaid_remaining_usd_cents,
         iqd_unpaid_total_iqd = a.iqd_unpaid_total_iqd + EXCLUDED.iqd_unpaid_total_iqd,
         iqd_unpaid_total_usd_cents = a.iqd_unpaid_total_usd_cents + EXCLUDED.iqd_unpaid_total_usd_cents,
         usd_orders = a.usd_orders + EXCLUDED.usd_orders,
         usd_remaining_iqd = a.usd_remaining_iqd + EXCLUDED.usd_remaining_iqd,
         usd_remaining_usd_cents = a.usd_remaining_usd_cents + EXCLUDED.usd_remaining_usd_cents,
         usd_total_iqd = a.usd_total_iqd + EXCLUDED.usd_total_iqd,
         usd_total_usd_cents = a.usd_total_usd_cents + EXCLUDED.usd_total_usd_cents,
         usd_unpaid_orders = a.usd_unpaid_orders + EXCLUDED.usd_unpaid_orders,
         usd_unpaid_remaining_iqd = a.usd_unpaid_remaining_iqd + EXCLUDED.usd_unpaid_remaining_iqd,
         usd_unpaid_remaining_usd_cents = a.usd_unpaid_remaining_usd_cents + EXCLUDED.usd_unpaid_remaining_usd_cents,
         usd_unpaid_total_iqd = a.usd_unpaid_total_iqd + EXCLUDED.usd_unpaid_total_iqd,
         usd_unpaid_total_usd_cents = a.usd_unpaid_total_usd_cents + EXCLUDED.usd_unpaid_total_usd_cents,
         updated_at = now();
END;
$$;

-- What is left on an order moved (a ledger row naming it, through 0015's trigger): its share
-- before, taken away; its share now, added — with the order as it stands.
CREATE FUNCTION mizan_account_owing_remaining()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o record;
BEGIN
  SELECT customer_id, status = 'active' AND deleted_at IS NULL AS active, total_iqd, total_usd_cents
    INTO o
    FROM orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM mizan_account_owing_add(o.customer_id, -1, o.active, o.total_iqd, o.total_usd_cents,
                                    OLD.remaining_iqd, OLD.remaining_usd_cents);
  END IF;
  PERFORM mizan_account_owing_add(o.customer_id, 1, o.active, o.total_iqd, o.total_usd_cents,
                                  NEW.remaining_iqd, NEW.remaining_usd_cents);
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_remaining_account_owing
AFTER INSERT OR UPDATE OF remaining_iqd, remaining_usd_cents ON order_remaining
FOR EACH ROW EXECUTE FUNCTION mizan_account_owing_remaining();

-- The order itself changed — voided, its account or its total changed by an edit: its share as
-- it was, taken away; as it is, added — with what is left on it now.
CREATE FUNCTION mizan_account_owing_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  SELECT remaining_iqd, remaining_usd_cents INTO r FROM order_remaining WHERE order_id = NEW.id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  PERFORM mizan_account_owing_add(OLD.customer_id, -1, OLD.status = 'active' AND OLD.deleted_at IS NULL,
                                  OLD.total_iqd, OLD.total_usd_cents, r.remaining_iqd, r.remaining_usd_cents);
  PERFORM mizan_account_owing_add(NEW.customer_id, 1, NEW.status = 'active' AND NEW.deleted_at IS NULL,
                                  NEW.total_iqd, NEW.total_usd_cents, r.remaining_iqd, r.remaining_usd_cents);
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_account_owing
AFTER UPDATE OF status, deleted_at, customer_id, total_iqd, total_usd_cents ON orders
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status
      OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
      OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
      OR OLD.total_iqd IS DISTINCT FROM NEW.total_iqd
      OR OLD.total_usd_cents IS DISTINCT FROM NEW.total_usd_cents)
EXECUTE FUNCTION mizan_account_owing_order();

-- ── the backfill ──

INSERT INTO account_owing
  (account_id,
   iqd_orders, iqd_remaining_iqd, iqd_remaining_usd_cents,
   iqd_total_iqd, iqd_total_usd_cents, iqd_unpaid_orders,
   iqd_unpaid_remaining_iqd, iqd_unpaid_remaining_usd_cents, iqd_unpaid_total_iqd,
   iqd_unpaid_total_usd_cents, usd_orders, usd_remaining_iqd,
   usd_remaining_usd_cents, usd_total_iqd, usd_total_usd_cents,
   usd_unpaid_orders, usd_unpaid_remaining_iqd, usd_unpaid_remaining_usd_cents,
   usd_unpaid_total_iqd, usd_unpaid_total_usd_cents)
SELECT o.customer_id,
       count(*) FILTER (WHERE r.remaining_iqd > 0),
       coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_iqd > 0), 0),
       coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_iqd > 0), 0),
       coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_iqd > 0), 0),
       coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_iqd > 0), 0),
       count(*) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd),
       coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0),
       coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0),
       coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0),
       coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0),
       count(*) FILTER (WHERE r.remaining_usd_cents > 0),
       coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_usd_cents > 0), 0),
       coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0), 0),
       coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_usd_cents > 0), 0),
       coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0), 0),
       count(*) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents),
       coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0),
       coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0),
       coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0),
       coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0)
  FROM order_remaining r
  JOIN orders o ON o.id = r.order_id
 WHERE o.status = 'active' AND o.deleted_at IS NULL
   AND (r.remaining_iqd > 0 OR r.remaining_usd_cents > 0)
 GROUP BY o.customer_id;

GRANT SELECT ON account_owing TO mizan_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON account_owing FROM mizan_app;
REVOKE ALL ON FUNCTION mizan_account_owing_add(uuid, integer, boolean, bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION mizan_account_owing_remaining() FROM PUBLIC;
REVOKE ALL ON FUNCTION mizan_account_owing_order() FROM PUBLIC;

ANALYZE account_owing;
