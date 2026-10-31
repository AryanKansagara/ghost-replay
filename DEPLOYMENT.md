# Deploying the bounded Ghost Replay application

This is a self-contained public-demo service for fictional inventory and an authored concurrency fixture. It is not a production incident replayer, a multi-tenant evidence store or a service that runs uploaded programs. The application is live at **https://ghost-replay.vercel.app/** with its actual engine on Railway. The previous service revision passed hosted tests, a Docker build and actual non-root/read-only container smoke; source updates get a new workflow run.

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

## Railway backend and Vercel frontend

The persistent Node/Python process belongs in the Docker backend. It must not be treated as a Vercel static asset or assumed to run unchanged inside a Vercel function. `railway.json` selects the repository's Dockerfile, one replica, `/readyz`, a 60-second startup healthcheck allowance, bounded failure restarts, no requested rollout overlap and a 10-second termination grace. Do not override the image entrypoint/CMD: tini and the Node supervisor handle worker cleanup. Railway supplies `PORT`; the service listens on it at `0.0.0.0`. No database or volume is required. Per-instance admission/rate budgets require one instance; adding replicas changes the effective aggregate budget.

The Railway backend is deployed at `https://ghost-replay-production.up.railway.app`. In static `vercel.json`, the specific `/api/run` rule comes first and resolves to the native function `/api/experiment`; the generic API and health rewrites retain the actual backend origin. **`BACKEND_ORIGIN` is no longer required on Vercel.** The rejected programmatic `vercel.ts` has been removed so a Git deployment receives literal `destination` strings. The build command remains `node scripts/build-frontend.mjs` and output remains `dist/`; the builder packages only four browser assets. `api/experiment.mjs` is deployed separately as a native Node function; Python and the fixture supervisor remain on Railway. A future backend-domain change requires an explicit configuration update and redeployment.

### Bounded JSON relay

The native Vercel handler uses the standalone `{fetch: POST}` Web Request/Response entrypoint. It accepts only POST JSON with a 16 KiB byte limit, forwards the original JSON text to the fixed Railway `/api/run` endpoint, and sends only four declared headers: JSON Content-Type/Accept, identity Accept-Encoding, and the exact production frontend Origin. It does not forward browser cookies, authentication, request compression, forwarded-host metadata or arbitrary client headers. The existing Railway schema and actual engine remain authoritative.

The relay reads at most 256 KiB of upstream bytes, requires valid UTF-8 JSON and creates a fresh `Response.json` result with the upstream status. It never copies upstream Content-Encoding, Content-Length, Transfer-Encoding or Set-Cookie. Safe numeric Retry-After values are preserved. This addresses the observed browser/proxy transport boundary rather than substituting an invented result: direct backend browser runs worked while the original external POST rewrite could return an unreadable response. A 12-second relay deadline and `request.signal` propagate cancellation; the function is configured for cancellation with a 15-second platform maximum. Invalid/oversized/non-JSON upstream replies return bounded structured errors.

Live production browser QA confirmed the relay path with actual run `d272ce89-ee7d-4360-9df6-d8548b32e6fe`: six input operations, buggy accepted 2/inventory −1, fixed accepted 1/inventory 0, and an actual four-operation minimized witness. Dark appearance persisted on reload. These are observed results for the controlled fixture, not a general production replay claim.

**`PUBLIC_ORIGIN` on Railway is `https://ghost-replay.vercel.app`.** This optional startup setting is one exact, canonical HTTPS DNS origin; an explicit nondefault port is permitted. No trailing slash, path, query, fragment, username/password, wildcard, list, whitespace or ambiguous hostname is accepted. Invalid values stop startup before opening a listener and emit a fixed configuration error without echoing the supplied value. With the setting absent, only direct same-origin browser requests are accepted.

The backend compares a supplied `Origin` against the exact configured public origin or the direct request's `Host` authority. It never grants origin permission from `Forwarded`/`X-Forwarded-*`. `Sec-Fetch-Site: cross-site` is accepted only when `Origin` exactly equals `PUBLIC_ORIGIN`; missing or unrelated origins still fail. This exception supports the explicitly configured frontend/proxy boundary. No wildcard CORS or preflight API is added: the browser continues to call its own Vercel `/api/run` URL and Vercel performs the server-side rewrite. Direct cross-origin browser fetches to Railway are not the deployment design.

Preview domains are intentionally not wildcard-allowed. A different preview frontend needs its exact origin configured on a separate backend or an explicit operator change; it does not automatically inherit production origin permission. Use the stable production frontend origin for the production backend.

Before declaring the split deployment complete, verify the actual Vercel root/assets, proxied readiness, a failing paired race with a real minimized witness, a clean sequential control, and explicit rejection of a nonallowed origin at the backend. Preserve the tested Git commit and built image digest. Configure any resource/spend limits and platform credentials through the provider; the source files neither provision a service nor bypass account approval.

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

