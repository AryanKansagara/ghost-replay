# Ghost Replay deployment

Ghost Replay is a private trace workspace for replaying a user's **public HTTPS GET/HEAD** requests and comparing fresh responses with imported baselines and explicit assertions. The older checkout concurrency fixture remains a separate `/api/run` laboratory; its events and minimization do not represent a real imported trace. Source changes here require deployment and end-to-end QA before being called live.

## Runtime and persistent storage

Requires pinned Node 24.22.1 (built-in `node:sqlite`) and Python 3.10+ for the secondary lab. No runtime npm/pip dependencies. Run `npm test`, then `npm run dev` for localhost:3000; preview flags `-- --host 0.0.0.0 --port 4173 --strictPort` are supported. `PORT` supplies the production port. `npm start` uses the privilege-checking launcher; development starts main directly.

`DATA_DIR` selects the durable SQLite directory. With no setting, local development uses `.ghost-data/`. An explicitly configured unusable directory fails startup; there is no temporary-directory fallback. Readiness requires initialized storage, checked static assets and the existing fixture self-check. `/healthz` is liveness, `/readyz` readiness. The storage path/database cannot be symlinks. Directory mode is0700, database0600; capability tokens are hashed with SHA-256 at rest. Data is private by possession of a 256-bit token, **not user-account authentication or encryption at rest**. Losing the token loses access; copying it grants full workspace access. Provider volume access/backup access remains privileged.

Railway: retain the Dockerfile/`railway.json`, one instance, persistent volume at `/data`; configure:

```text
DATA_DIR=/data/ghost-replay
DROP_PRIVILEGES=1
RAILWAY_RUN_UID=0
PUBLIC_ORIGIN=https://ghost-replay.vercel.app
```

Railway's initial mount can be root-owned. The explicitly enabled launcher validates canonical `/data/...` paths and rejects symlinks, makes `/data` traversable0711, creates only missing path directories, chowns **only the final application directory** to1000:1000 and modes0700, clears supplementary groups and drops gid/uid1000 **before importing the application or opening a listener**. It never recursively chowns volume files. Failed initialization/drop exits. Existing database ownership must already permit uid1000 access. Normal image execution remains `USER node`; root execution without explicit initialization is rejected. The provider must retain the volume across deployments. A single attached volume is not a distributed/multi-replica database.

SQLite uses4096-byte pages, maximum8192 pages (~32MiB), DELETE rollback journals (no unbounded WAL), secure-delete, busy timeout1s and FULL auto-vacuum. Transient rollback journal space can approach another database copy: reserve at least128MiB volume capacity. Existing databases with incompatible page size/size limits fail startup. Capacity failures return507; storage unavailable returns503. At most500 workspaces exist, ten scenarios and twenty reports per workspace (oldest replaced automatically), each stored record≤200,000bytes. Workspaces inactive30days are pruned at startup/new workspace creation. These are retention limits, not indefinite backup guarantees. Back up the volume through the provider if recovery is needed. Deletes are logical database deletion plus SQLite secure-delete; provider snapshots can retain earlier data.

## Vercel transport

The static build `node scripts/build-frontend.mjs` outputs allowlisted browser assets to `dist/`. `vercel.json` routes each workspace endpoint to native `api/product.mjs`, which relays only to the fixed Railway origin `https://ghost-replay-production.up.railway.app`. Resource and UUID queries are allowlisted; there is no user-controlled relay target. Workspace token is the only forwarded capability header. Browser cookies, browser Authorization, arbitrary headers and upstream compression/cookies are never forwarded. JSON is normalized into a fresh response. Native product function maxDuration30s, internal24s, client cancellation forwarded. The old native experiment relay stays separate. BACKEND_ORIGIN is not required; changing the real backend domain requires explicit source changes.

`PUBLIC_ORIGIN` allows one exact canonical HTTPS origin alongside direct same-origin requests. Forwarded headers never grant origin trust. No wildcard CORS. Preview origins are not automatically authorized. Vercel browser requests remain same-origin; the server-side relay crosses to Railway.

## Product API

JSON request bodies≤65,536bytes, UTF-8, uncompressed, duplicate/prototype keys rejected. Use `X-Workspace-Token` on every endpoint except bootstrap. All failures use `{error:{code,message}}` (server may add requestId). No credentials or user target URL are logged by the application.

