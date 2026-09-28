# Deploying Jiyan Management

This takes a fresh Linux server to a running system, with HTTPS and encrypted off-site backups,
in about an hour. Every step below was run end to end on a fresh clone (2026-09-28). For
day-to-day operation afterwards — updates, restores, incidents — see
[`ops/runbook/README.md`](ops/runbook/README.md).

## What you need

| | |
|---|---|
| **A server** | Ubuntu 22.04 or 24.04 (any Linux with Docker works). 2 CPU, 4 GB RAM, 40 GB disk is plenty for years of one factory's data. Ports 80 and 443 reachable from the internet (or from the factory network). |
| **A domain** | e.g. `jiyan.example.com`, whose DNS you can edit. |
| **Off-site storage** | An S3-compatible bucket for backups: AWS S3, Backblaze B2 or Wasabi (a few dollars a month). |
| **Optional** | A free [healthchecks.io](https://healthchecks.io) check, so you are e-mailed if backups ever stop. |

The system runs as five Docker containers from this repository's `compose.yml`: **web** (Caddy:
HTTPS and the app), **api**, **db** (PostgreSQL), **backup**, and a one-off **migrate** job.

## 1. Prepare the server

```sh
# Docker Engine and the compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # then log out and back in

# Firewall: SSH and the web only
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```

## 2. Point the domain at the server

Create a DNS **A record** for your domain with the server's public IP address. Wait until
`ping jiyan.example.com` answers from that address. Caddy obtains the HTTPS certificate by
itself on first start, and it can only do that once the name points here.

## 3. Create the backup storage

In your storage provider:

1. Create a bucket, e.g. `jiyan-backups`, with **versioning** on (and **Object Lock**, 30 days,
   if the provider offers it).
2. Add **lifecycle rules** that delete old copies: `daily/` after 31 days, `monthly/` after
   400 days, `base/` and `wal/` after 22 days.
3. Create an access key that may **only upload** (put) to that bucket — not list, read or delete.
   A stolen server then cannot delete the backups.

The runbook's "Off-site retention" section has the exact policy.

## 4. Get the code and fill in the settings

```sh
git clone <this repository's URL> jiyan && cd jiyan
cp .env.production.example .env
nano .env
```

Fill in every `CHANGE_ME`:

| Setting | What to put |
|---|---|
| `MIZAN_DOMAIN`, `APP_BASE_URL` | Your domain, e.g. `jiyan.example.com` and `https://jiyan.example.com`. |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` — and put **the same value** in `DATABASE_MIGRATE_URL`. |
| `DATABASE_URL` | Replace `CHANGE_ME_APP_PASSWORD` with a second `openssl rand -hex 24` (used in step 6). |
| `SESSION_PEPPER`, `BACKUP_ENCRYPTION_KEY` | `openssl rand -base64 32` each. **Keep a copy of `BACKUP_ENCRYPTION_KEY` in a password manager, off the server**: without it no backup can ever be restored. |
| `BACKUP_DB_PASSWORD` | `openssl rand -hex 24`. |
| `FIRST_ADMIN_PASSWORD` | A temporary password; you replace it at the first sign-in. |
| `BACKUP_BUCKET`, `AWS_*` | The bucket and the upload-only key from step 3. For B2 or Wasabi also set `AWS_ENDPOINT_URL`. |
| `BACKUP_HEARTBEAT_URL` | The healthchecks.io ping URL, if you made one. |

Fill everything in **before** the next step: the database's first start reads
`BACKUP_DB_PASSWORD` to create the backup job's login.

## 5. Build and start the database

```sh
docker compose --profile tools build        # about 5 minutes the first time
docker compose up -d db
docker compose --profile tools run --rm migrate
```

The last command prints `applied: 0001_foundation.sql, …` — the database structure is created.

## 6. Secure the database accounts (once)

Replace the two placeholders with the values from your `.env`, and keep the new `db_admin`
password in the password manager too — it is only for emergencies and restores.

```sh
# The application's own account gets its password (the one inside DATABASE_URL):
docker compose exec db psql -U mizan_migrate -d mizan -c "ALTER ROLE mizan_app PASSWORD '<password from DATABASE_URL>'"

# A separate administrator, then the migration account loses its superuser rights:
docker compose exec db psql -U mizan_migrate -d mizan -c "CREATE ROLE db_admin LOGIN SUPERUSER PASSWORD '<openssl rand -hex 24>'"
docker compose exec db psql -U db_admin -d mizan -c "ALTER ROLE mizan_migrate NOSUPERUSER CREATEDB"
```

## 7. Start everything and create the first administrator

```sh
docker compose up -d
docker compose ps                                              # all "Up", api "(healthy)"
docker compose exec api node apps/api/dist/database/seed.js    # creates the admin
```

Then:

1. Open `https://<your domain>` and sign in as `admin` with the temporary password. The system
   asks for a new password straight away.
2. Remove the `FIRST_ADMIN_PASSWORD` line from `.env`.
3. In **Settings**, set today's dollar rate. In **Users**, add the employees.

`https://<your domain>/api/v1/health` should answer `{"status":"ok",…}`.

## 8. Check the backups

```sh
docker compose logs backup | tail -20
```

On its first start the backup job takes the first dump, a base backup and uploads the database
log. Expect `done: mizan-….dump.enc` and `uploaded N WAL file(s)`. After that it runs every
night at 03:00 (Baghdad time), a full base backup weekly, and sends the database log off the
server every few minutes, so at most about 15 minutes of work can be lost.

Test a restore before relying on it: the runbook's "Restore" section, on a spare machine.

## Updating to a new version

```sh
cd jiyan
git pull
docker compose --profile tools build
docker compose --profile tools run --rm migrate
docker compose up -d
```

Do it outside working hours. The API refuses to start until the migrations have run, so a half
update cannot serve anyone.

## If something goes wrong

| Symptom | Cause and fix |
|---|---|
| The site does not load, Caddy logs certificate errors | The domain does not point at this server yet, or ports 80/443 are closed. Fix DNS or the firewall, then `docker compose restart web`. |
| `api` keeps restarting, logs mention migrations | Run `docker compose --profile tools run --rm migrate`, then `docker compose up -d`. |
| `api` logs "password authentication failed for user mizan_app" | Step 6's first command was not run, or its password differs from `DATABASE_URL`. |
| The backup log says `WARNING … heartbeat` | Only a reminder that `BACKUP_HEARTBEAT_URL` is empty; set it to be told if backups stop. |
| The backup log shows upload errors | Check the bucket name, the key and `AWS_ENDPOINT_URL` in `.env`, then `docker compose up -d backup`. |
| Forgot the admin password | `docker compose exec api node apps/api/dist/database/reset-password.js admin` prints a temporary one (it must be changed at sign-in). |

Logs of any part: `docker compose logs -f api` (or `web`, `db`, `backup`).
