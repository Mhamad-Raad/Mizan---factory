-- A sale never takes more than is in stock (D-107, business request 2026-10-18).
--
-- `allow_negative_stock` defaulted to true (A-34): overselling saved with a warning on the line. The
-- default is now false, and a value stored earlier is removed so every installation follows it. The
-- setting was never on a screen, so nobody chose the old value on purpose.

DELETE FROM settings WHERE key = 'allow_negative_stock';
