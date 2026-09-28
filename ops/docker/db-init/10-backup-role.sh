#!/bin/sh
# First initialisation of the database volume only (/docker-entrypoint-initdb.d of the postgres
# image; compose.yml mounts this directory there). Creates the backup container's own role:
#
#   mizan_backup  LOGIN REPLICATION, member of pg_read_all_data — it can read every table
#                 (pg_dump) and take a physical base backup (pg_basebackup), and it cannot write
#                 anything. The backup container no longer connects as mizan_migrate, the
#                 schema owner, which could rewrite the append-only ledgers (security review).
#
# and lets it make replication connections from the compose network (pg_hba.conf; the image's
# own `host all all all` line does not cover replication). Both need a superuser, which is why
# this is an init script and not a migration: after the first migrate, mizan_migrate is no
# longer one. On a database initialised before this script existed, run the same two steps by
# hand (runbook, "The backup role").
#
# The whole body is a subshell, so it behaves the same whether the image sources this file or
# runs it, and never changes the options of the image's entrypoint.
(
  set -eu
  : "${BACKUP_DB_PASSWORD:?BACKUP_DB_PASSWORD must be set — the password of the mizan_backup role}"

  psql -v ON_ERROR_STOP=1 -v backup_password="$BACKUP_DB_PASSWORD" \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE mizan_backup LOGIN REPLICATION PASSWORD :'backup_password';
GRANT pg_read_all_data TO mizan_backup;
SQL

  cat >> "$PGDATA/pg_hba.conf" <<'HBA'

# pg_basebackup from the backup container (ops/backup/basebackup.sh): replication for mizan_backup only.
host replication mizan_backup all scram-sha-256
HBA
  echo "10-backup-role.sh: created mizan_backup (REPLICATION, pg_read_all_data) and its pg_hba entry"
)
