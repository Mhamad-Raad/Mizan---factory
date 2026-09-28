# Mizan runbook

Written for whoever is on call, not for whoever wrote the system. Section references are to
`spec/mizan-factory-system-spec-v1.2.md`.

## The shape of it

Four containers on one Linux host (`compose.yml`): **web** (Caddy — TLS, the SPA, and a proxy
for `/api`), **api** (NestJS), **db** (PostgreSQL 15 with a persistent volume and WAL
archiving), **backup** (nightly dump, weekly base backup, WAL off the host every five minutes). The browser sees one origin,
which is what lets the session cookie stay `SameSite=Lax` with no cross-site exception.

## First deployment

The complete, tested procedure is **[DEPLOY.md](../../DEPLOY.md)** at the top of the repository
(tested on a fresh clone in Docker on 2026-09-28). The notes below explain the why of its steps.

- The API never holds the migrate role's credentials — only the one-off `migrate` job does —
  and it refuses to start while a migration is pending, so migrations always go first.
- The first migrate creates the application role `mizan_app` without a password; DEPLOY.md
  gives it the one in `DATABASE_URL` before the API starts.
- The database volume's first start runs `ops/docker/db-init/10-backup-role.sh`, which creates
  the backup job's read-only `mizan_backup` role — so `.env` must be complete before the first
  `docker compose up`.
- The superuser is taken away from `mizan_migrate` **after** the first migrate, never before
  (below). A role named `pg_…` cannot be created — PostgreSQL reserves the prefix — hence
  `db_admin`.
- The web image computes the Content-Security-Policy hashes of its inline scripts at build time
  and keeps fonts as files, so the CSP needs nothing by hand.

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

The API checks for pending migrations as the application role (`0028_app_reads_migrations`
grants it `SELECT` on `mizan_migrations`, nothing else). If it logs "the application role may
not read mizan_migrations", the migrate job has not run yet: run it, then start the API.

**The migrate role and the superuser (one-time, by hand).** `compose.yml` creates the database
with `POSTGRES_USER=mizan_migrate`, which makes the schema owner a PostgreSQL **superuser** — more
than migrations need. **Order matters**: the first migrate must already have run, because
migration `0002` creates the `mizan_app` role, and creating a role needs `CREATEROLE` (which a
superuser has, and the demoted role below does not). On a new host that is right after step 4
of "First deployment"; on an existing one, at a planned maintenance window:

```sh
docker compose exec db psql -U mizan_migrate -d mizan -c "CREATE ROLE db_admin LOGIN SUPERUSER PASSWORD '<new, from openssl rand -base64 32>'"
docker compose exec db psql -U db_admin -d mizan -c "ALTER ROLE mizan_migrate NOSUPERUSER CREATEDB"
```

then keep the `db_admin` password with the backup key (off the host) and use it only for
restores and emergencies. Migrations, the nightly dump and the restore drill keep working as
`mizan_migrate`, which still owns the schema. A later migration that has to create or alter a
role will fail as `mizan_migrate` with "permission denied to create role": run that one as
`db_admin`, or grant `CREATEROLE` for the window and revoke it after. This is not automated
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
store is ever suspected. `POSTGRES_PASSWORD` rotates with a `docker compose up -d db api`; `BACKUP_DB_PASSWORD` with
`ALTER ROLE mizan_backup PASSWORD '…'` (as `db_admin`) and then `docker compose up -d backup`;
`BACKUP_ENCRYPTION_KEY` must **never** be rotated without keeping the old key for as long as the
copies it encrypted are still in retention, which is thirteen months.

## Backups

Three things leave the host, every one of them compressed, encrypted with AES-256 and carrying an
HMAC-SHA256 integrity tag beside it (`<file>.hmac`, its key stretched from
`BACKUP_ENCRYPTION_KEY` with PBKDF2 and distinct from the encryption key). Nothing leaves in clear.

