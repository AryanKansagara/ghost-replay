"""Authored fault fixture, never reachable as an HTTP-selected worker."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import signal
import sys
import threading
import time

if "--check" in sys.argv:
    print('{"ready":true}')
    raise SystemExit(0)
sys.stdin.read()
mode = sys.argv[1]
if mode == "invalid":
    print("not JSON")
    raise SystemExit(0)
if mode == "exit":
    print("DO_NOT_DISCLOSE_PRIVATE_PATH_OR_PAYLOAD", file=sys.stderr)
    raise SystemExit(3)
if mode == "flood":
    print("x" * 150_000)
    raise SystemExit(0)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
Path(mode).write_text(json.dumps({"port": server.server_port}))
signal.signal(signal.SIGTERM, signal.SIG_IGN)  # Exercise the bounded SIGKILL fallback.
while True:
    time.sleep(1)
