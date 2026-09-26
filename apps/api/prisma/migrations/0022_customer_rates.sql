-- ─────────────────────── customer_rates (append-only) ───────────────────────
--
-- A customer keeps its **own** IQD-per-USD rate, the same way a company does (0008): every
-- calculated amount on that customer's orders is filled at this rate, not the global one, and
-- a rate change never touches a stored entry — it is a new row, valued from now on.
--
-- Current rate = the latest row with `effective_from ≤ now()`; a customer with no row falls
-- back to the global rate, and the interface says which one is in force.

CREATE TABLE customer_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customers (id),
  rate_iqd_per_usd numeric(14,4) NOT NULL,
  effective_from   timestamptz NOT NULL DEFAULT now(),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES users (id),
  CONSTRAINT customer_rates_positive CHECK (rate_iqd_per_usd > 0)
);

CREATE INDEX customer_rates_lookup_idx ON customer_rates (customer_id, effective_from DESC);

-- Rule 2: the rate history is append-only — INSERT + SELECT, never UPDATE or DELETE.
GRANT SELECT, INSERT ON customer_rates TO mizan_app;
REVOKE UPDATE, DELETE ON customer_rates FROM mizan_app;