| What | When | Where in `BACKUP_BUCKET` | What it restores |
|---|---|---|---|
| `pg_dump` of the database, checked with `pg_restore --list` | nightly, once a day at or after 03:00 Asia/Baghdad | `daily/`, and the first good night of each month also `monthly/` | the database as it was that night — the simple path |
| physical base backup (`pg_basebackup`, tar) | weekly, in the nightly run, when 7 days have passed since the last one that succeeded | `base/<stamp>_<first WAL segment>/` | the starting point of a point-in-time recovery |
| every WAL segment, one file each | closed at least every 10 minutes (`archive_timeout=600`), sent within 5 | `wal/<segment>.gz.enc` | replayed onto a base backup: any moment up to 15 minutes ago (NFR-08) |

**The schedule.** The `backup` container (`ops/backup/cron.sh`) wakes every five minutes. The
night is due from 03:00 until it succeeds; the day it last succeeded is kept on the
`backup-staging` volume (`state/last-nightly`), so a container that was down at 03:00 runs as
soon as it is back and one restarted after a good night does not run again. A failed night is
retried after 15 minutes, 30, 60, then every two hours; each failure is an `ERROR:` line and no
heartbeat is sent until a run succeeds. Between nights the loop sends new WAL off the host.

**The local WAL archive is pruned** (`wal-sync.sh`): a segment is deleted from the
`wal-archive` volume once it has been uploaded **and** is older than the newest base backup's
first segment. The newest base backup (encrypted) also stays in `backup-staging/base/`. So the
disk holds at most about a week of WAL; if uploads stop, WAL is kept, the heartbeat stops, and
the disk alert (80 %) is the second warning.

**The backup role.** The container connects as `mizan_backup` — `LOGIN REPLICATION`, member of
`pg_read_all_data` — which can read every table and take a base backup and **cannot write
anything**; it never holds the schema owner's password. `ops/docker/db-init/10-backup-role.sh`
creates it, with `BACKUP_DB_PASSWORD`, and its `pg_hba.conf` line for replication, when the
database volume is first initialised. On a database initialised before that script existed, do
the same by hand once (it needs a superuser: `mizan_migrate` before it is demoted, or `db_admin`):

```sh
docker compose exec db psql -U db_admin -d mizan -c "CREATE ROLE mizan_backup LOGIN REPLICATION PASSWORD '<BACKUP_DB_PASSWORD>'" -c "GRANT pg_read_all_data TO mizan_backup"
docker compose exec db sh -c 'printf "\nhost replication mizan_backup all scram-sha-256\n" >> "$PGDATA/pg_hba.conf"'
docker compose exec db psql -U db_admin -d mizan -c "SELECT pg_reload_conf()"
docker compose up -d backup                                # now connects as mizan_backup
```

The container is built from `ops/docker/Dockerfile.backup` (the PostgreSQL 15 client tools,
`openssl`, the `aws` client) and needs the off-site store's credentials in `.env`:
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, and for Backblaze B2 /
Wasabi / any other S3-compatible store `AWS_ENDPOINT_URL`. **There is no "local only" mode**: if
the copy cannot leave the host — client missing, bucket or credentials wrong, upload refused —
the run fails with a `FAILED:` line naming the cause and sends **no** heartbeat, and the loop logs
`ERROR:` on every WAL sync it cannot do. A missed heartbeat is therefore always a real problem.

Set `BACKUP_HEARTBEAT_URL` to a dead-man's-switch monitor that expects one ping a day. **Silence
is the alert**: a backup that quietly stopped working is otherwise discovered on the day it is
needed. When it is empty the container prints a boxed `WARNING` at every start and every night.

Check it is working:

```sh
docker compose logs backup | grep -v WARNING | tail -20    # a "[backup] … done:" line each night, no "ERROR:"/"FAILED:"
docker compose exec backup cat /var/backups/mizan/state/last-nightly /var/backups/mizan/state/last-base
docker compose exec db psql -U mizan_migrate -d mizan -c "SELECT archived_count, last_archived_wal, failed_count, last_failed_wal FROM pg_stat_archiver"
aws s3 ls "$BACKUP_BUCKET/daily/" | tail -4                # read with the restore key, not the host's
docker compose exec backup sh /opt/mizan/backup.sh         # run one now (e.g. after changing credentials)
docker compose exec backup sh /opt/mizan/basebackup.sh     # take a base backup now (e.g. after a restore)
```

`last_failed_wal` in `pg_stat_archiver` must not be growing: a failing `archive_command` keeps
every WAL segment in `pg_wal` until the disk is full and PostgreSQL stops.