| Endpoint | Contract |
| --- | --- |
| POST `/api/workspaces` | `{}` → `{workspaceToken,workspace:{id,createdAt}}` (201) |
| GET `/api/workspace` | `{workspace,scenarios:[{id,name,requestCount,updatedAt}],runs:[{id,name,createdAt,summary,durationMs}]}` |
| DELETE `/api/workspace` | `{}` → `{deleted:true}`; token invalidated;409 while any replay active |
| POST `/api/scenarios` | `{id?,name,requests}` → `{scenario}`; supplied id must already belong to workspace |
| GET `/api/scenarios?id=UUID` | `{scenario}` including sanitized requests |
| DELETE `/api/scenarios` | `{id}` → `{deleted:true}` |
| POST `/api/runs` | `{name?,requests,auth?}` → `{run}` synchronously after actual HTTP work |
| GET `/api/runs?id=UUID` | `{run}`; canonical sanitized requests/results, suitable for JSON export/reopen |
| DELETE `/api/runs` | `{id}` → `{deleted:true}` |

Requests:1..6 objects `{id?:UUID,label?:string,method:'GET'|'HEAD',url,baseline?:{status?,bodyText?},assertions?:{status?,bodyIncludes?,maxDurationMs?}}`. Names/labels≤80characters, URL≤2048, baseline text≤4096, inclusion text1..256, status100..599, duration assertion50..10000ms. No arbitrary request headers/body/scripts. A duration assertion does not extend the hard timeout.

Optional `auth:{header:'Authorization'|'X-Api-Key',value,hostname}` is ephemeral printable ASCII≤2048, applied only to exactly matching canonical hostname (never subdomains). It is not stored. URL userinfo and known credential query keys are rejected. Supplied auth material, Bearer patterns and recognizable credential keys in JSON/text are redacted before persistence. Only content-type/cache-control/etag/last-modified/content-length response headers are kept, capped512characters each. **Redaction cannot infer every secret in arbitrary content:** review imports, URLs, labels, responses and exports; do not submit confidential datasets. Never put credentials in URL paths/labels/baselines. Workspace token is the only value the frontend should persist locally; auth must never enter localStorage.

Each report has actual timing, status, allowed headers, UTF-8 body preview≤4096characters, received byte count, sanitized full-text SHA-256, baseline status/hash, exact status/body-change flags and bounded first-difference context. JSON bodies are canonicalized during credential redaction; comparisons are over this sanitized text, not original byte identity. `summary` contains total/passed/failed/errors/changed. Baseline changes or failed assertions produce `failed`; HTTP≥400 also fails unless an explicit baseline/asserted status expects that result; redirects produce `error` and are never followed. Without a baseline/assertion,2xx produces passed (reachability only, not semantic correctness). DNS/network/body-limit failures have actual:null; no status/event/minimization is invented. Reports preserve canonical sanitized request configuration for reuse; no outgoing auth.

## Network and admission boundaries

Only HTTPS443, public global addresses, GET/HEAD. DNS resolves **all** answers; any private/special address rejects the target. Literal IPv4/IPv6, mapped IPv4, documentation/link-local/multicast/transition ranges and alternate IPv4 spellings are checked. The selected verified address is pinned in the socket lookup while certificate verification and TLS SNI retain the original host. DNS rebinding cannot silently choose a second address. No redirects, cookies, connection reuse or user proxy configuration. Targets can still log GET/HEAD requests and those methods are not guaranteed side-effect-free by a malicious server; replay only endpoints you are authorized to read.

Per target3s including DNS; per replay19s; sequential at most6 targets. Responses≤64KiB decoded UTF-8, identity encoding requested; unsupported compressed/binary/oversized responses produce error. One replay per instance, no queue,10/min token bucket. Metadata/bootstrap120/min instance-global;32 HTTP connections,8KiB headers/32fields,2s body upload.429 includes retry advice. Client disconnect/shutdown aborts outgoing requests. Limits are per instance: do not add replicas without redesigning budgets/storage. No recurring background replay, mutation methods, credentials vault, arbitrary code, browser replay, Sentry integration or production causality reconstruction.

## Verification before release

Local verification passes23 Python tests plus75 Node tests (98 total), including18 new product groups. Run `npm test` and static build. New tests cover special/mapped IPs, mixed DNS answers, strict JSON, token hashing/durability/isolation, real local HTTP differential results through a test-only trusted transport, no redirect follow, exact auth-host scope, body caps, private history lifecycle, admission and native relay boundaries. Production code has no HTTP input selecting that test transport.

GitHub CI builds the real container and runs nonroot/read-only-root filesystem smoke with a bounded uid1000 writable tmpfs for the local database. Docker is unavailable in the authoring environment: a fresh hosted container result and actual deployed volume persistence/reload, saved workspace isolation, actual public target replay, baseline-change control, export, delete and browser-origin checks are release gates. Local tests alone do not prove current hosting deployment.

Primary references: [Node24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), [SQLite pragmas](https://www.sqlite.org/pragma.html), [Node HTTPS](https://nodejs.org/download/release/latest-v24.x/docs/api/https.html), [Node DNS](https://nodejs.org/download/release/latest-v24.x/docs/api/dns.html).
