#!/bin/sh
# The pre-paint script must be inline — it has to run before any module loads — so the CSP
# of section 2.13 allows it by hash rather than by 'unsafe-inline'. This prints the hash to
# put in MIZAN_CSP_INLINE_HASH; run it whenever that script changes, and CI checks it.
set -eu
FILE="${1:-apps/web/index.html}"
SCRIPT="$(awk '/<script>/{flag=1;next}/<\/script>/{flag=0}flag' "$FILE")"
printf 'sha256-%s\n' "$(printf '%s' "$SCRIPT" | openssl dgst -sha256 -binary | openssl base64)"
