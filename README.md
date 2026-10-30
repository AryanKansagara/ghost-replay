# Ghost Replay

A small executable incident laboratory: reproduce a checkout race over real local HTTP, reduce irrelevant fixture actions, and verify a patch against every valid ordering of two requests' read/commit operations.

This is a bounded first prototype inspired by Sentry's debugging workflows. It is independent of Sentry and has **no live Sentry integration**. It does not replay arbitrary production applications.

## Run

Python 3.10+; no runtime dependencies, accounts, browser installation, API keys, or package installation required.

```sh
python -m ghost_replay demo --repeats 5 --output report.json
python -m unittest discover -s tests -v
python -m ghost_replay reproduce --bundle examples/checkout-race.json
python -m ghost_replay minimize --bundle examples/checkout-race.json
python -m ghost_replay verify --repeats 20
```

Run commands from this repository. `reproduce --mode fixed` executes the patched handler. A reproduced failure is a successful experiment and exits 0; malformed/incomplete input exits 2. `verify` exits 1 if any fixed implementation run violates the invariant. Report paths' parent directories must already exist.

## What actually executes

Each experiment starts a `ThreadingHTTPServer` bound only to an ephemeral loopback port. Two concurrent clients POST to separate checkout endpoints. A condition-variable scheduler holds the handlers at named read and commit checkpoints, executing each checkpoint in exactly the specified order. It records what the server actually did.

The buggy handler reads available inventory, crosses an asynchronous boundary represented by the scheduler, and commits using its stale eligibility decision. Both requests can read one available ticket and both succeed, leaving inventory -1. The fixed handler checks and decrements under the same scheduler critical section, so the second request is rejected. No external payment service is contacted. This is a real HTTP race fixture with deliberately controlled interleavings, not a production database benchmark or faithful replay of a real captured outage.

Invariant: inventory must remain nonnegative and accepted reservations must not exceed initial stock. With stock 1, the six valid interleavings contain four vulnerable schedules and two sequential controls. Fixed runs should violate none. Tests also cover zero/two available tickets, malformed inputs, checkpoint timeout, provenance, CLI export, and minimization. The before/after test executes the vulnerable implementation again, ensuring the regression test still catches the original bug.

## Evidence and identity

The example bundle is hand-authored synthetic fixture input. Schedule steps are marked **hypothesis**, initial stock **fixture**, emitted server operations **observed**, and invariant results **derived**. An observed operation's sequence number is the logical ordering in this isolated experiment; it is not a captured production timestamp. JSON reports include a stable SHA-256-derived experiment ID over fixture configuration. It identifies the configuration, not a unique run, code revision, or tamper-proof evidence.

Only allowlisted operations execute; bundle text is never evaluated as code or sent to arbitrary destinations. No user data, headers, tokens, or source snapshots are collected. Importing real Sentry events and sanitizing arbitrary payloads are future work, not implemented capabilities.

## Minimization and scope

The minimizer removes steps while preserving failure and valid protocol structure. It can remove `noise:` actions, which represent irrelevant test actions with no effect. It cannot delete required reads/commits, infer unknown production inputs, or minimize arbitrary application logic. Its result is explicitly one-step-minimal among valid schedules, not a globally minimal cause. All six read/commit schedules are enumerated by `verify`; that proves only the stated bounded fixture behavior. Scheduling hooks add instrumentation and are not transparent production record/replay.

No UI, browser action recorder, rrweb reader, database, cloud worker, patch generator, or deployment is included yet. See [RESEARCH.md](RESEARCH.md) for verified overlap and the next useful scope.
