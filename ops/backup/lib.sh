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

# Encrypt-then-MAC (security review, finding 18). `openssl enc -aes-256-cbc` detects neither a
# flipped bit nor a truncated file, so every encrypted copy gets an HMAC-SHA256 tag beside it,
# under a key derived from the backup passphrase but different from the encryption key.
mac_key() {
  printf '%s' "mizan-backup-mac-v1:${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set}" |
    openssl dgst -sha256 -r | cut -d' ' -f1
}

# Prints the tag line for a file: "hmac-sha256-v1 <hex>".
mac_of() {
  tag="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(mac_key)" -r "$1" | cut -d' ' -f1)"
  [ -n "$tag" ] || return 1
  echo "hmac-sha256-v1 $tag"
}
