# Restore drills

One row per rehearsal (NFR-08: before go-live, then quarterly). A drill that was not written
down did not happen.

| Date | Backup used | Restored by | Time taken | Integrity checks | Notes |
|---|---|---|---|---|---|
| 2026-09-19 | local dump of the I0 schema | implementation agent | < 1 min | 8 tables, users, audit rows and `mizan_migrations` all present after decrypt + `pg_restore` | Script rehearsal during I0, on a development database. **Not the go-live drill** — that is I6, on a production-shaped copy with the ledger invariants checked. |
| 2026-09-22 | `pg_dump --format=custom --compress=9` of a production-shaped database: 4,252 MB, 1,159,001 orders, 1,227,001 order lines, 426,010 purchases, 4,033,092 audit rows, 30,020 customers, 5,007 materials — the design point of NFR-13 and beyond | implementation agent | **dump 40 s → 497 MB · restore 47 s (`--jobs 4`) · checks 30 s** | `scripts/check-integrity.mjs`: 20 tables, migrations, an active admin, the append-only grants on all four ledgers, **every customer, company, stock and per-order figure equal to its ledger**, every ledger row carrying its rate, no half-empty currency pair, both document sequences past their data, 4,033,092 audit rows with no orphaned actor | **The go-live drill of NFR-08.** Restored into an empty `mizan_restored` and checked there, not in place. What it proves beyond "the file opens": the maintained per-order remaining of migration 0015 survived the round trip and still equals the ledger, and the sequences did not reset — the two things a restore gets silently wrong. Re-run quarterly; the script exits non-zero on the first broken invariant, so a drill cannot be logged as passed when it was not. |
