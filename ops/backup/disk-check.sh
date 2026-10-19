#!/bin/sh
# The disk guard (D-115). Run by cron.sh on every pass of its loop (five minutes).
#
# The WAL archive, the backup staging and the database share one disk. If WAL stops leaving the
# host (an expired key, an unpaid bucket), wal-sync.sh rightly keeps every file it could not
# upload, and the disk fills in weeks: PostgreSQL, unable to archive, then stops, and the
# factory with it.
#
# 1. At BACKUP_DISK_WARN_PERCENT (80) used: a WARNING here, and a failure ping to the
#    dead-man's switch (BACKUP_HEARTBEAT_URL + "/fail"), so somebody is told before it matters.
# 2. At BACKUP_DISK_RELIEF_PERCENT (90) used: the oldest local WAL files are deleted, uploaded
#    or not, until the disk is back under the warning level, and the next good night takes a
#    fresh base backup. The database keeps running; point-in-time recovery has a gap until that
#    base backup; the nightly dumps are not touched. A factory that stops is worse than a
#    recovery window with a hole in it.
set -eu

HERE="$(dirname "$0")"
. "$HERE/lib.sh"

ARCHIVE="${WAL_ARCHIVE_DIR:-/wal-archive}"
UPLOADED="$STATE_DIR/wal-uploaded"
WARN="${BACKUP_DISK_WARN_PERCENT:-80}"
RELIEF="${BACKUP_DISK_RELIEF_PERCENT:-90}"

log() { echo "[disk] $(date -Iseconds) $*"; }

[ -d "$ARCHIVE" ] || exit 0
used="$(disk_percent "$ARCHIVE")"
[ "$used" -ge "$WARN" ] || exit 0

log "WARNING: the disk is ${used}% full — WAL is probably not leaving this host; see the [wal-sync] lines"
alert_failure

[ "$used" -ge "$RELIEF" ] || exit 0

# WAL names sort in the order they were written, and the glob sorts them, so the oldest go
# first. `.tmp` is a file archive-wal.sh is still writing; timeline `.history` files are tiny
# and kept.
dropped=0
for path in "$ARCHIVE"/*; do
  [ -f "$path" ] || continue
  name="$(basename "$path")"
  case "$name" in *.tmp | *.history) continue ;; esac
  [ "$(disk_percent "$ARCHIVE")" -lt "$WARN" ] && break
  rm -f "$path" "$UPLOADED/$name"
  dropped=$((dropped + 1))
done
# The chain is broken from here back: the next good night starts a new one.
state_write last-base ""
log "ERROR: the disk was ${used}% full — dropped $dropped WAL file(s), oldest first, to keep the database running;" \
  "point-in-time recovery has a gap until the next base backup; the nightly dumps are untouched"
