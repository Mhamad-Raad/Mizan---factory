#!/bin/sh
# Weekly physical base backup — the starting point of a point-in-time recovery (NFR-08).
#
# A pg_dump cannot have WAL replayed on top of it; a base backup can. With the base backup and
# every archived WAL segment since, the database can be rebuilt to any moment up to the last
# segment that left the host — fifteen minutes ago at worst, not last night.
#
# pg_basebackup (tar, gzip, the WAL of the backup's own span streamed into pg_wal.tar.gz, so
# the copy is consistent on its own) → check both tars are whole and read the backup's first
# WAL segment from backup_label → encrypt and tag each file like the nightly dump → upload to
# $BACKUP_BUCKET/base/<stamp>_<first WAL segment>/ → keep the newest one on this host too →
# record it, which moves the line behind which wal-sync.sh prunes the local WAL archive.
#
# Connects as mizan_backup (REPLICATION, pg_read_all_data — ops/docker/db-init). Called by
# backup.sh when a week has passed since the last one; can be run by hand at any time:
#   docker compose exec backup sh /opt/mizan/basebackup.sh
set -eu

HERE="$(dirname "$0")"
. "$HERE/lib.sh"

STAMP="$(date +%Y-%m-%dT%H-%M)"
TODAY="$(date +%F)"
WORK="$STAGING/base-work"

log() { echo "[basebackup] $(date -Iseconds) $*"; }
fail() { log "FAILED: $*"; exit 1; }

# The raw tars are the whole database in clear: gone on every way out of this script.
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' HUP INT TERM

problem="$(require_offsite)" || fail "$problem"
rm -rf "$WORK"
mkdir -p "$WORK/raw" "$WORK/enc" "$STAGING/base"

log "taking a base backup of $PGHOST as ${PGUSER:-?}"
pg_basebackup --pgdata="$WORK/raw" --format=tar --gzip --wal-method=stream \
  --checkpoint=fast --label="jiyan $STAMP" --no-password || fail "pg_basebackup"

for part in base.tar.gz pg_wal.tar.gz; do
  [ -s "$WORK/raw/$part" ] || fail "$part is missing or empty"
  gzip -t "$WORK/raw/$part" || fail "$part is not a whole gzip file"
done
LABEL="$(tar -xzOf "$WORK/raw/base.tar.gz" backup_label)" || fail "base.tar.gz has no backup_label"
START_WAL="$(echo "$LABEL" | sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]*\)).*$/\1/p')"
[ "${#START_WAL}" -eq 24 ] || fail "could not read the first WAL segment from backup_label"

NAME="${STAMP}_${START_WAL}"
log "encrypting $NAME"
KEY="$(mac_key)"
[ -n "$KEY" ] || fail "could not derive the integrity-tag key"
for path in "$WORK/raw"/*; do
  file="$(basename "$path")"
  encrypt_and_tag "$path" "$WORK/enc/$file.enc" "$KEY" || fail "encrypt $file"
  rm -f "$path"
done

log "uploading to $BACKUP_BUCKET/base/$NAME/"
for path in "$WORK/enc"/*.enc; do
  file="$(basename "$path")"
  aws s3 cp "$path" "$BACKUP_BUCKET/base/$NAME/$file" --only-show-errors &&
    aws s3 cp "$path.hmac" "$BACKUP_BUCKET/base/$NAME/$file.hmac" --only-show-errors ||
    fail "upload of $file to $BACKUP_BUCKET/base/$NAME"
done

# The newest base backup stays here as well (encrypted), so a database lost while the host
# survives is rebuilt without downloading it. Only the newest: the rest are off-site.
rm -rf "$STAGING/base/"*
mv "$WORK/enc" "$STAGING/base/$NAME"

state_write base-start-wal "$START_WAL"
state_write last-base "$TODAY"
log "done: $NAME"
