#!/usr/bin/env bash
# NagarTrace laptop AI - READ-ONLY, METADATA-ONLY retention/hygiene audit.
# Run on the laptop that hosts the AI gateway. Design rule: NO FILE OR PROCESS CONTENT
# is ever printed - no env values, no config contents, no log lines - so there is no
# redaction to get wrong. Output is existence, sizes, timestamps, counts and names only.
# Nothing is modified; the report stays on the machine until the operator shares it.
set -u
out() { printf '\n== %s ==\n' "$1"; }

out "ollama serve process (presence + age only)"
pgrep -af "ollama serve" >/dev/null && ps -eo pid,etime,comm | grep -i "[o]llama" || echo "no ollama process"

out "OLLAMA_* variable NAMES set in the serve process (values never read)"
pid=$(pgrep -f "ollama serve" | head -1)
if [ -n "${pid:-}" ]; then
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | cut -d= -f1 | grep -E '^OLLAMA_' | sort || echo "cannot read environ"
else
  echo "no serve process"
fi

out "ollama data dir inventory (sizes only, no content)"
for d in "$HOME/.ollama" /usr/share/ollama/.ollama /var/lib/ollama; do
  [ -d "$d" ] && du -sh "$d"/* 2>/dev/null
done

out "prompt-history artifacts (existence + size + mtime only)"
found=0
for f in "$HOME/.ollama/history" "$HOME/.ollama/history.txt"; do
  [ -e "$f" ] && { ls -la "$f"; found=1; }
done
[ "$found" = 0 ] && echo "no CLI prompt-history file (expected for API-only use)"

out "ollama server logs (existence + size + mtime only; contents never read)"
found=0
for f in "$HOME/.ollama/logs/server.log" /var/log/ollama.log /var/log/ollama/*.log; do
  [ -e "$f" ] && { ls -la "$f"; found=1; }
done
[ "$found" = 0 ] && echo "no ollama file logs found; journald check:"
# Metadata ONLY: explicit timestamp FIELD of the newest journal entry, never any line content
# (a log line can hold prompt text). Falls back to a count if the unit is absent.
journalctl -u ollama --no-pager -n 1 -o json --output-fields=__REALTIME_TIMESTAMP 2>/dev/null | grep -o '"__REALTIME_TIMESTAMP":"[0-9]*"' | head -1 || echo "no ollama journal unit"
echo "journal line count (volume hint only): $(journalctl -u ollama --no-pager 2>/dev/null | wc -l)"

out "gateway wrapper (presence + the two facts the privacy claims need)"
pgrep -af "ai-gateway.py" >/dev/null && echo "ai-gateway.py: running" || echo "ai-gateway.py: NOT running"
for f in "$HOME/nagartrace-gateway/ai-gateway.py" "$HOME/ai-gateway.py"; do
  if [ -f "$f" ]; then
    echo "script: $f ($(stat -c '%s bytes, mtime %y' "$f"))"
    c=$(grep -c "def log_message" "$f" 2>/dev/null || echo 0)
    echo "logging suppressed (log_message override present): $([ "$c" -ge 1 ] && echo yes || echo NO - REVIEW)"
    a=$(grep -cE "ALLOWED|allowlist|route_not_allowed" "$f" 2>/dev/null || echo 0)
    echo "route allowlist present: $([ "$a" -ge 1 ] && echo yes || echo NO - REVIEW)"
  fi
done

out "cloudflared tunnel (presence + config existence only)"
pgrep -x cloudflared >/dev/null && echo "cloudflared: running" || echo "cloudflared: NOT running"
# Gateway exposure check: LISTENING ADDRESSES only (metadata). Safe = 127.0.0.1/::1 only;
# any 0.0.0.0 or LAN address here means the gateway bypasses the tunnel - that fails activation.
ss -tlnp 2>/dev/null | grep -E "ai-gateway|ollama|11434|8080" | awk '{print "listener:", $4, $6}' || echo "ss unavailable - binding UNVERIFIED"
for f in "$HOME/.cloudflared/config.yml" /etc/cloudflared/config.yml; do
  [ -f "$f" ] && echo "config exists: $f ($(stat -c 'mtime %y' "$f"))"
done

out "swap + tmp leftovers that could hold prompt bytes"
swapon --show --noheadings 2>/dev/null | wc -l | xargs -I{} echo "active swap devices: {}"
ls /tmp 2>/dev/null | grep -ciE "ollama|gateway" | xargs -I{} echo "ollama/gateway-looking tmp entries: {}"

out "done"
echo "Metadata only: no file contents, env values or log lines were read. Safe to share as-is."

# HONEST SCOPE: this script reads local state and FILTERS it down to metadata before printing;
# raw values are processed on the laptop and never printed into the report. Its findings are
# metadata indicators, NOT proof: a 'log override present' result does not prove logging is
# suppressed, and clean metadata cannot prove zero retention. Treat its output as leads only.
