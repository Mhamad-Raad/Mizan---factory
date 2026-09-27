#!/bin/sh
# Shared by backup.sh, cron.sh and restore-decrypt.sh.

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

# Prints the tag line for a file: "hmac-sha256-v2 <hex>".
mac_of() {
  key="$(mac_key)"
  [ -n "$key" ] || return 1
  tag="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key" -r "$1" | cut -d' ' -f1)"
  [ -n "$tag" ] || return 1
  echo "hmac-sha256-v2 $tag"
}
