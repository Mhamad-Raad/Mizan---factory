-- The application role may issue a ticket, read it, and mark it used or revoked — and may never
-- delete one (spec 2.13). Deletion is the sweep's business and the sweep runs as the owner, so
-- the same guarantee the ledgers have holds here: nothing disappears from the record because of
-- something the API did.
--
-- `sessions` already carries this shape from 0002; `device_tickets` joins it.
GRANT SELECT, INSERT, UPDATE ON device_tickets TO mizan_app;
REVOKE DELETE ON device_tickets FROM mizan_app;
