# Deploying the bounded Ghost Replay application

This is a self-contained public-demo service for fictional inventory and an authored concurrency fixture. It is not a production incident replayer, a multi-tenant evidence store or a service that runs uploaded programs. The deployable process and release checks are supplied; a live public deployment, hosted service CI and a built container are not claimed by this local milestone.

## Start and check

Requires Node 24.x and Python 3.10+ on Linux/macOS. No runtime npm or pip dependencies are installed. Linux is the container/CI target.

```sh
npm test
PORT=3000 npm start
# In another terminal:
node service/healthcheck.mjs
node service/smoke.mjs
```

Development/preview command:

```sh
npm run dev -- --host 0.0.0.0 --port 4173 --strictPort
PORT=4173 node service/healthcheck.mjs
SMOKE_URL=http://127.0.0.1:4173 node service/smoke.mjs
```

`--port` overrides `PORT`; `--host` accepts `0.0.0.0`, `127.0.0.1` or `::`. Unknown flags, invalid ports and occupied ports fail startup rather than selecting another port. `--strictPort` documents that existing behavior. Static assets are loaded and checked at startup: restart after editing `web/`.

`GET /healthz` returns liveness. `GET /readyz` returns 200 only after all four required web files have been checked and a Python worker has executed the actual buggy/fixed loopback-HTTP fixture self-check. Missing assets, an out-of-root asset symlink, missing Python or failed self-check gives readiness 503. A busy but healthy instance stays ready and reports `busy:true`; admission rejects excess work separately. Readiness is a startup dependency check, not a repeated reproduction on every probe. Health endpoints disclose no paths, credentials or subprocess IDs.

## API contract

`POST /api/run`, uncompressed `application/json` (optional `charset=utf-8`):

```json
{"schedule":["noise:catalog","A:read","B:read","A:commit","B:commit"],"stock":1}
```

Exactly two fields, in either order. Stock is an integer from 0 through 100; booleans, fractional/exponent spellings and string numbers reject. A schedule contains 4..12 strings. Each required `A:read`, `A:commit`, `B:read`, `B:commit` occurs exactly once, with each read preceding its commit. The only optional operations match `noise:[A-Za-z0-9_-]{1,48}`. Duplicate JSON keys, invalid UTF-8, extra keys, nested input objects and any other operation reject. No URL, file, shell command, code, worker path, repetition count or upstream credential can be submitted.

Success returns:

```text
{runId, buggy, fixed, minimization, summary}
```

`buggy` and `fixed` are the actual `core.reproduce()` results, including observed events and complete invariant results. `minimization` is the actual `core.minimize()` result only when the buggy run violates the invariant; otherwise it is null. `runId` is a fresh UUID, distinct from the engine's stable configuration experiment ID. Summary fields are `transport`, `initialStock`, `scheduleSteps`, `buggyViolation`, `fixedViolation`, `removedSteps`, `durationMs` and `claim`. Timing is local request processing, not a Sentry or replay-performance benchmark. Nothing is saved server-side.

Application failures return `{error:{code,message},requestId}` with fixed safe messages. Invalid requests are 400; excessive bytes 413; unsupported media/encoding 415; cross-origin requests 403; wrong method 405. Busy/rate limits return 429, unready/draining service 503, time budget exhaustion 504, and failed/malformed worker output 502. Responses with 429/503 include `Retry-After: 3`. This is retry advice, not a reservation of capacity. Low-level malformed HTTP can instead receive Node's empty 400/408 parser response.

## Hard bounds and cleanup

