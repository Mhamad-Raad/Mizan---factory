#!/bin/sh
# PostgreSQL restore_command for a point-in-time recovery (runbook, "Restore to a point in
# time"). Written into the recovered data directory by restore-pitr.sh:
#
#   restore_command = 'sh /opt/mizan/restore-wal.sh /restore/wal %f %p'
#
# <dir> holds the WAL fetched from $BACKUP_BUCKET/wal/ (<name>.gz.enc with <name>.gz.enc.hmac).
# Each file's tag is checked before it is decrypted: a segment that was damaged or altered is
# never replayed into the ledgers. Needs BACKUP_ENCRYPTION_KEY in the server's environment.
#
# Exit codes are PostgreSQL's contract. 1 means "no such file", which is normal — recovery asks
# for the next timeline's history and the segment after the last one, and ends when told there
# is none. A bad tag or a failed decryption exits 255, which PostgreSQL treats as fatal: the
# recovery stops loudly instead of ending early at the damaged segment and calling that the end.
set -eu

HERE="$(dirname "$0")"
. "$HERE/lib.sh"

DIR="${1:?usage: restore-wal.sh <dir> %f %p}"
NAME="${2:?usage: restore-wal.sh <dir> %f %p}"
DEST="${3:?usage: restore-wal.sh <dir> %f %p}"
ENC="$DIR/$NAME.gz.enc"

[ -f "$ENC" ] || exit 1
if ! tag_matches "$ENC"; then
  echo "restore-wal: REFUSED $NAME — its integrity tag is missing or does not match (damaged, altered, or the wrong BACKUP_ENCRYPTION_KEY)" >&2
  exit 255
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ENC" -out "$DEST.gz" -pass env:BACKUP_ENCRYPTION_KEY ||
  { rm -f "$DEST.gz"; echo "restore-wal: could not decrypt $NAME" >&2; exit 255; }
gzip -dc "$DEST.gz" > "$DEST" || { rm -f "$DEST.gz" "$DEST"; echo "restore-wal: could not decompress $NAME" >&2; exit 255; }
rm -f "$DEST.gz"
