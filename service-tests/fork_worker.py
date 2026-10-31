"""Supervision regression: descendants outliving a successful direct child."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import sys
import time

if "--check" in sys.argv:
    print('{"ready":true}')
    raise SystemExit(0)
sys.stdin.read()
record = Path(sys.argv[1])
pid = os.fork()
if pid == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    record.write_text(json.dumps({"port": server.server_port, "pid": os.getpid()}))
    if sys.argv[2] == "closed":
        os.close(1)
        os.close(2)
    time.sleep(30)
    os._exit(0)
for _ in range(100):
    if record.exists():
        break
    time.sleep(0.01)
print('{"buggy":{"result":{"complete":true}},"fixed":{"result":{"complete":true}},"minimization":null}', flush=True)
os._exit(0)
