#!/usr/bin/env bash
# NagarTrace laptop AI - READ-ONLY retention/hygiene audit.
# Run on the laptop that hosts the AI gateway. Collects facts needed to verify the
# privacy notice's claims. NO secrets are printed: tokens are redacted, nothing is
# modified, nothing leaves the machine except the report the operator chooses to share.
set -u
out() { printf '\n== %s ==\n' "$1"; }
redact() { sed -E 's/(token|TOKEN|password|PASSWORD|secret|SECRET)("? *[:=]"? *)[A-Za-z0-9._-]+/\1\2<redacted>/g'; }

out "ollama processes (cmdline, no env)"
ps -eo pid,etime,args | grep -i "[o]llama" || echo "no ollama process"

out "ollama environment (redacted)"
( tr '\0' '\n' < /proc/"$(pgrep -f 'ollama serve' | head -1)"/environ 2>/dev/null || echo "cannot read" ) \
  | grep -E '^OLLAMA_' | redact || true

out "ollama data dir inventory (sizes only, no content)"
for d in "$HOME/.ollama" /usr/share/ollama/.ollama /var/lib/ollama; do
  [ -d "$d" ] && du -sh "$d"/* 2>/dev/null
done

out "prompt history files (existence + size only)"
for f in "$HOME/.ollama/history" "$HOME/.ollama/history.txt" "$HOME/.ollama/logs" ; do
  [ -e "$f" ] && ls -la "$f"
done
echo "(absence above = no prompt history persisted by the CLI)"

out "ollama server log location + tail metadata (size/mtime only)"
journalctl --user -u ollama --no-pager -n 0 2>/dev/null | head -1 || true
for f in "$HOME/.ollama/logs/server.log" /var/log/ollama*.log; do
  [ -e "$f" ] && ls -la "$f"
done

out "gateway wrapper process + open config"
ps -eo pid,etime,args | grep -E "[a]i-gateway.py" || echo "ai-gateway.py not running"
for f in "$HOME/nagartrace-gateway/ai-gateway.py" "$HOME/ai-gateway.py"; do
  [ -f "$f" ] && { echo "found: $f"; grep -nE "log|LOG" "$f" | redact; }
done

out "cloudflared tunnel config (route only, secrets redacted)"
ps -eo pid,args | grep -E "[c]loudflared" | redact || echo "cloudflared not running"
for f in "$HOME/.cloudflared/config.yml" /etc/cloudflared/config.yml; do
  [ -f "$f" ] && { echo "found: $f"; redact < "$f"; }
done

out "swap and tmp leftovers that could hold prompt bytes"
swapon --show 2>/dev/null || free -h | grep -i swap
ls -la /tmp/ 2>/dev/null | grep -iE "ollama|gateway" || echo "no ollama/gateway tmp files"

out "done"
echo "Review this report yourself before sharing it. It contains paths and sizes only; tokens were redacted."