| Resource | Bound/behavior |
| --- | --- |
| Request body | 16,384 bytes, including chunked transfer; compression rejected |
| JSON | Only the fixed schema above; duplicate keys rejected before execution |
| Headers and connections | 8 KiB header block, 32 header fields, 32 concurrent sockets |
| Body upload | 2 seconds after request admission |
| Experiment worker | At most 8 seconds; no repeated worker retries |
| Admitted request | Absolute 9-second deadline, including upload; process termination escalates after 250 ms |
| Incomplete HTTP headers/request | Node 5-second receive timeout, checked every 500 ms |
| Active operations | One, including body upload and worker cleanup; no waiting queue |
| Rate | Instance-global token bucket, capacity 20, refilling 20 per minute |
| Worker output | 128 KiB stdout, 8 KiB stderr; overflow terminates the worker |
| Static files | Exact `/`, `/index.html`, `/styles.css`, `/app.js`, `/helpers.mjs` allowlist; 256 KiB per file |

Deadlines are enforced by the Node supervisor on a responsive host; they are not a hard real-time guarantee under a suspended kernel or exhausted machine. Work is cancelled on client response-socket closure. SIGTERM/SIGINT marks the service draining, aborts the current job, stops accepting connections and closes idle sockets. Remaining sockets are forced closed after 500 ms. Cancellation and timeout signal the worker process group, escalate to SIGKILL after 250 ms, and wait for the child's close before releasing admission. Surviving same-group descendants are killed even if the leader exits first or its stdio pipes close. The fixed Python worker creates no temporary directories, export files or database. Its loopback servers/threads belong to that disposable process; no state persists after exit. The container uses tini to reap adopted descendants.

This is supervision of trusted packaged code, not an OS sandbox for user programs. Descendants that deliberately detach into another session are outside process-group cleanup; the included worker does not spawn such processes and the API cannot supply executable code. Native Windows supervision is not a supported production target.

The rate budget is global per process, without an unbounded IP map or trust in forwarded headers. It limits this small anonymous demonstration; it is not cross-replica quota enforcement or tenant authentication. Deploy one process per instance. Internet hosting should put TLS, network-level abuse controls, connection limits and deployment resource limits at the hosting boundary. Keep the application free of real incident/customer secrets; no authentication or durable private evidence storage is provided.

## Container and CI release gates

```sh
docker build -t ghost-replay:local .
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=256m --cpus=1 --pids-limit=64 \
  -p 127.0.0.1:3000:3000 ghost-replay:local
```

The version-tagged official Node 24.22.1 Bookworm slim base installs distribution Python and tini, copies only application assets/code, runs as user `node`, and healthchecks `/readyz`. The image writes no application files and supports a read-only root filesystem. Build-time distribution packages receive the repository's current versions, so the Dockerfile alone is not a bit-for-bit build lock; record the successfully built image digest for deployment/rollback.

`.github/workflows/service.yml` runs all tests, builds Docker, checks non-root UID, starts with read-only filesystem/capabilities dropped, waits for readiness, executes a real paired/minimized fixture smoke and checks graceful container exit. The earlier Python-version fixture CI remains intact. Docker is absent locally, so **container build/run and hosted service CI remain release gates**, not completed evidence. Run them before deploying an image; then verify the host's public readiness/API/UI and retain the image digest and host configuration. This milestone does not create hosting, domains, credentials or a public deployment.

## Local evidence and design references

Local checks pass: 23 original engine/evidence tests, 20 HTTP/supervision tests, 7 frontend helper tests. HTTP tests include genuine paired fixture runs, noise minimization, clean controls, malformed/duplicate input, byte/UTF-8 limits, path and symlink isolation, global rate/busy controls, upload/absolute deadlines, subprocess isolation, real stubborn worker cancellation, loopback socket closure, inherited/closed descendant pipes, safe failures and production entrypoint preview flags/SIGTERM. An independent reviewer reproduced the process-group bug, verified the repair and reran the suites.

- [Node HTTP server timeouts and connection lifecycle](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html)
- [Node child process groups and supervision](https://nodejs.org/api/child_process.html)
- [Dockerfile USER and HEALTHCHECK](https://docs.docker.com/reference/dockerfile/)

The server uses Node's maintained HTTP implementation rather than Python's development HTTP server as the public listener. Python's `ThreadingHTTPServer` remains internal to each bounded, ephemeral loopback-only fixture, where its observations are the behavior this application demonstrates.
