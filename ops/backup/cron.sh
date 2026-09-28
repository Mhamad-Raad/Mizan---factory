#!/bin/sh
# The backup container's loop: the nightly backup once a day at or after 03:00 Asia/Baghdad
# (section 2.14), and WAL off the host every five minutes in between. A plain loop rather than
# a cron daemon, so the container's logs are the backup's logs.
#
# "At or after", not "at": the night is due from 03:00 until it has succeeded, and the day it
# last succeeded is kept on the backup-staging volume (state/last-nightly, written by
# backup.sh). A container that was down at 03:00 runs when it comes back; one restarted after a
# good night does not run again. A failed night is retried after 15 minutes, then 30, 60, and
# every two hours until it succeeds or the day ends — each failure logged, and no heartbeat
# until one succeeds.
set -eu

HERE="$(dirname "$0")"
. "$HERE/lib.sh"

log() { echo "[backup-cron] $(date -Iseconds) $*"; }
log "started; the nightly backup runs once a day at or after ${BACKUP_AT:-0300} Asia/Baghdad, WAL leaves every 5 minutes"

# Said at start-up and on every attempt, never skipped quietly: an off-site copy that cannot
# happen is the failure this container exists to prevent (security review, finding 10).
if ! problem="$(require_offsite)"; then
  log "ERROR: $problem — WAL is NOT leaving this host and the nightly backup will fail"
fi
# The dead-man's switch is the only thing that notices a backup that stopped. Without it, the
# first person to learn is the one who needs the backup.
if [ -z "${BACKUP_HEARTBEAT_URL:-}" ]; then
  log "WARNING: ****************************************************************************"
  log "WARNING: BACKUP_HEARTBEAT_URL is empty. Nobody will be told if backups stop working."
  log "WARNING: Set it in .env to a dead-man's-switch monitor (runbook, \"Backups\")."
  log "WARNING: ****************************************************************************"
fi

ATTEMPT=0
NEXT_TRY=0
ATTEMPT_DAY=""
while true; do
  TODAY="$(date +%F)"
  if [ "$TODAY" != "$ATTEMPT_DAY" ]; then
    ATTEMPT=0
    NEXT_TRY=0
    ATTEMPT_DAY="$TODAY"
  fi
  if nightly_due "$TODAY" "$(date +%H%M)" "$(state_read last-nightly)" && [ "$(date +%s)" -ge "$NEXT_TRY" ]; then
    if sh "$HERE/backup.sh"; then
      ATTEMPT=0
    else
      ATTEMPT=$((ATTEMPT + 1))
      DELAY="$(retry_delay "$ATTEMPT")"
      NEXT_TRY=$(($(date +%s) + DELAY))
      log "ERROR: the nightly backup FAILED (attempt $ATTEMPT) — see the [backup] lines above; no heartbeat was sent; retrying in $((DELAY / 60)) minutes"
    fi
  else
    sh "$HERE/wal-sync.sh" || log "ERROR: WAL sync failed — see the [wal-sync] lines above; retrying in 5 minutes"
  fi
  sleep "${BACKUP_LOOP_SECONDS:-300}"
done
