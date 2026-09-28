#!/bin/sh
# Nightly backup (spec 2.14, NFR-08). cron.sh runs it once a day at or after 03:00 Baghdad.
#
# Dump → verify the dump is readable → encrypt → tag → upload off the application host (daily,
# and monthly for the first good night of each month) → a physical base backup when a week has
# passed since the last (basebackup.sh) → sync WAL, encrypted (wal-sync.sh) → prune the local
# copies → tell the dead-man's switch we are alive → remember the day as done.
# Every step is checked, and any failure exits non-zero **before** the heartbeat: a backup that
# was never verified — or never left the host — is a hope, not a backup, and silence is what
# tells somebody so.
#
# Off-site retention belongs to the bucket (lifecycle rules, Object Lock — runbook, "Off-site
# retention"), so the host's key only needs to put objects and cannot destroy the copies it
# made. BACKUP_PRUNE_OFFSITE=1 turns on pruning from here instead, for a store without
# lifecycle rules; it needs a key that may list and delete.
set -eu

HERE="$(dirname "$0")"
. "$HERE/lib.sh"

TODAY="$(date +%F)"
MONTH="$(date +%Y-%m)"
STAMP="$(date +%Y-%m-%dT%H-%M)"
DUMP="$STAGING/mizan-$STAMP.dump"
ENCRYPTED="$DUMP.enc"
TAG="$ENCRYPTED.hmac"

log() { echo "[backup] $(date -Iseconds) $*"; }
fail() { log "FAILED: $* — no heartbeat sent"; exit 1; }

# Before anything is dumped: if the copy cannot leave the host, say so now, not at the end.
problem="$(require_offsite)" || fail "$problem"
[ -n "${BACKUP_HEARTBEAT_URL:-}" ] ||
  log "WARNING: BACKUP_HEARTBEAT_URL is empty — if backups stop, nobody will be told"

mkdir -p "$STAGING" "$STATE_DIR"
# One run at a time (the loop's and one started by hand); the lock goes with the process.
exec 8> "$STATE_DIR/backup.lock"
flock -n 8 || fail "another backup run is in progress"

# The dump is the whole database in clear until it is encrypted: removed on every way out,
# failure and signal included (security review). A run killed outright (SIGKILL, power) leaves
# one behind, so the next run clears those first.
trap 'rm -f "$DUMP"' EXIT
trap 'exit 1' HUP INT TERM
rm -f "$STAGING"/mizan-*.dump

log "dumping $PGDATABASE as ${PGUSER:-?}"
pg_dump --format=custom --compress=9 --file="$DUMP" || fail "pg_dump"

# A dump that pg_restore cannot list is not a backup. This catches truncation and a disk
# that filled up half way through, which is how backups usually fail in practice.
log "verifying"
pg_restore --list "$DUMP" > /dev/null || fail "pg_restore --list could not read the dump"
TABLES="$(pg_restore --list "$DUMP" | grep -c 'TABLE DATA' || true)"
[ "$TABLES" -ge 5 ] || fail "dump contains only $TABLES tables — expected the full schema"

log "encrypting ($TABLES tables)"
encrypt_and_tag "$DUMP" "$ENCRYPTED" || fail "encrypt and tag"
rm -f "$DUMP"

# Backups leave the application host encrypted, never in clear (spec 2.13). Put-only: `cp`
# needs no permission to list or delete.
upload() {
  aws s3 cp "$ENCRYPTED" "$BACKUP_BUCKET/$1/$(basename "$ENCRYPTED")" --only-show-errors &&
    aws s3 cp "$TAG" "$BACKUP_BUCKET/$1/$(basename "$TAG")" --only-show-errors
}
log "uploading to $BACKUP_BUCKET"
upload daily || fail "upload to $BACKUP_BUCKET/daily"
# The month's copy is the first good night of the month, not "the 1st": a failed 1st must not
# cost the month its copy. Remembered here, so no listing of the bucket is needed.
if [ "$(state_read last-monthly)" != "$MONTH" ]; then
  upload monthly || fail "upload to $BACKUP_BUCKET/monthly"
  state_write last-monthly "$MONTH"
fi

# The point-in-time chain: a new base backup each week (basebackup.sh says why).
if base_due "$TODAY" "$(state_read last-base)"; then
  sh "$HERE/basebackup.sh" || fail "the weekly base backup"
fi

# The WAL written since the last sync goes too: the heartbeat vouches for the recovery point
# (fifteen minutes), not only for last night's dump.
sh "$HERE/wal-sync.sh" || fail "WAL sync to $BACKUP_BUCKET/wal"

log "pruning local copies older than 30 days"
find "$STAGING" -maxdepth 1 -name 'mizan-*.dump.enc*' -mtime +30 -delete

if [ "${BACKUP_PRUNE_OFFSITE:-0}" = 1 ]; then
  log "pruning off-site (BACKUP_PRUNE_OFFSITE=1): 30 daily, 12 monthly, ${BASE_BACKUP_KEEP:-3} base backups and the WAL before them"
  prune() {
    aws s3 ls "$BACKUP_BUCKET/$1/" | awk '{print $4}' | grep '\.dump\.enc$' | sort | head -n "-$2" |
      while read -r old; do
        [ -n "$old" ] || continue
        aws s3 rm "$BACKUP_BUCKET/$1/$old" --only-show-errors
        aws s3 rm "$BACKUP_BUCKET/$1/$old.hmac" --only-show-errors || true
      done
  }
  # Base backups are folders named <stamp>_<first WAL segment>, so they sort by age. WAL is
  # kept from the oldest kept base backup's first segment on; everything before it can no
  # longer be replayed onto anything.
  prune_base() {
    bases="$(aws s3 ls "$BACKUP_BUCKET/base/" | awk '$1 == "PRE" {print $2}' | sed 's:/$::' | sort)"
    [ -n "$bases" ] || return 0
    echo "$bases" | head -n "-$1" | while read -r old; do
      [ -n "$old" ] || continue
      aws s3 rm "$BACKUP_BUCKET/base/$old/" --recursive --only-show-errors
    done
    oldest_kept="$(echo "$bases" | tail -n "$1" | head -n 1)"
    cutoff="${oldest_kept#*_}"
    [ "${#cutoff}" -eq 24 ] || return 1
    aws s3 ls "$BACKUP_BUCKET/wal/" | awk '{print $4}' | wal_before "$cutoff" | while read -r old; do
      aws s3 rm "$BACKUP_BUCKET/wal/$old" --only-show-errors
    done
  }
  prune daily 30 || log "WARNING: pruning daily copies failed — they are kept, nothing is lost"
  prune monthly 12 || log "WARNING: pruning monthly copies failed — they are kept, nothing is lost"
  prune_base "${BASE_BACKUP_KEEP:-3}" || log "WARNING: pruning base backups or WAL failed — they are kept, nothing is lost"
fi

# The dead-man's switch: silence is the alert. If this ping stops arriving, somebody is told,
# which is the only way a backup that quietly stopped working ever gets noticed.
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  wget -q -O /dev/null "$BACKUP_HEARTBEAT_URL" || log "WARNING: heartbeat ping failed"
fi

state_write last-nightly "$TODAY"
log "done: $(basename "$ENCRYPTED")"
