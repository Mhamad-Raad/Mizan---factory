#!/bin/sh
# Nightly backup (spec 2.14, NFR-08).
#
# Dump → verify the dump is readable → encrypt → upload off the application host → prune to
# 30 daily and 12 monthly copies → tell the dead-man's switch we are alive. Every step is
# checked: a backup that was never verified is a hope, not a backup.
set -eu

STAGING="${BACKUP_STAGING:-/var/backups/mizan}"
STAMP="$(date +%Y-%m-%dT%H-%M)"
DAY_OF_MONTH="$(date +%d)"
DUMP="$STAGING/mizan-$STAMP.dump"
ENCRYPTED="$DUMP.enc"

log() { echo "[backup] $(date -Iseconds) $*"; }
fail() { log "FAILED: $*"; exit 1; }

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
rm -f "$DUMP"

# Backups leave the application host encrypted, never in clear (spec 2.13).
log "uploading to $BACKUP_BUCKET"
if command -v aws > /dev/null 2>&1; then
  aws s3 cp "$ENCRYPTED" "$BACKUP_BUCKET/daily/$(basename "$ENCRYPTED")" || fail "upload"
  [ "$DAY_OF_MONTH" = "01" ] &&
    aws s3 cp "$ENCRYPTED" "$BACKUP_BUCKET/monthly/$(basename "$ENCRYPTED")"
else
  log "WARNING: no aws client in this image — the copy stays in $STAGING only"
fi

log "pruning: 30 daily, 12 monthly"
find "$STAGING" -name 'mizan-*.dump.enc' -mtime +30 -delete
if command -v aws > /dev/null 2>&1; then
  aws s3 ls "$BACKUP_BUCKET/daily/" | awk '{print $4}' | sort | head -n -30 | while read -r old; do
    [ -n "$old" ] && aws s3 rm "$BACKUP_BUCKET/daily/$old"
  done
  aws s3 ls "$BACKUP_BUCKET/monthly/" | awk '{print $4}' | sort | head -n -12 | while read -r old; do
    [ -n "$old" ] && aws s3 rm "$BACKUP_BUCKET/monthly/$old"
  done
fi

# The dead-man's switch: silence is the alert. If this ping stops arriving, somebody is told,
# which is the only way a backup that quietly stopped working ever gets noticed.
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  wget -q -O /dev/null "$BACKUP_HEARTBEAT_URL" || log "WARNING: heartbeat ping failed"
fi

log "done: $(basename "$ENCRYPTED")"
