#!/bin/sh
# Decrypt one backup copy for a restore, checking its integrity tag first (runbook, "Restore").
#
#   BACKUP_ENCRYPTION_KEY=… sh ops/backup/restore-decrypt.sh mizan-<stamp>.dump.enc mizan.dump
#
# Copies written since the integrity tag was added (security review, finding 18) have a
# `<file>.hmac` beside them, and a copy whose tag does not match is refused: it was damaged or
# altered, and restoring it would put that into the ledgers. Older copies have no tag; they are
# still decrypted, with a warning, so the thirteen months of retention stay restorable.
set -eu

HERE="$(dirname "$0")"
. "$HERE/lib.sh"

ENCRYPTED="${1:?usage: restore-decrypt.sh <file.dump.enc> <out.dump>}"
OUT="${2:?usage: restore-decrypt.sh <file.dump.enc> <out.dump>}"
TAG="$ENCRYPTED.hmac"

[ -f "$ENCRYPTED" ] || { echo "no such file: $ENCRYPTED" >&2; exit 1; }

if [ -f "$TAG" ]; then
  expected="$(cat "$TAG")"
  actual="$(mac_of "$ENCRYPTED")"
  if [ "$expected" != "$actual" ]; then
    echo "REFUSED: $ENCRYPTED does not match its integrity tag — the copy is damaged or was altered," >&2
    echo "or BACKUP_ENCRYPTION_KEY is not the key it was written with. Try another copy." >&2
    exit 1
  fi
  echo "integrity tag verified"
else
  echo "WARNING: $TAG not found — a copy from before integrity tags; decrypting without that check" >&2
fi

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$ENCRYPTED" -out "$OUT" -pass env:BACKUP_ENCRYPTION_KEY
if command -v pg_restore > /dev/null 2>&1; then
  pg_restore --list "$OUT" > /dev/null || { echo "decrypted, but pg_restore cannot read $OUT" >&2; exit 1; }
  echo "decrypted: $OUT (pg_restore can read it)"
else
  echo "decrypted: $OUT (pg_restore is not installed here, so it was not listed)"
fi
