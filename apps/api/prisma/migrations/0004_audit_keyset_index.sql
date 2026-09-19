-- History is the most-read table in the system and the only one that grows without bound
-- (the design point is two million rows over five years, NFR-13, and it is append-only).
--
-- The page query orders by "newest first" and pages with a cursor. Ordering by `id` alone
-- forced the planner to walk the primary key backwards and *filter* by date, which costs more
-- the further back the range starts. A composite index in exactly the order the query asks
-- for lets the date bound become an index condition and the cursor a range start, so page
-- 10,000 of a filtered range costs what page 1 costs.

CREATE INDEX audit_log_occurred_id_idx ON audit_log (occurred_at DESC, id DESC);
CREATE INDEX audit_log_actor_occurred_id_idx ON audit_log (actor_user_id, occurred_at DESC, id DESC);

-- Superseded by the composite indexes above.
DROP INDEX IF EXISTS audit_log_occurred_idx;
DROP INDEX IF EXISTS audit_log_actor_idx;
