#!/usr/bin/env python3
# NagarTrace AI gateway: token-gated reverse proxy in front of local Ollama.
# Stdlib-only. Allows ONLY the exact Ollama routes the backend uses
# (chat + tags + show); everything else - including model management - is refused.
import http.server, urllib.request, urllib.error, socket, os, sys

TOKEN_FILE = os.path.expanduser("~/.nagartrace/laptop-ai-token")
UPSTREAM = "http://127.0.0.1:11434"
ALLOWED = {("/api/chat", "POST"), ("/api/tags", "GET"), ("/api/show", "POST")}
# Per-route body caps (endpoint narrowing): only /api/chat ever carries payloads (photos for the
# vision check); the model-info probes are tiny. A body on the wrong route is refused outright.
MAX_BODY_BY_ROUTE = {"/api/chat": 25 * 1024 * 1024, "/api/show": 4 * 1024, "/api/tags": 0}
MAX_BODY = 25 * 1024 * 1024  # absolute ceiling, mirrors MAX_BODY_BY_ROUTE
UPSTREAM_TIMEOUT = 300  # seconds; local inference can be slow, never infinite
CLIENT_TIMEOUT = 60     # seconds; a stalled client cannot hold a thread forever

token = ""
try:
    st = os.stat(TOKEN_FILE)
    if oct(st.st_mode & 0o777) != "0o600":
        os.chmod(TOKEN_FILE, 0o600)
    token = open(TOKEN_FILE).read().strip()
except OSError:
    pass
if not token:
    print("ERROR: missing or empty token file " + TOKEN_FILE + " - run laptop-ai-setup.sh", file=sys.stderr)
    sys.exit(1)
TOKEN = token

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(CLIENT_TIMEOUT)

    def _send(self, code, body, ctype="application/json", close=False):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b)))
        if close:
            self.send_header("connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(b)

    def _reject(self, code, msg):
        # Close the connection on every rejection: an unread request body must
        # never be mistaken for the start of the next request on this socket.
        self._send(code, '{"error":"%s"}' % msg, close=True)

    def _proxy(self):
        try:
            if self.headers.get("authorization") != f"Bearer {TOKEN}":
                return self._reject(401, "unauthorized")
            if (self.path, self.command) not in ALLOWED:
                return self._reject(403, "route_not_allowed")
            if self.headers.get("transfer-encoding", "").lower() not in ("", "identity"):
                return self._reject(411, "content_length_required")
            raw = self.headers.get("content-length")
            body = None
            if raw is not None:
                try:
                    length = int(raw)
                except ValueError:
                    return self._reject(400, "bad_content_length")
                cap = MAX_BODY_BY_ROUTE.get(self.path, 0)
                if length < 0 or length > min(cap, MAX_BODY):
                    return self._reject(413, "body_size_out_of_bounds")
                body = self.rfile.read(length) if length else None
            req = urllib.request.Request(UPSTREAM + self.path, data=body, method=self.command,
                                         headers={"content-type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as r:
                    self._send(r.status, r.read())
            except urllib.error.HTTPError as e:
                self._send(e.code, e.read())
            except Exception:
                self._send(502, '{"error":"upstream_unreachable"}')
        except (socket.timeout, ConnectionError, BrokenPipeError):
            self.close_connection = True
    do_GET = do_POST = _proxy
    def log_message(self, *a): pass

print("gateway on 127.0.0.1:8788 -> 127.0.0.1:11434 (token-gated)", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", 8788), H).serve_forever()
