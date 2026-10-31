#!/usr/bin/env bash
# NagarTrace laptop-AI gateway setup (v3: checks deps, starts gateway+tunnel).
# No secrets in chat: the token is generated locally and pasted ONLY into the
# hand them to your secrets manager via its secure link, never into chat/email.
set -euo pipefail
step() { printf '\n=== %s ===\n' "$1"; }

step "1/7 Dependencies"
MISSING=""
for c in python3 curl openssl ollama cloudflared; do
  command -v "$c" >/dev/null || MISSING="$MISSING $c"
done
if [ -n "$MISSING" ]; then
  echo "Missing:$MISSING"
  echo "Install them (ollama: https://ollama.com/download, cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and re-run."
  exit 1
fi
echo "All present."

step "2/7 Model pulled (accepted: qwen3.5:4b)?"
MODEL="${LAPTOP_AI_MODEL:-qwen3.5:4b}"
if ! ollama list | grep -q "^${MODEL}"; then
  echo "Pulling ${MODEL} (one-time download)..."
  ollama pull "${MODEL}"
fi
ollama list | grep "^${MODEL}"

step "3/7 Vision capability check (photo-check feature)"
CAPS=$(curl -s http://127.0.0.1:11434/api/show -d "{\"model\":\"${MODEL}\"}" || true)
if echo "$CAPS" | grep -q '"vision"'; then
  echo "Model advertises vision: photo check will be ENABLED."
else
  echo "Model has no vision capability: photo check stays HONESTLY OFF (chat/email still work)."
fi

step "4/7 Local gateway token (generated here, never typed into chat)"
mkdir -p "$HOME/.nagartrace"
chmod 700 "$HOME/.nagartrace"
TOKEN_FILE="$HOME/.nagartrace/laptop-ai-token"
if [ ! -f "$TOKEN_FILE" ]; then
  ( umask 077 && openssl rand -hex 32 > "$TOKEN_FILE" )
  echo "Generated token at $TOKEN_FILE (mode 600, dir 700)."
else
  chmod 600 "$TOKEN_FILE"
  if [ ! -s "$TOKEN_FILE" ]; then
    echo "ERROR: $TOKEN_FILE exists but is empty - delete it and re-run."; exit 1
  fi
  echo "Reusing existing non-empty token at $TOKEN_FILE."
fi

step "5/7 Install token-gated gateway"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$DIR/ai-gateway.py" "$HOME/.nagartrace/ai-gateway.py"
echo "Gateway installed at $HOME/.nagartrace/ai-gateway.py"
echo "(Allows ONLY /api/chat, /api/tags, /api/show with the bearer token; threaded; 25MB body cap; 300s upstream timeout.)"

step "6/7 Start gateway + tunnel"
PID_FILE="$HOME/.nagartrace/gateway.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  sleep 1
fi
nohup python3 "$HOME/.nagartrace/ai-gateway.py" > "$HOME/.nagartrace/gateway.log" 2>&1 &
echo $! > "$PID_FILE"
sleep 1
CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8788/api/tags || true)
if [ "$CODE" != "401" ]; then
  echo "ERROR: gateway health check failed (expected 401, got $CODE). See $HOME/.nagartrace/gateway.log"; exit 1
fi
echo "Gateway running (pid $(cat "$PID_FILE")), local auth check OK (401 without token)."
echo "Starting cloudflared quick tunnel (stays in foreground of THIS terminal)..."
echo "Watch for the https://...trycloudflare.com URL below."

step "7/7 Hand values to your secrets manager (secure vault link only, never chat)"
echo "  LAPTOP_AI_URL   = the https://...trycloudflare.com URL (next line)"
echo "  LAPTOP_AI_TOKEN = contents of $TOKEN_FILE"
cloudflared tunnel --url http://127.0.0.1:8788
