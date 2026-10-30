"""Explicitly scheduled HTTP checkout fixture; not arbitrary production replay."""
from __future__ import annotations

import hashlib
import itertools
import json
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ExperimentError(ValueError):
    pass


def validate(schedule, stock):
    if type(stock) is not int or not 0 <= stock <= 100:
        raise ExperimentError("stock must be an integer between 0 and 100")
    if not isinstance(schedule, list) or not 1 <= len(schedule) <= 100:
        raise ExperimentError("schedule must contain 1..100 steps")
    required = {f"{r}:{phase}" for r in ("A", "B") for phase in ("read", "commit")}
    if any(not isinstance(s, str) or (s not in required and not s.startswith("noise:")) for s in schedule):
        raise ExperimentError("unknown operation; expected A/B read/commit or noise:<label>")
    for step in required:
        if schedule.count(step) != 1:
            raise ExperimentError(f"schedule must contain exactly one {step}")
    for r in ("A", "B"):
        if schedule.index(f"{r}:read") > schedule.index(f"{r}:commit"):
            raise ExperimentError("read must precede commit for each request")


def schedules():
    steps = ["A:read", "A:commit", "B:read", "B:commit"]
    return [list(p) for p in itertools.permutations(steps)
            if p.index("A:read") < p.index("A:commit") and p.index("B:read") < p.index("B:commit")]


class Scheduler:
    def __init__(self, schedule, timeout):
        self.schedule = schedule
        self.timeout = timeout
        self.condition = threading.Condition()
        self.position = 0
        self.events = []
        self.aborted = False

    def record(self, operation, **values):
        self.events.append({"sequence": len(self.events), "operation": operation,
                            "provenance": "observed", "source": "local-http-checkout",
                            **values})

    def consume_noise(self):
        while self.position < len(self.schedule) and self.schedule[self.position].startswith("noise:"):
            self.record(self.schedule[self.position], effect="none")
            self.position += 1

    def step(self, operation, action):
        deadline = time.monotonic() + self.timeout
        with self.condition:
            while True:
                self.consume_noise()
                if self.aborted:
                    raise ExperimentError("schedule aborted")
                if self.position < len(self.schedule) and self.schedule[self.position] == operation:
                    result = action()
                    self.record(operation, **result)
                    self.position += 1
                    self.consume_noise()
                    self.condition.notify_all()
                    return result
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.aborted = True
                    self.condition.notify_all()
                    raise ExperimentError(f"timeout waiting for {operation}")
                self.condition.wait(remaining)


def reproduce(schedule, *, mode="buggy", stock=1, timeout=3.0):
    """Run two real concurrent HTTP clients with test-only server checkpoints."""
    validate(schedule, stock)
    if mode not in {"buggy", "fixed"}:
        raise ExperimentError("mode must be buggy or fixed")
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 30:
        raise ExperimentError("timeout must be positive and <= 30 seconds")
    scheduler = Scheduler(list(schedule), timeout)
    state = {"stock": stock}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            request_id = self.path.removeprefix("/checkout/")
            if self.path not in {"/checkout/A", "/checkout/B"}:
                self.send_error(404)
                return
            try:
                snapshot = scheduler.step(f"{request_id}:read", lambda: {"inventory": state["stock"]})["inventory"]

                def commit():
                    before = state["stock"]
                    # Vulnerability: an authorization await separates read and write.
                    eligible = snapshot >= 1 if mode == "buggy" else before >= 1
                    if eligible:
                        state["stock"] -= 1
                    return {"accepted": eligible, "inventory_before": before, "inventory_after": state["stock"]}

                outcome = scheduler.step(f"{request_id}:commit", commit)
                payload = json.dumps(outcome).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except ExperimentError as exc:
                self.send_error(503, str(exc))

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()

    def send(request_id):
        request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/checkout/{request_id}", data=b"", method="POST")
        # Do not inherit proxy configuration for the loopback-only fixture.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=timeout + 1) as response:
            return json.load(response)

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {r: executor.submit(send, r) for r in ("A", "B")}
            responses = {r: future.result() for r, future in futures.items()}
    except Exception as exc:
        raise ExperimentError(f"HTTP experiment incomplete: {exc}") from exc
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)
    accepted = sum(r["accepted"] for r in responses.values())
    violated = state["stock"] < 0 or accepted > stock
    identity = json.dumps({"schema_version": 1, "schedule": schedule, "stock": stock, "mode": mode}, sort_keys=True)
    return {"schema_version": 1, "experiment_id": hashlib.sha256(identity.encode()).hexdigest()[:16],
            "fixture": {"stock": stock, "provenance": "fixture"}, "mode": mode,
            "schedule": {"steps": list(schedule), "provenance": "hypothesis", "source": "operator-controlled schedule"},
            "transport": "real loopback HTTP", "events": scheduler.events, "responses": responses,
            "result": {"provenance": "derived", "accepted": accepted, "final_inventory": state["stock"],
                       "invariant_violated": violated, "complete": scheduler.position == len(schedule)}}


def minimize(schedule, *, stock=1):
    """Greedy one-step-minimal reduction, preserving required protocol operations."""
    current = list(schedule)
    if not reproduce(current, stock=stock)["result"]["invariant_violated"]:
        raise ExperimentError("input schedule does not reproduce the invariant violation")
    trials = 0
    changed = True
    while changed:
        changed = False
        for i in range(len(current)):
            candidate = current[:i] + current[i + 1:]
            try:
                validate(candidate, stock)
            except ExperimentError:
                continue
            trials += 1
            if reproduce(candidate, stock=stock)["result"]["invariant_violated"]:
                current = candidate
                changed = True
                break
    return {"original_steps": len(schedule), "minimal_steps": len(current), "schedule": current,
            "trials": trials, "minimality": "one-step-minimal among valid fixture schedules; not globally minimal"}


def verify(*, repeats=5):
    if type(repeats) is not int or not 1 <= repeats <= 100:
        raise ExperimentError("repeats must be an integer between 1 and 100")
    rows = []
    for schedule in schedules():
        row = {"schedule": schedule, "repeats": repeats}
        for mode in ("buggy", "fixed"):
            row[mode + "_violations"] = sum(reproduce(schedule, mode=mode)["result"]["invariant_violated"] for _ in range(repeats))
        rows.append(row)
    return {"schema_version": 1, "schedule_count": len(rows), "repeats": repeats,
            "total_runs": len(rows) * repeats * 2, "rows": rows,
            "fixed_violations": sum(r["fixed_violations"] for r in rows),
            "claim": "bounded fixture schedule coverage; not proof of general concurrency correctness"}
