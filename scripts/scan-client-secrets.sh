#!/bin/sh
# Scan CLIENT build output (web dist / mobile bundle source) for patterns that must
# never ship to a client. Server-only secrets live in the API env; the web app and
# the mobile app must not embed them. Exit 1 on any hit.
# Usage: scan-client-secrets.sh <path> [<path>...]
set -u
fail=0
for p in "$@"; do
  [ -e "$p" ] || continue
  hits=$(grep -rEl 'GEMINI_API_KEY|generativelanguage\.googleapis\.com|AIza[0-9A-Za-z_-]{20,}|SUPABASE_SERVICE_ROLE|service_role.key|LAPTOP_AI_TOKEN|BEGIN [A-Z ]*PRIVATE KEY' "$p" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "FORBIDDEN pattern in client output:" >&2
    echo "$hits" >&2
    fail=1
  fi
done
if [ "$fail" = 1 ]; then exit 1; fi
echo "clean: no forbidden patterns in $*"
