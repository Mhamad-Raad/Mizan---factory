#!/bin/sh
# Decrypt one backup copy for a restore, checking its integrity tag first (runbook, "Restore").
#
#   BACKUP_ENCRYPTION_KEY=… sh ops/backup/restore-decrypt.sh [--allow-untagged] mizan-<stamp>.dump.enc mizan.dump
#
# Also used by restore-pitr.sh for the files of a base backup (base.tar.gz.enc → base.tar.gz).
#
# Every copy is written with a `<file>.hmac` tag beside it (security review, finding 18), and a
# copy whose tag does not match is refused: it was damaged or altered, and restoring it would
# put that into the ledgers. A copy *without* a tag is refused too — deleting the tag must not be
# a way around the check. `--allow-untagged` decrypts one anyway, for a copy made before tags
# existed or whose tag was lost; the operator says so explicitly, and the copy is then only as
# trustworthy as where it came from.
set -eu

HERE="$(dirname "$0")"
. "$HERE/lib.sh"

USAGE="usage: restore-decrypt.sh [--allow-untagged] <file.enc> <out>"
ALLOW_UNTAGGED=0
if [ "${1:-}" = "--allow-untagged" ]; then
  ALLOW_UNTAGGED=1
  shift
fi
ENCRYPTED="${1:?$USAGE}"
OUT="${2:?$USAGE}"
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
elif [ "$ALLOW_UNTAGGED" = 1 ]; then
  echo "WARNING: $TAG not found — decrypting without an integrity check, as --allow-untagged asked" >&2
else
  echo "REFUSED: $TAG not found, so nothing shows this copy is intact and unaltered." >&2
  echo "Fetch the .hmac file from the same place as the copy and run this again. Only for a copy" >&2
  echo "made before integrity tags, or whose tag is truly lost, add --allow-untagged:" >&2
  echo "  sh ops/backup/restore-decrypt.sh --allow-untagged $ENCRYPTED $OUT" >&2
  exit 1
fi

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$ENCRYPTED" -out "$OUT" -pass env:BACKUP_ENCRYPTION_KEY
case "$OUT" in
  *.gz)
    # A file of a base backup (basebackup.sh): check it is a whole gzip stream.
    gzip -t "$OUT" || { echo "decrypted, but $OUT is not a whole gzip file" >&2; exit 1; }
    echo "decrypted: $OUT (gzip -t passed)"
    ;;
  *)
    if command -v pg_restore > /dev/null 2>&1; then
      pg_restore --list "$OUT" > /dev/null || { echo "decrypted, but pg_restore cannot read $OUT" >&2; exit 1; }
      echo "decrypted: $OUT (pg_restore can read it)"
    else
      echo "decrypted: $OUT (pg_restore is not installed here, so it was not listed)"
    fi
    ;;
esac
