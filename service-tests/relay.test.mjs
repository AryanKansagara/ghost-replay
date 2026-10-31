import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import handler, { createRelay, POST, BACKEND_URL, FRONTEND_ORIGIN } from '../api/experiment.mjs';

const body = '{"schedule":["A:read","B:read","A:commit","B:commit"],"stock":1}';
const request = (options = {}) => new Request(FRONTEND_ORIGIN + '/api/run', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: FRONTEND_ORIGIN }, body, ...options,
});

test('standalone fetch entry and first-match internal rewrite avoid external/self loops', async () => {
  assert.equal(handler.fetch, POST);
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.rewrites[0], { source: '/api/run', destination: '/api/experiment' });
  assert.equal(config.rewrites[1].source, '/api/:path*');
  assert.deepEqual(config.functions['api/experiment.mjs'], { supportsCancellation: true, maxDuration: 15 });
});
test('fixed target and minimal headers preserve actual request text, not browser headers', async () => {
  const duplicate = body.replace('"stock":1', '"stock":1,"stock":0'); let calls = 0;
  const relay = createRelay({ fetchImpl: async (url, init) => {
    calls++; assert.equal(url, BACKEND_URL); assert.equal(init.body, duplicate); assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'Accept-Encoding', 'Content-Type', 'Origin']);
    assert.equal(init.headers.Origin, FRONTEND_ORIGIN); assert.equal(init.headers['Accept-Encoding'], 'identity');
    assert.equal(init.headers.Cookie, undefined); assert.equal(init.headers['X-Forwarded-Host'], undefined);
    return Response.json({ error: { code: 'invalid_request', message: 'Rejected by real schema.' } }, { status: 400 });
  } });
  const result = await relay(request({ body: duplicate, headers: { 'Content-Type': 'application/json', Origin: FRONTEND_ORIGIN, Cookie: 'private=do-not-forward', 'X-Forwarded-Host': 'evil.example', Authorization: 'do-not-forward' } }));
  assert.equal(result.status, 400); assert.equal((await result.json()).error.code, 'invalid_request'); assert.equal(calls, 1);
});
test('actual gzip HTTP response is decoded then returned as fresh JSON without stale transport headers', async t => {
  const actual = { runId: 'authored-transport-fixture', summary: { buggyViolation: true, fixedViolation: false }, text: 'Ω'.repeat(300) };
  const compressed = gzipSync(Buffer.from(JSON.stringify(actual))); const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length, 'Set-Cookie': 'upstream-private=1' }); res.end(compressed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const relay = createRelay({ fetchImpl: (url, init) => { assert.equal(url, BACKEND_URL); return fetch(`http://127.0.0.1:${server.address().port}/api/run`, init); } });
  const result = await relay(request()); assert.equal(result.status, 200); assert.deepEqual(await result.json(), actual);
  for (const name of ['content-encoding', 'content-length', 'set-cookie', 'transfer-encoding']) assert.equal(result.headers.get(name), null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('request method, origin, media, compressed, invalid UTF-8 and byte bounds reject before upstream', async () => {
  const relay = createRelay({ fetchImpl: async () => { throw new Error('upstream should not be called'); } });
  for (const [req, status] of [
    [new Request(FRONTEND_ORIGIN + '/api/run'), 405],
    [request({ headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } }), 403],
    [request({ headers: { 'Content-Type': 'text/plain' } }), 415],
    [request({ headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } }), 415],
    [request({ body: 'x'.repeat(16_385) }), 413],
    [request({ body: new Uint8Array([0xff]) }), 400], [request({ body: 'not json' }), 400],
  ]) { const result = await relay(req); assert.equal(result.status, status); assert.ok((await result.json()).error.code); }
});
test('upstream HTML, oversized and malformed responses become bounded safe JSON errors', async () => {
  for (const upstream of [new Response('<html>private traceback</html>', { status: 400 }),
    new Response('x'.repeat(262_145)), Response.json(null), Response.json([])]) {
    const result = await createRelay({ fetchImpl: async () => upstream })(request());
    assert.equal(result.status, 502); const text = await result.text(); assert.doesNotMatch(text, /private traceback/); assert.ok(JSON.parse(text).error.code);
  }
});
test('safe Retry-After propagates but upstream compression/cookies and arbitrary headers never do', async () => {
  const result = await createRelay({ fetchImpl: async () => Response.json({ error: { code: 'busy', message: 'Try again.' } }, {
    status: 429, headers: { 'Retry-After': '3', 'Content-Encoding': 'gzip', 'Content-Length': '3', 'Set-Cookie': 'private=1' },
  }) })(request());
  assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '3');
  assert.equal(result.headers.get('content-encoding'), null); assert.equal(result.headers.get('content-length'), null); assert.equal(result.headers.get('set-cookie'), null);
  assert.equal((await result.json()).error.code, 'busy');
});
test('client cancellation reaches the upstream signal and returns no invented successful result', async () => {
  const controller = new AbortController(); let upstreamSignal;
  const relay = createRelay({ fetchImpl: async (_url, init) => { upstreamSignal = init.signal; controller.abort(); throw new Error('cancelled'); } });
  const result = await relay(request({ signal: controller.signal })); assert.equal(upstreamSignal.aborted, true);
  assert.equal(result.status, 499); assert.equal((await result.json()).error.code, 'request_cancelled');
});
test('deadline bounds an unresponsive upstream and all network exceptions remain safe', async () => {
  const timed = await createRelay({ timeoutMs: 30, fetchImpl: () => new Promise(() => {}) })(request());
  assert.equal(timed.status, 504); assert.equal((await timed.json()).error.code, 'upstream_timeout');
  const failed = await createRelay({ fetchImpl: async () => { throw new Error('SECRET token upstream internal path'); } })(request());
  assert.equal(failed.status, 502); assert.doesNotMatch(await failed.text(), /SECRET|token|internal path/);
});
