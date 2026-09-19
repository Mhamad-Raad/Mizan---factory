# Restore drills

One row per rehearsal (NFR-08: before go-live, then quarterly). A drill that was not written
down did not happen.

| Date | Backup used | Restored by | Time taken | Integrity checks | Notes |
|---|---|---|---|---|---|
| 2026-09-19 | local dump of the I0 schema | implementation agent | < 1 min | 8 tables, users, audit rows and `mizan_migrations` all present after decrypt + `pg_restore` | Script rehearsal during I0, on a development database. **Not the go-live drill** — that is I6, on a production-shaped copy with the ledger invariants checked. |
