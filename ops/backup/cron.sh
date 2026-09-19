#!/bin/sh
# The backup container's loop: run at 03:00 Asia/Baghdad, as section 2.14 specifies.
# A plain loop rather than a cron daemon, so the container's logs are the backup's logs.
set -eu

log() { echo "[backup-cron] $(date -Iseconds) $*"; }
log "started; backups run nightly at 03:00 Asia/Baghdad"

# Upload WAL segments off the host alongside the nightly dump.
sync_wal() {
  [ -d /wal-archive ] || return 0
  command -v aws > /dev/null 2>&1 || return 0
  aws s3 sync /wal-archive "$BACKUP_BUCKET/wal/" --only-show-errors || log "WARNING: WAL sync failed"
}

while true; do
  NOW="$(date +%H%M)"
  if [ "$NOW" = "0300" ]; then
    /bin/sh /opt/mizan/backup.sh || log "backup script reported a failure"
    sync_wal
    sleep 3600
  else
    sync_wal
    sleep 300
  fi
done
