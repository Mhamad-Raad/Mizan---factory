#!/bin/sh
# Shared by backup.sh, basebackup.sh, wal-sync.sh, cron.sh and the restore scripts.

# Where the backup container keeps its work and its memory. Both live on the `backup-staging`
# volume, so a restarted container neither repeats nor skips a night: the state files say which
# day last succeeded, when the last base backup was taken and which WAL files have left the host.
STAGING="${BACKUP_STAGING:-/var/backups/mizan}"
STATE_DIR="$STAGING/state"

# The off-site copy is not optional (spec 2.13, NFR-08): a backup that stays on the host it is
# meant to survive is not a backup. Refuse loudly rather than log a warning nobody reads.
require_offsite() {
  command -v aws > /dev/null 2>&1 ||
    { echo "off-site upload is impossible: the aws client is not installed in this image (build ops/docker/Dockerfile.backup)"; return 1; }
  [ -n "${BACKUP_BUCKET:-}" ] ||
    { echo "off-site upload is not configured: BACKUP_BUCKET is empty"; return 1; }
  command -v openssl > /dev/null 2>&1 ||
    { echo "cannot encrypt: openssl is not installed in this image (build ops/docker/Dockerfile.backup)"; return 1; }
  return 0
}

# An empty AWS_ENDPOINT_URL is not "no endpoint" to the aws client: it tries to use the empty
# string and plain S3 fails. compose.yml passes the variable through even when .env leaves it
# blank, so drop it here unless it names a store.
[ -n "${AWS_ENDPOINT_URL:-}" ] || unset AWS_ENDPOINT_URL

# Encrypt-then-MAC (security review, finding 18). `openssl enc -aes-256-cbc` detects neither a
# flipped bit nor a truncated file, so every encrypted copy gets an HMAC-SHA256 tag beside it.
#
# The MAC key is stretched from the backup passphrase with PBKDF2 — 200,000 rounds, like the
# encryption key — so a stolen tag is no quicker a way to guess the passphrase than the copy
# itself. It is kept apart from the encryption key by a different digest (SHA-512, where the
# encryption uses SHA-256) and a fixed salt of its own ("mizanmac"; each copy's encryption salt
# is random). `openssl enc -P` derives it without encrypting anything, reading the passphrase
# from the environment, so the passphrase is never on a command line. The derived key is, for
# the moment the HMAC runs, because openssl takes a MAC key no other way; it opens nothing but
# the tags, and anyone who can read this container's process list can read its environment.
MAC_SALT_HEX=6d697a616e6d6163
mac_key() {
  : "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set}"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha512 -S "$MAC_SALT_HEX" \
    -pass env:BACKUP_ENCRYPTION_KEY -P | sed -n 's/^key=//p'
}

# Prints the tag line for a file: "hmac-sha256-v2 <hex>". The key may be passed in, so a run
# that tags hundreds of WAL files stretches the passphrase once, not once per file.
mac_of() {
  key="${2:-$(mac_key)}"
  [ -n "$key" ] || return 1
  tag="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key" -r "$1" | cut -d' ' -f1)"
  [ -n "$tag" ] || return 1
  echo "hmac-sha256-v2 $tag"
}

# Encrypts <in> to <out> and writes <out>.hmac beside it — the one way anything is prepared to
# leave the host: the nightly dump, each file of a base backup, each WAL segment.
encrypt_and_tag() {
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -in "$1" -out "$2" -pass env:BACKUP_ENCRYPTION_KEY || return 1
  mac_of "$2" "${3:-}" > "$2.hmac" || { rm -f "$2.hmac"; return 1; }
  [ -s "$2.hmac" ]
}

# 0 when <file>.hmac exists and matches <file>; 1 otherwise (a missing tag is a failure too).
tag_matches() {
  [ -f "$1.hmac" ] || return 1
  [ "$(cat "$1.hmac")" = "$(mac_of "$1" "${2:-}")" ]
}

# --- scheduling (cron.sh) ------------------------------------------------------------------
# Kept here as plain functions of their inputs, so the decision can be tested with any clock.

# Is the nightly run due? <today YYYY-MM-DD> <now HHMM> <last successful day, or empty>.
# Due once per Baghdad day, at or after BACKUP_AT (03:00): a container that was down at 03:00
# runs as soon as it is back, and one restarted after a successful night does not run again.
nightly_due() {
  [ "$1" != "${3:-}" ] || return 1
  # "x" prefixes make expr compare the four digits as text, which for HHMM is their order.
  expr "x$2" '>=' "x${BACKUP_AT:-0300}" > /dev/null
}

# Seconds to wait after the <n>th failed attempt of a night: 15 min, 30, 60, then every 2 h.
retry_delay() {
  delay=900
  n="$1"
  while [ "$n" -gt 1 ] && [ "$delay" -lt 7200 ]; do
    delay=$((delay * 2))
    n=$((n - 1))
  done
  [ "$delay" -le 7200 ] || delay=7200
  echo "$delay"
}

# Is a physical base backup due? <today YYYY-MM-DD> <day of the last one, or empty>.
# Weekly (BASE_BACKUP_EVERY_DAYS, 7). Counted from the last one that succeeded, so a failed week
# is retried the next night instead of waiting another seven days.
base_due() {
  [ -n "${2:-}" ] || return 0
  now_s="$(date -d "$1" +%s)" || return 0
  then_s="$(date -d "$2" +%s)" || return 0
  [ $(((now_s - then_s) / 86400)) -ge "${BASE_BACKUP_EVERY_DAYS:-7}" ]
}

# Reads names on stdin and prints the WAL files (segments and .backup files, plain or
# encrypted) that come before segment <cutoff>. Like pg_archivecleanup, the timeline (the first
# eight characters) is ignored; timeline history files (`*.history`) are never printed — they are
# tiny, and a restore past a promotion needs every one of them.
wal_before() {
  awk -v cut="$1" '
    length($0) >= 24 && substr($0, 1, 24) !~ /[^0-9A-F]/ {
      if ((substr($0, 9, 16) "") < (substr(cut, 9, 16) "")) print
    }'
}

state_read() { cat "$STATE_DIR/$1" 2> /dev/null || true; }
state_write() {
  mkdir -p "$STATE_DIR"
  echo "$2" > "$STATE_DIR/$1.tmp" && mv "$STATE_DIR/$1.tmp" "$STATE_DIR/$1"
}
