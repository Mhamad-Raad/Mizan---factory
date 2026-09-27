#!/bin/sh
# Nightly backup (spec 2.14, NFR-08).
#
# Dump → verify the dump is readable → encrypt → tag → upload off the application host → sync
# WAL → prune to 30 daily and 12 monthly copies → tell the dead-man's switch we are alive.
# Every step is checked, and any failure exits non-zero **before** the heartbeat: a backup that
# was never verified — or never left the host — is a hope, not a backup, and silence is what
# tells somebody so.
set -eu

HERE="$(dirname "$0")"
. "$HERE/lib.sh"

STAGING="${BACKUP_STAGING:-/var/backups/mizan}"
STAMP="$(date +%Y-%m-%dT%H-%M)"
DAY_OF_MONTH="$(date +%d)"
DUMP="$STAGING/mizan-$STAMP.dump"
ENCRYPTED="$DUMP.enc"
TAG="$ENCRYPTED.hmac"

log() { echo "[backup] $(date -Iseconds) $*"; }
fail() { log "FAILED: $* — no heartbeat sent"; exit 1; }

# Before anything is dumped: if the copy cannot leave the host, say so now, not at the end.
problem="$(require_offsite)" || fail "$problem"

mkdir -p "$STAGING"

log "dumping $PGDATABASE"
pg_dump --format=custom --compress=9 --file="$DUMP" || fail "pg_dump"

# A dump that pg_restore cannot list is not a backup. This catches truncation and a disk
# that filled up half way through, which is how backups usually fail in practice.
log "verifying"
pg_restore --list "$DUMP" > /dev/null || fail "pg_restore --list could not read the dump"
TABLES="$(pg_restore --list "$DUMP" | grep -c 'TABLE DATA' || true)"
[ "$TABLES" -ge 5 ] || fail "dump contains only $TABLES tables — expected the full schema"

log "encrypting ($TABLES tables)"
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$DUMP" -out "$ENCRYPTED" -pass env:BACKUP_ENCRYPTION_KEY || fail "encrypt"
mac_of "$ENCRYPTED" > "$TAG" || fail "integrity tag"
rm -f "$DUMP"

# Backups leave the application host encrypted, never in clear (spec 2.13).
upload() {
  aws s3 cp "$ENCRYPTED" "$BACKUP_BUCKET/$1/$(basename "$ENCRYPTED")" --only-show-errors &&
    aws s3 cp "$TAG" "$BACKUP_BUCKET/$1/$(basename "$TAG")" --only-show-errors
}
log "uploading to $BACKUP_BUCKET"
upload daily || fail "upload to $BACKUP_BUCKET/daily"
if [ "$DAY_OF_MONTH" = "01" ]; then
  upload monthly || fail "upload to $BACKUP_BUCKET/monthly"
fi

# The WAL written since the last sync goes too: the heartbeat vouches for the recovery point
# (fifteen minutes), not only for last night's dump.
if [ -d /wal-archive ]; then
  log "syncing WAL"
  aws s3 sync /wal-archive "$BACKUP_BUCKET/wal/" --only-show-errors || fail "WAL sync to $BACKUP_BUCKET/wal"
fi

log "pruning: 30 daily, 12 monthly"
find "$STAGING" -name 'mizan-*.dump.enc*' -mtime +30 -delete
prune() {
  aws s3 ls "$BACKUP_BUCKET/$1/" | awk '{print $4}' | grep '\.dump\.enc$' | sort | head -n "-$2" |
    while read -r old; do
      [ -n "$old" ] || continue
      aws s3 rm "$BACKUP_BUCKET/$1/$old" --only-show-errors
      aws s3 rm "$BACKUP_BUCKET/$1/$old.hmac" --only-show-errors || true
    done
}
prune daily 30 || log "WARNING: pruning daily copies failed — they are kept, nothing is lost"
prune monthly 12 || log "WARNING: pruning monthly copies failed — they are kept, nothing is lost"

# The dead-man's switch: silence is the alert. If this ping stops arriving, somebody is told,
# which is the only way a backup that quietly stopped working ever gets noticed.
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  wget -q -O /dev/null "$BACKUP_HEARTBEAT_URL" || log "WARNING: heartbeat ping failed"
fi

log "done: $(basename "$ENCRYPTED")"
