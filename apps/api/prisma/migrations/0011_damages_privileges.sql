-- Rule 2 for the table Iteration 3 adds (spec 2.13), as migrations 0007 and 0009 did before
-- it: `damages` is mutable — a record is edited and voided, never deleted — and the view is
-- readable. The stock and money rows a damage produces live in the append-only ledgers, whose
-- grants are already in place.

GRANT SELECT, INSERT, UPDATE ON damages TO mizan_app;
REVOKE DELETE ON damages FROM mizan_app;

GRANT SELECT ON damage_totals TO mizan_app;

GRANT USAGE, SELECT ON SEQUENCE damage_number_seq TO mizan_app;