### Off-site retention

Retention belongs to the **bucket**, not the host, so a thief with the host's key cannot delete
the copies it made (security review). Set up once, when the bucket is created:

1. **A put-only key for the host.** Its policy allows `s3:PutObject` on `<bucket>/*` and nothing
   else — no list, no read, no delete. The scripts need nothing more: they remember what they
   uploaded instead of listing. (B2: an application key with only `writeFiles` on the bucket.)
   A second key, with read and list, is kept **off the host** with the backup passphrase and
   used only for restores and drills.
2. **Versioning and Object Lock** on the bucket, default retention **30 days** (compliance mode
   where the store supports it). An overwrite then keeps the old version, and nothing can
   remove a copy younger than 30 days — not even a full-rights key.
3. **Lifecycle rules**, per prefix, expiring current versions and removing non-current ones
   a day later:

   | Prefix | Expire after | Why |
   |---|---|---|
   | `daily/` | 31 days | 30 nightly copies |
   | `monthly/` | 400 days | 12 monthly copies and a margin; the key must be kept as long |
   | `base/` | 22 days | the last three weekly base backups |
   | `wal/` | 22 days | every segment after the oldest kept base backup — the same age, never less |

   With AWS S3 (and stores that follow its API): `aws s3api put-bucket-versioning`,
   `put-object-lock-configuration` (Object Lock is enabled when the bucket is created) and
   `put-bucket-lifecycle-configuration` with one rule per prefix. With B2: "Object Lock" and
   "Lifecycle settings" on the bucket page, one rule per prefix.

Stores without lifecycle rules: set `BACKUP_PRUNE_OFFSITE=1` and give the host a key that may
list and delete; `backup.sh` then prunes to 30 daily, 12 monthly and 3 base backups
(`BASE_BACKUP_KEEP`) and deletes WAL older than the oldest kept base backup. That key can also
delete everything, which is why it is not the default.

## Restore

Rehearsed before go-live and every quarter (I6). Record each rehearsal in
`ops/runbook/restore-drills.md`. Never restore over the live database: always into a new
directory or database, check it, then switch.

