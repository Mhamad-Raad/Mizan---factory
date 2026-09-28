#!/bin/sh
# Prints the CSP hashes of the page's inline scripts (the pre-paint script and the service
# worker's registration). The web image computes them itself at build time and writes them
# into its Caddyfile, so nothing has to be copied by hand; this is for looking.
set -eu
exec node "$(dirname "$0")/csp-hashes.mjs" "${1:-apps/web/dist/index.html}"
