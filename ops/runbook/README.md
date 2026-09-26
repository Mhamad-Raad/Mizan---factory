# Mizan runbook

Written for whoever is on call, not for whoever wrote the system. Section references are to
`spec/mizan-factory-system-spec-v1.2.md`.

## The shape of it

Four containers on one Linux host (`compose.yml`): **web** (Caddy — TLS, the SPA, and a proxy
for `/api`), **api** (NestJS), **db** (PostgreSQL 15 with a persistent volume and WAL
archiving), **backup** (nightly dump plus continuous WAL upload). The browser sees one origin,
which is what lets the session cookie stay `SameSite=Lax` with no cross-site exception.

## First deployment

1. Point the domain at the host. Caddy obtains the certificate itself on first start.
2. Copy `.env.example` to `.env` and fill every value. `SESSION_PEPPER`,
   `POSTGRES_PASSWORD` and `BACKUP_ENCRYPTION_KEY` must each be freshly generated:
   `openssl rand -base64 32`.
3. Set the CSP hash for the inline pre-paint script:
   `MIZAN_CSP_INLINE_HASH=$(sh ops/docker/csp-hash.sh)`.
4. Build, migrate, then start: `docker compose --profile tools build`, `docker compose run --rm migrate`,
   `docker compose up -d`. The API does not hold the migrate role's credentials — only the
   one-off `migrate` job does — and it refuses to start while a migration is pending, so the
   migrations go first. The first migrate creates the application role `mizan_app` without a
   password; give it the one in `DATABASE_URL` before `up`:
   `docker compose exec db psql -U mizan_migrate -d mizan -c "ALTER ROLE mizan_app PASSWORD '<the DATABASE_URL password>'"`.
   Then take the superuser away from `mizan_migrate` (below, "The migrate role and the
   superuser") — **after** this first migrate, never before it.
5. Seed the first admin: `docker compose exec api node apps/api/dist/database/seed.js`,
   then **sign in once and change the password** — the account is created with
   `must_change_password`, and the value in `.env` should be removed afterwards.
6. Check `https://<domain>/api/v1/health` returns `{"status":"ok"}`.

## Ordinary deployment

Migrations run as a one-off job **before** the new API starts, and the API refuses to start
while a migration is pending — so a half-deployed schema cannot serve requests.

```sh
git pull                                                   # on a release tag
docker compose build api web migrate
docker compose run --rm migrate                            # the only container with the migrate role
docker compose up -d api web
docker compose logs -f api | head -40                      # expect "listening on 3000"
```

Deploys go outside 07:00–19:00 Asia/Baghdad unless it is a hot fix (section 2.14).

The API checks for pending migrations as the application role (`0027_app_reads_migrations`
grants it `SELECT` on `mizan_migrations`, nothing else). If it logs "the application role may
not read mizan_migrations", the migrate job has not run yet: run it, then start the API.

**The migrate role and the superuser (one-time, by hand).** `compose.yml` creates the database
with `POSTGRES_USER=mizan_migrate`, which makes the schema owner a PostgreSQL **superuser** — more
than migrations need. **Order matters**: the first migrate must already have run, because
migration `0002` creates the `mizan_app` role, and creating a role needs `CREATEROLE` (which a
superuser has, and the demoted role below does not). On a new host that is right after step 4
of "First deployment"; on an existing one, at a planned maintenance window:

```sh
docker compose exec db psql -U mizan_migrate -d mizan -c "CREATE ROLE pg_admin LOGIN SUPERUSER PASSWORD '<new, from openssl rand -base64 32>'"
docker compose exec db psql -U pg_admin -d mizan -c "ALTER ROLE mizan_migrate NOSUPERUSER CREATEDB"
```

then keep the `pg_admin` password with the backup key (off the host) and use it only for
restores and emergencies. Migrations, the nightly dump and the restore drill keep working as
`mizan_migrate`, which still owns the schema. A later migration that has to create or alter a
role will fail as `mizan_migrate` with "permission denied to create role": run that one as
`pg_admin`, or grant `CREATEROLE` for the window and revoke it after. This is not automated
because the init scripts of the `postgres` image run only on an empty volume, and the
production volume is not empty.

**Rolling back** is redeploying the previous tag. A migration is never rolled back by
un-applying it: write a new forward migration. The runner refuses to re-apply a file whose
contents changed after it was applied, which is what stops a quiet divergence between
environments.

## Go-live

The day the paper stops. Nothing here is code — it is the order in which a factory starts
trusting a system, and every line has somebody's name against it before the next one begins.

**A week before**

- [ ] Production host built and the domain pointed at it; `/api/v1/health` green from outside.
- [ ] Every secret in `.env` freshly generated on this host — `SESSION_PEPPER`,
      `POSTGRES_PASSWORD`, `BACKUP_ENCRYPTION_KEY` — and the development values never reused.
      The backup key is also written down somewhere that survives the host (an encrypted copy
      is useless with a key that only exists on the machine that was lost).
- [ ] First admin seeded, signed in once, password changed, and the seed value removed from
      `.env`.
- [ ] Nightly backup has run at least twice and the dead-man's switch has fired once on purpose.
- [ ] **Restore drill executed on a production-shaped copy and logged** in `restore-drills.md`
      with the integrity checks (`pnpm check:integrity`), not only "the file opened" (NFR-08).
- [ ] Monitoring wired to the operations channel: uptime, the backup heartbeat, disk at 80 %.
- [ ] Lighthouse and the load test run against staging on the reference profile
      (`docs/LIGHTHOUSE.md`, `scripts/load/mizan-load.js`).

**The day itself, in this order**

1. **The rate.** The global rate set for today (Settings → System), and every supplier's own
   rate confirmed on their profile. Nothing that follows can be typed without them.
2. **Materials and prices.** Every material that will be sold or bought exists, with its
   pricing unit, and has a **bought and sale price for the current month** (FR-306). The Stock
   report is the checklist.
3. **Opening stock.** One entry per material, counted on the floor, with the counter's name in
   the note (FR-308). Large lists go through the CSV import, which writes the same movements.
4. **Opening debts.** Customer balances (FR-504) and company balances (FR-708), each in that
   account's settlement currency, each with a note naming the paper it came from.
5. **Reconcile before anybody sells.** Receivables against the client's own list of customer
   debts; Payables against the supplier debts; the Stock report against the count sheets. The
   three have to agree with the client's figures, and the reconciliation lives in the notes on
   the entries — not in a spreadsheet beside the system.
6. **Employees.** One account each, a preset, the extras agreed with the client, and the
   employee's own first sign-in done in front of somebody who can help.
7. **The devices.** Each shared tablet marked "Shared device" and named; each employee's PIN set
   by the employee on the device they will use; the PIN policy (length, idle lock) agreed.
8. **The period lock** set to the day before go-live if the client keeps one, so nothing can be
   dated into the paper era.
9. **Hand over** the admin guide and the quick cards (`docs/guide/`), and agree the support
   channel and what counts as urgent.

**The first week**

- Read History daily for a week — it is the cheapest way to see a habit forming wrongly.
- Expect corrections, and make them as reversals with notes. A correction in the first week that
  is done properly teaches the habit for the next ten years.
- Keep the first month's Receivables and Payables printouts. They are what a later question
  about an opening figure is answered with.

## Secrets rotation

Rotating `SESSION_PEPPER` invalidates every session and every PIN device ticket — everybody
signs in again with a password. That is the intended cost, and it is the remedy if a session
store is ever suspected. `POSTGRES_PASSWORD` rotates with a `docker compose up -d db api`;
`BACKUP_ENCRYPTION_KEY` must **never** be rotated without keeping the old key for as long as the
copies it encrypted are still in retention, which is thirteen months.

## Backups

Nightly at 03:00 Asia/Baghdad the `backup` container dumps, **verifies the dump is readable**,
encrypts with AES-256, writes an HMAC-SHA256 integrity tag beside it (`<file>.hmac`, its key
stretched from `BACKUP_ENCRYPTION_KEY` with PBKDF2 and distinct from the encryption key), uploads both to `BACKUP_BUCKET`, syncs the WAL, and prunes to 30 daily
and 12 monthly copies. WAL segments are archived continuously with `archive_timeout=900`, which
bounds loss at fifteen minutes (NFR-08: RPO 15 minutes, RTO 4 hours), and leave the host every
five minutes.

The container is built from `ops/docker/Dockerfile.backup` (pg_dump, `openssl`, the `aws`
client) and needs the off-site store's credentials in `.env`: `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, and for Backblaze B2 / Wasabi / any other
S3-compatible store `AWS_ENDPOINT_URL`. **There is no "local only" mode**: if the copy cannot
leave the host — client missing, bucket or credentials wrong, upload refused — the run fails
with a `FAILED:` line naming the cause and sends **no** heartbeat, and the loop logs `ERROR:` on
every WAL sync it cannot do. A missed heartbeat is therefore always a real problem.

Set `BACKUP_HEARTBEAT_URL` to a dead-man's-switch monitor. **Silence is the alert**: a backup
that quietly stopped working is otherwise discovered on the day it is needed.

Check it is working:

```sh
docker compose logs backup | tail -20                      # a "done:" line each night, no "ERROR:"
aws s3 ls "$BACKUP_BUCKET/daily/" | tail -5                # each .dump.enc with its .dump.enc.hmac
docker compose exec backup sh /opt/mizan/backup.sh         # run one now, e.g. after changing credentials
```

## Restore

Rehearsed before go-live and every quarter (I6). Record each rehearsal in
`ops/runbook/restore-drills.md`.

```sh
# 1 — fetch the chosen copy with its integrity tag, check the tag, decrypt
aws s3 cp "$BACKUP_BUCKET/daily/mizan-<stamp>.dump.enc" .
aws s3 cp "$BACKUP_BUCKET/daily/mizan-<stamp>.dump.enc.hmac" .
sh ops/backup/restore-decrypt.sh mizan-<stamp>.dump.enc mizan.dump
#   "REFUSED … does not match" means the copy was damaged or altered (or the key is wrong):
#   take another copy. "REFUSED … not found" means the .hmac was not fetched: fetch it. Only
#   for a copy that truly has no tag (made before tags existed, or the tag is lost) add
#   --allow-untagged before the file names; it is then only as trustworthy as where it came from.
#   The script needs `openssl`; the backup container has it:
#   docker compose run --rm --entrypoint sh -v "$PWD:/restore" -w /restore backup /opt/mizan/restore-decrypt.sh …

# 2 — restore into a fresh database (never over a live one)
createdb -O mizan_migrate mizan_restore
pg_restore -d mizan_restore mizan.dump

# 3 — integrity, before anyone is told it worked
psql -d mizan_restore -c "SELECT count(*) FROM users;"
psql -d mizan_restore -c "SELECT count(*) FROM audit_log;"
psql -d mizan_restore -c "SELECT max(occurred_at) FROM audit_log;"   # how fresh is it?
psql -d mizan_restore -c "SELECT count(*) FROM mizan_migrations;"    # schema version
# From I1 onwards also check the ledger invariants: every balance is a sum over its ledger.

# 4 — point a staging API at it and sign in before declaring success
```

To recover **to a point in time**, restore the dump and replay WAL from `$BACKUP_BUCKET/wal/`
with a `recovery_target_time`. That is the path that costs fifteen minutes rather than a day.

## Monitoring

| What | How | Who is told |
|---|---|---|
| Uptime | external check on `/api/v1/health` every minute from outside the host | on-call, after 2 failures |
| Backups | dead-man's switch on `BACKUP_HEARTBEAT_URL` | on-call, after a missed night |
| Disk | host alert at 80 % — WAL archiving fills a disk quietly | on-call |
| Errors | `docker compose logs api`; one JSON object per line with `request_id` | weekly 5xx summary |
| Slow queries | PostgreSQL `log_min_duration_statement=500` | weekly review |

A user reporting a problem can read a **reference** off the error screen. That is the
`request_id`: it appears in the API log line and on every audit row the request wrote, so the
whole story of one action can be reconstructed from it.

## Incidents

1. **Take the timestamp** and the `request_id` if the user has one.
2. `docker compose ps` and `/api/v1/health` — is it the API or the database?
3. `docker compose logs api --since 30m | grep '"level":"error"'`.
4. Nothing in Mizan is fixed by editing the database. Balances and stock are sums over
   append-only ledgers; a wrong figure is corrected by a **reversal entry through the
   application**, which keeps History honest. An `UPDATE` on `audit_log` or a ledger will be
   refused anyway — the application's database role has no such privilege, and that is
   deliberate.
5. Write the incident up here with what was seen, what was done, and what would have caught it.