The commands below use the read key (not the host's put-only key) and the backup image, which
has `openssl`, the `aws` client and PostgreSQL 15. Start a restore shell on the host:

```sh
mkdir -p /srv/jiyan-restore
docker compose run --rm --no-deps -v /srv/jiyan-restore:/restore \
  -e AWS_ACCESS_KEY_ID=<read key> -e AWS_SECRET_ACCESS_KEY=<read secret> \
  --entrypoint sh backup
# the shell has BACKUP_BUCKET and BACKUP_ENCRYPTION_KEY from .env; on another machine, export them.
# It also has PGHOST=db (the LIVE database) and the mizan_backup role: every psql below names its
# server and role explicitly.
```

### A — last night's dump (the simple path; loses up to a day)

```sh
cd /restore
# 1 — fetch the chosen copy with its integrity tag, check the tag, decrypt
aws s3 ls "$BACKUP_BUCKET/daily/" | tail -4
aws s3 cp "$BACKUP_BUCKET/daily/mizan-<stamp>.dump.enc" .
aws s3 cp "$BACKUP_BUCKET/daily/mizan-<stamp>.dump.enc.hmac" .
sh /opt/mizan/restore-decrypt.sh mizan-<stamp>.dump.enc mizan.dump
#   "REFUSED … does not match" means the copy was damaged or altered (or the key is wrong):
#   take another copy. "REFUSED … not found" means the .hmac was not fetched: fetch it. Only
#   for a copy that truly has no tag (made before tags existed, or the tag is lost) add
#   --allow-untagged before the file names; it is then only as trustworthy as where it came from.

# 2 — restore into a fresh database (never over a live one), as a role that may create one
export PGPASSWORD='<POSTGRES_PASSWORD>'                  # mizan_migrate's
createdb -h db -U mizan_migrate -O mizan_migrate mizan_restore
pg_restore -h db -U mizan_migrate -d mizan_restore mizan.dump
rm mizan.dump

# 3 — integrity, before anyone is told it worked
psql -h db -U mizan_migrate -d mizan_restore -c "SELECT count(*) FROM users;"
psql -h db -U mizan_migrate -d mizan_restore -c "SELECT max(occurred_at) FROM audit_log;"   # how fresh is it?
psql -h db -U mizan_migrate -d mizan_restore -c "SELECT count(*) FROM mizan_migrations;"    # schema version
# and the ledger invariants: pnpm check:integrity against mizan_restore (restore-drills.md)

# 4 — point a staging API at it and sign in before declaring success
```

### B — to a point in time (loses at most 15 minutes)

The newest base backup taken **before** the target time, plus every WAL segment after it.
`restore-pitr.sh` checks each file's tag and decrypts it, unpacks the base backup into a new data
directory, and sets `restore_command` (`restore-wal.sh`, which checks every WAL segment's tag
before decrypting it), `recovery_target_time` and `recovery.signal`. PostgreSQL then replays the
WAL up to the target and promotes itself.

```sh
cd /restore
# 1 — choose the base backup: the newest whose stamp is before the target
aws s3 ls "$BACKUP_BUCKET/base/"
BASE=<stamp>_<segment>
aws s3 cp --recursive "$BACKUP_BUCKET/base/$BASE/" "base/$BASE/" --only-show-errors
aws s3 sync "$BACKUP_BUCKET/wal/" wal/ --only-show-errors          # all of it; recovery reads what it needs

# 2 — prepare a new data directory. The target is a time with its zone, e.g. just before the
#     mistake; recovery stops after the last transaction committed at or before it. Leave it
#     out to recover everything there is (the latest state).
sh /opt/mizan/restore-pitr.sh "base/$BASE" wal /restore/pgdata '2026-09-28 14:30:00+03'

# 3 — recover: PostgreSQL as the postgres user, with BACKUP_ENCRYPTION_KEY in its environment
su-exec postgres pg_ctl -D /restore/pgdata -l /tmp/recovery.log -w -t 3600 start
grep -E "recovery stopping|last completed transaction|archive recovery complete|FATAL|REFUSED" /tmp/recovery.log
#   "recovery stopping before commit … time …" and "archive recovery complete" = done at the target.
#   "REFUSED <segment>" + FATAL = a WAL file is damaged or altered: nothing was promoted. Fetch that
#   segment again; if the off-site copy itself is bad, the latest point reachable is just before it
#   (run again with an earlier target).
#   "recovery ended before configured recovery target was reached" = the WAL stops before the
#   target: check wal/ is complete, or choose an earlier target.

# 4 — integrity, exactly as in A step 3, against the recovered server — its socket, never db:
psql -h /var/run/postgresql -U mizan_migrate -d mizan -c "SELECT max(occurred_at) FROM audit_log;"   # just before the target
su-exec postgres pg_ctl -D /restore/pgdata -w stop
```

**Putting the recovered database into service**, once checked: stop the API and the database
(`docker compose stop api db`), move the old `db-data` volume's contents aside (keep them until
the new one has run for a week), copy `/restore/pgdata/` into the volume (owned by uid 70, mode
700), delete the recovery block at the end of its `postgresql.auto.conf`, and start
(`docker compose up -d db api`). The recovered database is on a new timeline and archives into
the same `wal-archive`; take a base backup straight away
(`docker compose exec backup sh /opt/mizan/basebackup.sh`), because the old ones end on the
previous timeline. Alternatively restore it as a dump: `pg_dump` from the recovered server and
path A step 2 into a fresh database.

## Monitoring

| What | How | Who is told |
|---|---|---|
| Uptime | external check on `/api/v1/health` every minute from outside the host | on-call, after 2 failures |
| Backups | dead-man's switch on `BACKUP_HEARTBEAT_URL` | on-call, after a missed night |
| Disk | host alert at 80 % — WAL piles up locally whenever it cannot leave the host | on-call |
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

**Nobody can sign in as an admin** (the password is forgotten, or the only admin is locked out):

```sh
docker compose exec api node apps/api/dist/database/reset-password.js admin
```

It prints a new temporary password for that user (any username works), which must be changed
at the next sign-in. It also ends that user's sessions, lifts a lockout, and writes a
`password_reset` row to History. An admin who can still sign in does the same from **Users →
Reset password**.
