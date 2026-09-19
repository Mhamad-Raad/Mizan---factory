#!/bin/sh
# PostgreSQL archive_command. Called for every completed WAL segment; with
# archive_timeout=900 this bounds data loss at fifteen minutes, which is the recovery point
# objective of NFR-08.
#
# It must exit non-zero if the segment was not stored, or PostgreSQL will consider it
# archived and recycle it — the single most common way WAL archiving silently fails.
set -eu
SOURCE="$1"
NAME="$2"
DESTINATION="${WAL_ARCHIVE_DIR:-/wal-archive}"

mkdir -p "$DESTINATION"
[ -f "$DESTINATION/$NAME" ] && exit 0

cp "$SOURCE" "$DESTINATION/$NAME.tmp"
sync "$DESTINATION/$NAME.tmp" 2>/dev/null || true
mv "$DESTINATION/$NAME.tmp" "$DESTINATION/$NAME"
