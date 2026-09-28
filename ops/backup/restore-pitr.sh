#!/bin/sh
# Prepare a data directory for a point-in-time recovery (runbook, "Restore to a point in time").
#
#   BACKUP_ENCRYPTION_KEY=… sh ops/backup/restore-pitr.sh <base dir> <wal dir> <new data dir> ['<target time>']
#
# <base dir>  one base backup fetched from $BACKUP_BUCKET/base/<stamp>_<segment>/ — the
#             *.tar.gz.enc files with their .hmac tags (backup_manifest.enc is not needed)
# <wal dir>   everything fetched from $BACKUP_BUCKET/wal/ (the .gz.enc files with their tags)
# <new data dir>  empty or missing; never a live database's directory
# <target time>   e.g. '2026-09-28 14:30:00+03'. Recovery stops just after the last transaction
#             committed at or before it. Left out: replay every segment there is (the latest state).
#
# Checks each tag and decrypts (restore-decrypt.sh — a copy whose tag is missing or wrong is
# refused), unpacks the base and its own WAL, points restore_command at restore-wal.sh (which
# checks every segment's tag in turn), sets the target and writes recovery.signal. Starting
# PostgreSQL on the directory then performs the recovery; it promotes itself when the target is
# reached, and refuses to start at all if the WAL runs out before the target.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"

USAGE="usage: restore-pitr.sh <base dir> <wal dir> <new data dir> ['<target time>']"
BASE="${1:?$USAGE}"
WAL="${2:?$USAGE}"
PGDATA_NEW="${3:?$USAGE}"
TARGET="${4:-}"
WAL="$(cd "$WAL" && pwd)"

if [ -d "$PGDATA_NEW" ] && [ -n "$(ls -A "$PGDATA_NEW")" ]; then
  echo "REFUSED: $PGDATA_NEW is not empty — recover into a new, empty directory" >&2
  exit 1
fi
mkdir -p "$PGDATA_NEW"

# The decrypted tars are the whole database in clear: gone on every way out.
CLEAR="$(mktemp -d "${TMPDIR:-/tmp}/jiyan-pitr.XXXXXX")"
trap 'rm -rf "$CLEAR"' EXIT
trap 'exit 1' HUP INT TERM

for part in base.tar.gz pg_wal.tar.gz; do
  sh "$HERE/restore-decrypt.sh" "$BASE/$part.enc" "$CLEAR/$part"
done
tar -xzf "$CLEAR/base.tar.gz" -C "$PGDATA_NEW"
mkdir -p "$PGDATA_NEW/pg_wal"
tar -xzf "$CLEAR/pg_wal.tar.gz" -C "$PGDATA_NEW/pg_wal"
rm -rf "$CLEAR"/*

# Recovery settings go in postgresql.auto.conf, which is read after postgresql.conf. After the
# recovery has finished, restore_command is simply unused; the block can be deleted.
{
  echo ""
  echo "# --- point-in-time recovery, written by restore-pitr.sh on $(date -Iseconds) ---"
  echo "restore_command = 'sh $HERE/restore-wal.sh $WAL %f %p'"
  if [ -n "$TARGET" ]; then
    echo "recovery_target_time = '$TARGET'"
    echo "recovery_target_action = 'promote'"
  fi
  # The recovered copy must not archive into the live archive while it is being inspected.
  echo "archive_mode = 'off'"
} >> "$PGDATA_NEW/postgresql.auto.conf"
: > "$PGDATA_NEW/recovery.signal"

# PostgreSQL refuses a data directory that others can read, or that it does not own.
chmod 700 "$PGDATA_NEW"
if [ "$(id -u)" = 0 ] && id postgres > /dev/null 2>&1; then
  chown -R postgres:postgres "$PGDATA_NEW"
fi

echo "prepared: $PGDATA_NEW"
echo "  base: $BASE"
echo "  WAL:  $WAL"
echo "  target: ${TARGET:-the end of the archived WAL}"
echo "Start PostgreSQL on it (as the postgres user, with BACKUP_ENCRYPTION_KEY in its environment)"
echo "and wait for \"database system is ready to accept connections\"."
