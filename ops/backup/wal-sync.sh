#!/bin/sh
# Continuous WAL off the host (spec 2.14, NFR-08). Run by cron.sh every five minutes and by
# backup.sh at the end of each night.
#
# 1. Every archived WAL file not yet uploaded is compressed, encrypted and tagged on its own,
#    then uploaded to $BACKUP_BUCKET/wal/<name>.gz.enc with its .hmac. WAL is the database's
#    contents as surely as a dump is, so it never leaves in clear. What has left is remembered
#    in state/wal-uploaded/ (one empty file per name), so each run uploads only what is new and
#    a key that may only put objects is enough — nothing here lists or reads the bucket.
# 2. The local archive is pruned: a file goes once it has left the host **and** is older than the
#    newest base backup's first WAL segment (pg_archivecleanup, dry run, then only the files
#    already uploaded). Without this the archive grows until the disk is full and PostgreSQL,
#    unable to archive, stops.
#
# Off-site retention of WAL is the bucket's lifecycle rule (runbook, "Off-site retention"), or
# backup.sh's optional prune.
set -eu

HERE="$(dirname "$0")"
. "$HERE/lib.sh"

ARCHIVE="${WAL_ARCHIVE_DIR:-/wal-archive}"
UPLOADED="$STATE_DIR/wal-uploaded"
WORK="$STAGING/wal-out"

log() { echo "[wal-sync] $(date -Iseconds) $*"; }

[ -d "$ARCHIVE" ] || exit 0
if ! problem="$(require_offsite)"; then
  log "ERROR: WAL not synced: $problem"
  exit 1
fi
mkdir -p "$UPLOADED" "$WORK"

# One sync at a time: the loop's and a hand-run backup.sh's must not upload the same file twice
# or prune under each other, so a second one waits for the first. flock lets go by itself if
# the holder dies.
exec 9> "$STATE_DIR/wal-sync.lock"
flock 9 || { log "ERROR: could not take the WAL sync lock"; exit 1; }

# The compressed segment is in clear for the moment before it is encrypted; never leave it.
trap 'rm -f "$WORK"/*.gz' EXIT
trap 'exit 1' HUP INT TERM

KEY=""
sent=0
for path in "$ARCHIVE"/*; do
  [ -f "$path" ] || continue
  name="$(basename "$path")"
  case "$name" in *.tmp) continue ;; esac # archive-wal.sh is still writing it
  [ -e "$UPLOADED/$name" ] && continue
  [ -n "$KEY" ] || KEY="$(mac_key)"
  [ -n "$KEY" ] || { log "ERROR: could not derive the integrity-tag key"; exit 1; }

  gzip -c "$path" > "$WORK/$name.gz" || { log "ERROR: could not compress $name"; exit 1; }
  encrypt_and_tag "$WORK/$name.gz" "$WORK/$name.gz.enc" "$KEY" || { log "ERROR: could not encrypt $name"; exit 1; }
  rm -f "$WORK/$name.gz"
  # The tag goes last: an object without its tag is refused at restore, never trusted.
  if aws s3 cp "$WORK/$name.gz.enc" "$BACKUP_BUCKET/wal/$name.gz.enc" --only-show-errors &&
    aws s3 cp "$WORK/$name.gz.enc.hmac" "$BACKUP_BUCKET/wal/$name.gz.enc.hmac" --only-show-errors; then
    : > "$UPLOADED/$name"
    rm -f "$WORK/$name.gz.enc" "$WORK/$name.gz.enc.hmac"
    sent=$((sent + 1))
  else
    log "ERROR: upload of $name to $BACKUP_BUCKET/wal failed — it stays here and is tried again"
    exit 1
  fi
done
[ "$sent" -eq 0 ] || log "uploaded $sent WAL file(s)"

# Prune locally, only behind the newest base backup and only what has left the host.
NEWEST_START="$(state_read base-start-wal)"
if [ -n "$NEWEST_START" ]; then
  pruned=0
  # pg_archivecleanup names the segments; the small `.backup` history files it leaves are
  # matched by name the same way.
  for path in $(pg_archivecleanup -n "$ARCHIVE" "$NEWEST_START") \
    $(ls "$ARCHIVE" | grep '\.backup$' | wal_before "$NEWEST_START"); do
    name="$(basename "$path")"
    path="$ARCHIVE/$name"
    if [ -e "$UPLOADED/$name" ]; then
      rm -f "$path" "$UPLOADED/$name"
      pruned=$((pruned + 1))
    fi
  done
  [ "$pruned" -eq 0 ] || log "pruned $pruned local WAL file(s) older than $NEWEST_START"
fi

# Forget uploads whose file is gone (pruned by hand, or the archive volume was replaced).
for marker in "$UPLOADED"/*; do
  [ -e "$marker" ] || continue
  [ -e "$ARCHIVE/$(basename "$marker")" ] || rm -f "$marker"
done
