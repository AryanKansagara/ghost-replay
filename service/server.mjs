import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { APP_ROOT, WorkerRunner } from './runner.mjs';
import { HttpError, parseRequest } from './schema.mjs';

export const LIMITS = Object.freeze({ bodyBytes: 16_384, bodyMs: 2_000, totalMs: 9_000,
  workerMs: 8_000, rateRequests: 20, rateWindowMs: 60_000, connections: 32 });
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/helpers.mjs', ['helpers.mjs', 'text/javascript; charset=utf-8']],
]);

function headers(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length });
  res.end(bytes);
}
function errorResponse(res, error, requestId) {
  if (res.destroyed || res.writableEnded) return;
  const safe = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'The service could not complete this request.');
  res.setHeader('Connection', 'close');
  if ([429, 503].includes(safe.status)) res.setHeader('Retry-After', '3');
  json(res, safe.status, { error: { code: safe.code, message: safe.message }, requestId });
}
function readBody(req, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let chunks = [], bytes = 0;
    const cleanup = () => {
      clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('error', aborted); req.removeListener('aborted', aborted);
      signal.removeEventListener('abort', abort);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const abort = () => fail(signal.reason || new HttpError(503, 'cancelled', 'The operation was cancelled.'));
    const aborted = () => fail(new HttpError(503, 'cancelled', 'The operation was cancelled.'));
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > LIMITS.bodyBytes) fail(new HttpError(413, 'body_too_large', 'Request body exceeds 16 KiB.'));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new HttpError(400, 'invalid_utf8', 'Request body must be UTF-8 JSON.')); }
    };
    const timer = setTimeout(() => fail(new HttpError(408, 'body_timeout', 'The request body did not arrive in time.')), timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function createService({ webRoot = join(APP_ROOT, 'web'), runner = new WorkerRunner(),
  bodyMs = LIMITS.bodyMs, totalMs = LIMITS.totalMs, workerMs = LIMITS.workerMs,
  rateRequests = LIMITS.rateRequests, rateWindowMs = LIMITS.rateWindowMs } = {}) {
  // These options are trusted startup/test configuration, never request fields.
  if (![bodyMs, totalMs, workerMs, rateRequests, rateWindowMs].every(value => Number.isInteger(value) && value > 0) ||
      bodyMs > LIMITS.bodyMs || totalMs > LIMITS.totalMs || workerMs > LIMITS.workerMs || rateRequests > LIMITS.rateRequests)
    throw new Error('invalid bounded service configuration');
  let draining = false, assetsReady = false, workerReady = false, active = null;
  let tokens = rateRequests, lastRefill = performance.now();
  const assets = new Map();
  const takeBudget = () => {
    const now = performance.now(); tokens = Math.min(rateRequests, tokens + (now - lastRefill) * rateRequests / rateWindowMs);
    lastRefill = now; if (tokens < 1) return false; tokens--; return true;
  };
  const server = http.createServer({ maxHeaderSize: 8_192, requestTimeout: 5_000, headersTimeout: 5_000,
    keepAliveTimeout: 1_000, connectionsCheckingInterval: 500 }, (req, res) => {
    handle(req, res).catch(() => errorResponse(res, new HttpError(500, 'internal_error', 'The service could not complete this request.'), randomUUID()));
  });
  server.maxConnections = LIMITS.connections; server.maxHeadersCount = 32; server.maxRequestsPerSocket = 20;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  for (const event of ['checkContinue', 'checkExpectation']) server.on(event, (_req, res) => {
    headers(res); errorResponse(res, new HttpError(417, 'expectation_unsupported', 'Expect headers are unsupported.'), randomUUID());
  });

  async function handle(req, res) {
    headers(res); const requestId = randomUUID(); res.setHeader('X-Request-Id', requestId);
    const rawPath = (req.url || '').split('?')[0];
    if (!rawPath.startsWith('/') || rawPath.length > 2_048) return errorResponse(res, new HttpError(400, 'invalid_path', 'Invalid request path.'), requestId);
    if (['GET', 'HEAD'].includes(req.method) && ['/healthz', '/readyz'].includes(rawPath)) {
      const ready = !draining && assetsReady && workerReady;
      if (rawPath === '/readyz' && !ready) res.setHeader('Retry-After', '3');
      return rawPath === '/healthz'
        ? json(res, 200, { status: 'live' })
        : json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks: { staticAssets: assetsReady, fixtureWorker: workerReady }, busy: active !== null });
    }
    if (FILES.has(rawPath) && ['GET', 'HEAD'].includes(req.method)) {
      const file = assets.get(rawPath);
      if (!file) return errorResponse(res, new HttpError(503, 'assets_unavailable', 'The application assets are unavailable.'), requestId);
      res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.bytes.length });
      return res.end(req.method === 'HEAD' ? undefined : file.bytes);
    }
    if (rawPath !== '/api/run') return errorResponse(res, new HttpError(404, 'not_found', 'Resource not found.'), requestId);
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST'); return errorResponse(res, new HttpError(405, 'method_not_allowed', 'Use POST for experiments.'), requestId);
    }
    if (draining || !assetsReady || !workerReady) return errorResponse(res, new HttpError(503, 'not_ready', 'The service is not ready for experiments.'), requestId);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') ||
        (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity'))
      return errorResponse(res, new HttpError(415, 'unsupported_media_type', 'Use uncompressed application/json UTF-8.'), requestId);
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch {}
      if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host)
        return errorResponse(res, new HttpError(403, 'cross_origin', 'Cross-origin experiment requests are not allowed.'), requestId);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return errorResponse(res, new HttpError(403, 'cross_origin', 'Cross-origin experiment requests are not allowed.'), requestId);
    if (Number(req.headers['content-length']) > LIMITS.bodyBytes) return errorResponse(res, new HttpError(413, 'body_too_large', 'Request body exceeds 16 KiB.'), requestId);
    if (active) return errorResponse(res, new HttpError(429, 'busy', 'An experiment is already running. Try again shortly.'), requestId);
    if (!takeBudget()) return errorResponse(res, new HttpError(429, 'rate_limited', 'The instance experiment budget is temporarily exhausted.'), requestId);
    const started = performance.now(), controller = new AbortController(); active = controller;
    const disconnect = () => { if (!res.writableFinished) controller.abort(new HttpError(503, 'cancelled', 'The operation was cancelled.')); };
    res.once('close', disconnect);
    const deadline = setTimeout(() => controller.abort(new HttpError(504, 'run_timeout', 'The experiment exceeded its time budget.')), totalMs);
    try {
      const input = parseRequest(await readBody(req, controller.signal, bodyMs));
      const result = await runner.execute(input, { signal: controller.signal, timeoutMs: workerMs });
      if (controller.signal.aborted) throw controller.signal.reason;
      const bad = result.buggy.result.invariant_violated, good = result.fixed.result.invariant_violated;
      const reduction = result.minimization;
      json(res, 200, { runId: requestId, ...result, summary: {
        transport: 'real loopback HTTP', initialStock: input.stock, scheduleSteps: input.schedule.length,
        buggyViolation: bad, fixedViolation: good,
        removedSteps: reduction ? input.schedule.length - reduction.minimal_steps : 0,
        durationMs: Math.round(performance.now() - started),
        claim: 'Controlled checkout fixture only; not production incident reconstruction.',
      } });
    } catch (error) { errorResponse(res, error, requestId); }
    finally { clearTimeout(deadline); res.removeListener('close', disconnect); active = null; }
  }

  async function initialize() {
    try {
      const root = await realpath(webRoot);
      for (const [route, [name, type]] of FILES) {
        const path = await realpath(join(root, name));
        if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('bad asset path');
        const bytes = await readFile(path); if (bytes.length > 262_144) throw new Error('asset too large');
        assets.set(route, { bytes, type });
      }
      assetsReady = true;
    } catch { assets.clear(); assetsReady = false; }
    if (draining) return;
    try { await runner.execute(null, { check: true, timeoutMs: 5_000 }); workerReady = true; }
    catch { workerReady = false; }
  }
  let closing;
  return {
    server, runner,
    get ready() { return !draining && assetsReady && workerReady; },
    get busy() { return active !== null; },
    async listen({ port = 3000, host = '0.0.0.0' } = {}) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      await initialize(); return server.address();
    },
    close() {
      if (closing) return closing;
      draining = true;
      active?.abort(new HttpError(503, 'shutting_down', 'The service is shutting down.'));
      closing = (async () => {
        const sockets = new Promise(resolve => server.close(resolve)); server.closeIdleConnections();
        const force = setTimeout(() => server.closeAllConnections(), 500);
        await runner.shutdown(); await sockets; clearTimeout(force);
      })();
      return closing;
    },
  };
}