Deadlines are enforced by the Node supervisor on a responsive host; they are not a hard real-time guarantee under a suspended kernel or exhausted machine. Work is cancelled on client response-socket closure. SIGTERM/SIGINT marks the service draining, aborts the current job, stops accepting connections and closes idle sockets. Remaining sockets are forced closed after 500 ms. Cancellation and timeout signal the worker process group and escalate to SIGKILL after 250 ms. Before releasing admission, the supervisor waits for the child's close and a bounded 400 ms group-stop barrier: on Linux it checks `/proc` group membership until no member is executing (zombies have already closed descriptors). Surviving same-group descendants are killed even if the leader exits first or its stdio pipes close. A failed/inaccessible cleanup check marks the runner unhealthy, drops readiness and rejects further experiments until restart. The configured admission/termination/inspection budgets total at most 9.65 seconds on a responsive host. The fixed Python worker creates no temporary directories, export files or database. Its loopback servers/threads belong to that disposable process; no state persists after exit. The container uses tini to reap adopted descendants.

This is supervision of trusted packaged code, not an OS sandbox for user programs. Descendants that deliberately detach into another session are outside process-group cleanup; the included worker does not spawn such processes and the API cannot supply executable code. Linux process metadata must be readable and match the caller's PID namespace. A mismatched `/proc/self` identity or other POSIX host conservatively waits for the process group to disappear and may become unready if orphan zombies are not promptly reaped. The local execution sandbox has mismatched PID/proc views, so its tests check socket closure and fail-closed behavior rather than inferring descendant liveness from unrelated host PIDs; hosted Linux CI retains strict matching-namespace assertions. Linux is the container target. Native Windows supervision is not a supported production target.

The rate budget is global per process, without an unbounded IP map or trust in forwarded headers. It limits this small anonymous demonstration; it is not cross-replica quota enforcement or tenant authentication. Deploy one process per instance. Internet hosting should put TLS, network-level abuse controls, connection limits and deployment resource limits at the hosting boundary. Keep the application free of real incident/customer secrets; no authentication or durable private evidence storage is provided.

## Container and CI release gates

```sh
docker build -t ghost-replay:local .
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=256m --cpus=1 --pids-limit=64 \
  -p 127.0.0.1:3000:3000 ghost-replay:local
```

The version-tagged official Node 24.22.1 Bookworm slim base installs distribution Python and tini, copies only application assets/code, runs as user `node`, and healthchecks `/readyz`. The image writes no application files and supports a read-only root filesystem. Build-time distribution packages receive the repository's current versions, so the Dockerfile alone is not a bit-for-bit build lock; record the successfully built image digest for deployment/rollback.

`.github/workflows/service.yml` runs all tests, builds Docker, checks non-root UID, starts with read-only filesystem/capabilities dropped, waits for readiness, executes a real paired/minimized fixture smoke and checks graceful container exit. The earlier Python-version fixture CI remains intact. Docker is absent locally, so each revision's hosted container build/run remains a release gate; the prior source revision passed this gate. Verify the new head's workflows before deploying, then verify the actual public readiness/API/UI and retain the image digest and host configuration. These files do not create hosting, domains, credentials or a public deployment.

## Local evidence and design references

Local checks cover 23 original engine/evidence tests, 23 HTTP/supervision tests, 8 relay transport tests, and 14 frontend helper/appearance tests. Relay tests exercise actual gzip HTTP decoding, fresh header normalization, fixed upstream selection, preservation of strict backend input semantics, request/response bounds, safe upstream errors, Retry-After, cancellation and deadline behavior. HTTP tests include genuine paired fixture runs, noise minimization, clean controls, malformed/duplicate input, byte/UTF-8 limits, path and symlink isolation, global rate/busy controls, upload/absolute deadlines, subprocess isolation, real stubborn worker cancellation, loopback socket closure, inherited/closed descendant pipes, safe failures, production entrypoint preview flags/SIGTERM, canonical public-origin configuration, forwarded-header negative controls and invalid-origin startup refusal. An independent reviewer reproduced the process-group bug, verified the repair and reran the suites.

- [Node HTTP server timeouts and connection lifecycle](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html)
- [Node child process groups and supervision](https://nodejs.org/api/child_process.html)
- [Dockerfile USER and HEALTHCHECK](https://docs.docker.com/reference/dockerfile/)
- [Railway configuration schema and reference](https://docs.railway.com/config-as-code/reference)
- [Railway deployment healthchecks and injected PORT](https://docs.railway.com/deployments/healthchecks)

The server uses Node's maintained HTTP implementation rather than Python's development HTTP server as the public listener. Python's `ThreadingHTTPServer` remains internal to each bounded, ephemeral loopback-only fixture, where its observations are the behavior this application demonstrates.
