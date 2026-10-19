-- The business on its receipts (D-108): the name, phone and address are settings; the logo is
-- kept here, in the database, so a backup or a restore carries it with everything else and the
-- server needs no folder of uploads. One row at most — a business has one logo.

CREATE TABLE business_logo (
  id          boolean PRIMARY KEY DEFAULT true,
  media_type  text NOT NULL,
  data        bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NOT NULL REFERENCES users (id),
  CONSTRAINT business_logo_one_row CHECK (id),
  CONSTRAINT business_logo_type CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- The browser makes the picture receipt-sized before sending it; this is the backstop.
  CONSTRAINT business_logo_size CHECK (octet_length(data) BETWEEN 1 AND 262144)
);

-- Replacing and removing the logo are ordinary edits, recorded in History; it is not a ledger.
GRANT SELECT, INSERT, UPDATE, DELETE ON business_logo TO mizan_app;
