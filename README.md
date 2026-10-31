# Ghost Replay

A small executable incident laboratory: reproduce a checkout race over real local HTTP, reduce irrelevant fixture actions, and verify a patch against every valid ordering of two requests' read/commit operations.

This is a bounded first prototype inspired by Sentry's debugging workflows. It is independent of Sentry and has **no live Sentry integration**. It does not replay arbitrary production applications.

**Live application:** [ghost-replay.vercel.app](https://ghost-replay.vercel.app/). The browser calls a bounded native Vercel JSON relay; the actual fixture runs on the [Railway backend](https://ghost-replay-production.up.railway.app/readyz). Deployment QA verified the six-step default race: buggy accepts two checkouts with inventory −1, fixed accepts one with inventory 0, and the actual minimizer reduces six steps to four. Persistent appearance also survived a reload.

**Current milestone (2026-10-31):** the fixture and v2 evidence envelope now have an interactive application and bounded HTTP service. The UI runs the actual buggy/fixed Python HTTP fixture and its actual minimizer through a disposable worker, with persistent Light/Dark and system appearance controls. Local checks cover 23 original Python tests, 23 HTTP/service tests, 8 relay transport tests, and 14 frontend tests. Browser capture and live Sentry import remain future work.

## Interactive application

Node 24.x and Python 3.10+ on a POSIX host; no npm/pip runtime packages or credentials are needed.

```sh
npm run dev
# Open http://localhost:3000
npm test
```

`npm start` is the production process entrypoint. It binds `0.0.0.0` and reads `PORT` (default 3000). Preview tooling can use `npm run dev -- --host 0.0.0.0 --port 4173 --strictPort`; ports never silently fall back. `/healthz` is liveness and `/readyz` requires complete static assets plus an actual paired fixture self-check. The service keeps no run database and accepts only the included checkout operations; it cannot replay submitted applications or arbitrary URLs.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the API, limits, cancellation/cleanup, non-root container, CI smoke and live Railway-backend/Vercel-frontend configuration. The service passed hosted container CI; each source update gets a new workflow run. [web/README.md](web/README.md) describes the UI.

## Run

Python 3.10+; no runtime dependencies, accounts, browser installation, API keys, or package installation required.

```sh
python -m ghost_replay demo --repeats 5 --output report.json
python -m unittest discover -s tests -v
python -m ghost_replay reproduce --bundle examples/checkout-race.json
python -m ghost_replay minimize --bundle examples/checkout-race.json
python -m ghost_replay verify --repeats 20
python -m ghost_replay capture --bundle examples/checkout-race.json --output evidence-v2.json
python -m ghost_replay inspect-bundle --bundle evidence-v2.json
python -m ghost_replay export-bundle --bundle evidence-v2.json --output canonical-evidence.json
python -m ghost_replay reproduce --bundle canonical-evidence.json --mode fixed
python -m ghost_replay evidence-demo --repeats 20 --output evidence-report.json
```

Run commands from this repository. `reproduce --mode fixed` executes the patched handler. A reproduced failure is a successful experiment and exits 0; malformed/incomplete input exits 2. `verify` exits 1 if any fixed implementation run violates the invariant. Report paths' parent directories must already exist.

`capture` runs the controlled fixture and emits v2 observations. `inspect-bundle` and `export-bundle` validate without executing an experiment; export preserves the capture and canonicalizes its JSON. A v1 file remains a supported **unsealed recipe** for reproduction or capture. It cannot be silently exported as observed evidence. `verify` always enumerates its built-in schedules and rejects `--bundle`; `--mode` is only supported by capture/reproduce.

## What actually executes

Each experiment starts a `ThreadingHTTPServer` bound only to an ephemeral loopback port. Two concurrent clients POST to separate checkout endpoints. A condition-variable scheduler holds the handlers at named read and commit checkpoints, executing each checkpoint in exactly the specified order. It records what the server actually did.

The buggy handler reads available inventory, crosses an asynchronous boundary represented by the scheduler, and commits using its stale eligibility decision. Both requests can read one available ticket and both succeed, leaving inventory -1. The fixed handler checks and decrements under the same scheduler critical section, so the second request is rejected. No external payment service is contacted. This is a real HTTP race fixture with deliberately controlled interleavings, not a production database benchmark or faithful replay of a real captured outage.

Invariant: inventory must remain nonnegative and accepted reservations must not exceed initial stock. With stock 1, the six valid interleavings contain four vulnerable schedules and two sequential controls. Fixed runs should violate none. Tests also cover zero/two available tickets, malformed inputs, checkpoint timeout, provenance, CLI export, and minimization. The before/after test executes the vulnerable implementation again, ensuring the regression test still catches the original bug.

## Evidence and identity

The example bundle is hand-authored synthetic fixture input. Schedule steps are marked **hypothesis**, initial stock **fixture**, emitted server operations **observed**, and invariant results **derived**. An observed operation's sequence number is the logical ordering in this isolated experiment; it is not a captured production timestamp. JSON reports include a stable SHA-256-derived experiment ID over fixture configuration. It identifies the configuration, not a unique run, code revision, or tamper-proof evidence.

V2 captures add a distinct random capture ID, the SHA-256 of the included fixture engine, a recipe hash, and a checksum of the full evidence document. The importer checks the exact supported schema and verifies that observations, responses, and derived results agree with this finite fixture contract. Source changes fail closed; the importer does not execute a historical source snapshot. See [EVIDENCE.md](EVIDENCE.md) for the format and canonicalization contract.

**Checksums are not signatures or proof of authenticity.** An untrusted producer can construct a self-consistent document and recompute all hashes. “Observed” is an asserted provenance category, not cryptographic evidence that a remote event occurred. Current source matching and internal consistency are narrower checks. This prototype neither reconstructs masked inputs nor verifies arbitrary production telemetry.

The checked-in [v2 example](examples/checkout-evidence-v2.json) was captured from the local synthetic fixture. The measured [evidence demonstration](benchmarks/evidence-demo.json) ran 20 captures plus 20 fixed-handler replays: 20 vulnerable violations, zero fixed violations, 20 distinct capture IDs, and 20 rejected deliberately corrupted envelopes. Its local elapsed time is recorded for reproducibility, not a performance claim.

Only allowlisted operations execute; bundle text is never evaluated as code or sent to arbitrary destinations. No user data, headers, tokens, or source snapshots are collected. Importing real Sentry events and sanitizing arbitrary payloads are future work, not implemented capabilities.

## Minimization and scope

The minimizer removes steps while preserving failure and valid protocol structure. It can remove `noise:` actions, which represent irrelevant test actions with no effect. It cannot delete required reads/commits, infer unknown production inputs, or minimize arbitrary application logic. Its result is explicitly one-step-minimal among valid schedules, not a globally minimal cause. All six read/commit schedules are enumerated by `verify`; that proves only the stated bounded fixture behavior. Scheduling hooks add instrumentation and are not transparent production record/replay.

The included UI and service run only this authored fixture. Browser action recording, rrweb import, a database, distributed cloud workers, patch generation and live Sentry integration remain unimplemented. See [RESEARCH.md](RESEARCH.md) for verified overlap and the next useful scope.
