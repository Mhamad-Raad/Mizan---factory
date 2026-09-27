#!/bin/sh
# The backup container's loop: run at 03:00 Asia/Baghdad, as section 2.14 specifies.
# A plain loop rather than a cron daemon, so the container's logs are the backup's logs.
set -eu

. /opt/mizan/lib.sh

log() { echo "[backup-cron] $(date -Iseconds) $*"; }
log "started; backups run nightly at 03:00 Asia/Baghdad"

# Said at start-up and on every attempt, never skipped quietly: an off-site copy that cannot
# happen is the failure this container exists to prevent (security review, finding 10).
if ! problem="$(require_offsite)"; then
  log "ERROR: $problem — WAL is NOT leaving this host and the nightly backup will fail"
fi

# Upload WAL segments off the host between the nightly dumps.
sync_wal() {
  [ -d /wal-archive ] || return 0
  if ! problem="$(require_offsite)"; then
    log "ERROR: WAL not synced: $problem"
    return 0
  fi
  aws s3 sync /wal-archive "$BACKUP_BUCKET/wal/" --only-show-errors || log "ERROR: WAL sync to $BACKUP_BUCKET/wal failed"
}

while true; do
  NOW="$(date +%H%M)"
  if [ "$NOW" = "0300" ]; then
    /bin/sh /opt/mizan/backup.sh || log "ERROR: the nightly backup FAILED — see the [backup] lines above; no heartbeat was sent"
    sleep 3600
  else
    sync_wal
    sleep 300
  fi
done
