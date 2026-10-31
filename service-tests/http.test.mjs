import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createService, LIMITS } from '../service/server.mjs';
import { WorkerRunner, APP_ROOT } from '../service/runner.mjs';
import { parseRequest } from '../service/schema.mjs';

const race = ['A:read', 'B:read', 'A:commit', 'B:commit'];
const sequential = ['A:read', 'A:commit', 'B:read', 'B:commit'];
const input = (schedule = race, stock = 1) => JSON.stringify({ schedule, stock });
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ghost-service-test-'));
  for (const file of ['index.html', 'styles.css', 'app.js', 'helpers.mjs']) await writeFile(join(directory, file), file === 'index.html' ? '<h1>test assets</h1>' : '/* fixture */');
  const app = createService({ webRoot: directory, ...options });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, directory, port: address.port };
}
function request(port, { path = '/api/run', method = 'POST', body = input(), headers = {} } = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, data: res.headers['content-type']?.includes('application/json') && text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(method === 'POST' ? data : undefined);
  });
}
async function until(predicate, timeout = 2_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('condition did not settle');
}
async function refused(port) {
  return new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(true)); });
}
function faultRunner(mode) { return new WorkerRunner({ args: [join(APP_ROOT, 'service-tests/hang_worker.py'), mode] }); }

test('actual real-HTTP buggy/fixed fixture and noise minimization', async t => {
  const { port, app } = await setup(t);
  const response = await request(port, { body: input(['noise:catalog', ...race.slice(0, 2), 'noise:help', ...race.slice(2)]) });
  assert.equal(response.status, 200); const r = response.data;
  assert.match(r.runId, /^[0-9a-f-]{36}$/); assert.equal(r.buggy.transport, 'real loopback HTTP');
  assert.equal(r.buggy.result.final_inventory, -1); assert.equal(r.fixed.result.final_inventory, 0);
  assert.deepEqual(r.buggy.events.map(e => e.operation), r.buggy.schedule.steps);
  assert.equal(r.minimization.minimal_steps, 4); assert.deepEqual(r.minimization.schedule, race);
  assert.equal(r.summary.removedSteps, 2); assert.equal(r.summary.buggyViolation, true);
  assert.equal(r.summary.fixedViolation, false); assert.equal(app.runner.activePids.length, 0);
});
test('negative controls sequential and stock zero/two do not minimize', async t => {
  const { port } = await setup(t);
  for (const [schedule, stock] of [[sequential, 1], [race, 0], [race, 2]]) {
    const r = await request(port, { body: input(schedule, stock) }); assert.equal(r.status, 200);
    assert.equal(r.data.minimization, null); assert.equal(r.data.buggy.result.invariant_violated, false);
  }
});
test('strict integer/operation schema rejects duplicates unknowns URLs and malformed JSON', async t => {
  const { port } = await setup(t);
  const invalid = [
    '{', '{}', input(race, true), input(race, -1), input(race, 101), input(race, '1'),
    input([...race, 'A:read']), input(race.slice(1)), input(['A:commit', 'A:read', 'B:read', 'B:commit']),
    input([...race, 'noise:https://example.com']), input([...race, '<script>']),
    JSON.stringify({ schedule: race, stock: 1, url: 'http://127.0.0.1' }),
    `{"schedule":${JSON.stringify(race)},"stock":1,"stock":0}`,
    `{"schedule":${JSON.stringify(race)},"stock":1.0}`, `{"schedule":${JSON.stringify(race)},"stock":1e0}`,
    input([...race, ...Array(9).fill('noise:x')]),
  ];
  for (const body of invalid) { const r = await request(port, { body }); assert.equal(r.status, 400, body); assert.equal(r.data.error.code, 'invalid_request'); }
});
test('bounded parser accepts reordered escaped field name but rejects canonical duplicate', () => {
  assert.equal(parseRequest(`{"st\\u006fck":1,"schedule":${JSON.stringify(race)}}`).stock, 1);
  assert.throws(() => parseRequest(`{"stock":1,"st\\u006fck":1,"schedule":${JSON.stringify(race)}}`));
  for (const body of ['{"stock":NaN}', '{"stock":01}', '{"stock":1} trailing']) assert.throws(() => parseRequest(body));
});
test('byte bound both Content-Length and chunked bodies, and fatal UTF-8', async t => {
  const { port } = await setup(t);
  assert.equal((await request(port, { body: 'x'.repeat(LIMITS.bodyBytes + 1) })).status, 413);
  assert.equal((await request(port, { body: Buffer.from([0xff]) })).status, 400);
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/run', method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('x'.repeat(8_000)); req.end('x'.repeat(9_000));
  }); assert.equal(chunked, 413);
});
test('same-origin policy, media type, compression and methods', async t => {
  const { port } = await setup(t);
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Encoding': 'gzip' }]) assert.equal((await request(port, { headers })).status, 415);
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request(port, { headers })).status, 403);
  assert.equal((await request(port, { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  const wrong = await request(port, { method: 'GET' }); assert.equal(wrong.status, 405); assert.equal(wrong.headers.allow, 'POST');
  assert.equal((await request(port, { method: 'OPTIONS' })).headers['access-control-allow-origin'], undefined);
});
test('static allowlist blocks internal dotfile traversal and test sources', async t => {
  const { port } = await setup(t);
  for (const path of ['/', '/index.html', '/app.js', '/styles.css', '/helpers.mjs']) assert.equal((await request(port, { path, method: 'GET' })).status, 200);
  for (const path of ['/../README.md', '/%2e%2e/README.md', '/.git/config', '/ghost_replay/core.py', '/helpers.test.mjs', '/service/main.mjs', '/app.js/../README.md']) assert.equal((await request(port, { path, method: 'GET' })).status, 404, path);
  const asset = await request(port, { path: '/helpers.mjs', method: 'GET' }); assert.match(asset.headers['content-type'], /javascript/);
  assert.equal(asset.headers['x-content-type-options'], 'nosniff'); assert.match(asset.headers['content-security-policy'], /frame-ancestors 'none'/);
});
test('readiness includes actual worker self-test and complete assets; missing worker stays unavailable', async t => {
  const { port, app } = await setup(t); assert.equal(app.ready, true);
  assert.equal((await request(port, { path: '/healthz', method: 'GET' })).status, 200);
  const ready = await request(port, { path: '/readyz', method: 'GET' }); assert.equal(ready.status, 200); assert.deepEqual(ready.data.checks, { staticAssets: true, fixtureWorker: true });
  const unavailable = await setup(t, { runner: new WorkerRunner({ python: '/does/not/exist' }) });
  assert.equal((await request(unavailable.port, { path: '/readyz', method: 'GET' })).status, 503);
  const blocked = await request(unavailable.port); assert.equal(blocked.status, 503); assert.equal(blocked.headers['retry-after'], '3');
});
test('symlink outside the asset root prevents readiness and never exposes the target', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ghost-symlink-test-'));
  await symlink(join(APP_ROOT, 'ghost_replay/core.py'), join(directory, 'index.html'));
  const app = createService({ webRoot: directory }); await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const port = app.server.address().port; assert.equal(app.ready, false);
  const r = await request(port, { method: 'GET', path: '/' }); assert.equal(r.status, 503); assert.doesNotMatch(r.text, /Scheduler|__file__|\/workspace/);
});
test('rate budget is global not spoofable through forwarded headers', async t => {
  const { port } = await setup(t, { rateRequests: 1, rateWindowMs: 600_000 });
  assert.equal((await request(port)).status, 200);
  const next = await request(port, { headers: { 'X-Forwarded-For': '8.8.8.8' } });
  assert.equal(next.status, 429); assert.equal(next.data.error.code, 'rate_limited'); assert.equal(next.headers['retry-after'], '3');
});
test('bounded body deadline releases admission and leaves no Python child', async t => {
  const { port, app } = await setup(t, { bodyMs: 80 });
  const status = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('POST /api/run HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'));
    let text = ''; socket.on('data', chunk => { text += chunk; }); socket.once('end', () => resolve(text)); socket.once('error', reject);
  }); assert.match(status, /408 Request Timeout/); await until(() => !app.busy); assert.equal(app.runner.activePids.length, 0);
});
test('timeout kills an actual stubborn worker and closes its loopback server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ghost-timeout-test-')); const record = join(directory, 'port.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { port, app } = await setup(t, { runner: faultRunner(record), workerMs: 300 });
  const started = Date.now(); const pending = request(port);
  const workerPort = await until(async () => { try { return JSON.parse(await readFile(record, 'utf8')).port; } catch { return false; } });
  assert.equal(await refused(workerPort), false);
  const result = await pending; assert.equal(result.status, 504); assert.equal(result.data.error.code, 'run_timeout');
  assert.ok(Date.now() - started < 2_000); assert.equal(app.runner.activePids.length, 0); assert.equal(await refused(workerPort), true);
});
test('busy storm and client cancellation keep one worker and clean its server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ghost-abort-test-')); const record = join(directory, 'port.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { port, app } = await setup(t, { runner: faultRunner(record) });
  const req = http.request({ host: '127.0.0.1', port, path: '/api/run', method: 'POST', headers: { 'Content-Type': 'application/json' } }); req.on('error', () => {}); req.end(input());
  const workerPort = await until(async () => { try { return JSON.parse(await readFile(record, 'utf8')).port; } catch { return false; } });
  assert.equal(app.runner.activePids.length, 1); const pid = app.runner.activePids[0];
  const attempts = await Promise.all(Array.from({ length: 12 }, () => request(port)));
  assert.ok(attempts.every(r => r.status === 429 && r.headers['retry-after'] === '3'));
  assert.equal(app.runner.activePids.length, 1); req.destroy(); await until(() => !app.busy);
  assert.equal(app.runner.activePids.length, 0); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert.equal(await refused(workerPort), true);
});
test('successive actual experiments have isolated inventories and unique run IDs', async t => {
  const { port, app } = await setup(t); const ids = new Set();
  for (const stock of [1, 0, 2, 1, 1]) {
    const r = await request(port, { body: input(race, stock) }); assert.equal(r.status, 200); ids.add(r.data.runId);
    assert.equal(r.data.buggy.fixture.stock, stock); assert.equal(r.data.buggy.result.invariant_violated, stock === 1);
    assert.equal(app.runner.activePids.length, 0);
  } assert.equal(ids.size, 5);
});
test('safe worker failure errors conceal stderr and reject invalid or oversized output', async t => {
  for (const mode of ['exit', 'invalid', 'flood']) {
    const { port, app } = await setup(t, { runner: faultRunner(mode) }); const r = await request(port);
    assert.equal(r.status, 502); assert.doesNotMatch(r.text, /DO_NOT_DISCLOSE|Traceback|workspace|hang_worker/); assert.equal(app.runner.activePids.length, 0);
  }
});
test('graceful shutdown cancels active child, rejects new work and closes listener', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ghost-shutdown-test-')); const record = join(directory, 'port.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { port, app } = await setup(t, { runner: faultRunner(record) });
  const pending = request(port).catch(() => ({ status: 'connection_closed' }));
  const workerPort = await until(async () => { try { return JSON.parse(await readFile(record, 'utf8')).port; } catch { return false; } });
  await app.close(); const result = await pending; assert.ok([503, 'connection_closed'].includes(result.status));
  assert.equal(app.ready, false); assert.equal(app.runner.activePids.length, 0); assert.equal(await refused(port), true); assert.equal(await refused(workerPort), true);
});
test('fixed Python entry independently rejects duplicate keys and unsupported operations', async () => {
  for (const raw of [`{"schedule":${JSON.stringify(race)},"stock":1,"stock":0}`, input([...race, 'noise:http://evil'])]) {
    const child = spawn('python3', ['-m', 'ghost_replay.web_worker'], { cwd: APP_ROOT }); let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdin.end(raw);
    const code = await new Promise(resolve => child.on('close', resolve)); assert.equal(code, 2); assert.equal(stderr.trim(), '{"error":"worker_failed"}');
  }
});
test('absolute request deadline includes worker execution and reaps the child', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ghost-total-deadline-')); const record = join(directory, 'port.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { port, app } = await setup(t, { runner: faultRunner(record), totalMs: 200 });
  const started = Date.now(); const result = await request(port);
  assert.equal(result.status, 504); assert.equal(result.data.error.code, 'run_timeout');
  assert.ok(Date.now() - started < 1_500); assert.equal(app.runner.activePids.length, 0);
});
test('preview CLI flags override PORT and graceful SIGTERM closes the real entrypoint', async t => {
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['service/main.mjs', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: APP_ROOT, env: { ...process.env, PORT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await until(() => output.includes('"event":"listening"'), 5_000);
  const startup = JSON.parse(output.trim()); assert.equal(startup.port, port); assert.equal(startup.ready, true);
  const health = await request(port, { path: '/readyz', method: 'GET' }); assert.equal(health.status, 200);
  const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM');
  assert.equal(await closed, 0); assert.equal(await refused(port), true);
});
test('worker leader exit cleans surviving descendants with inherited or closed pipes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ghost-descendant-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const self = await readFile('/proc/self/stat', 'utf8');
  const matchingPidView = Number(self.slice(0, self.indexOf(' '))) === process.pid;
  for (const mode of ['inherited', 'closed']) {
    const record = join(directory, `${mode}.json`);
    const runner = new WorkerRunner({ args: [join(APP_ROOT, 'service-tests/fork_worker.py'), record, mode] });
    t.after(() => runner.shutdown());
    let result;
    try { result = await runner.execute({ schedule: race, stock: 1 }, { timeoutMs: 1_000 }); }
    catch (error) {
      // Some execution sandboxes mount a different PID namespace's /proc. Such
      // metadata must not establish cleanup; the runner conservatively abstains.
      assert.equal(matchingPidView, false); assert.equal(error.code, 'worker_cleanup');
      assert.equal(runner.healthy, false);
      await assert.rejects(runner.execute({ schedule: race, stock: 1 }), { code: 'worker_unavailable' });
    }
    if (result) assert.equal(result.buggy.result.complete, true);
    assert.equal(runner.activePids.length, 0);
    const child = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(await refused(child.port), true);
    // On a host without an init reaper the dead orphan can briefly be a zombie;
    // it must not be executing. Container tini reaps such adopted children.
    if (matchingPidView) {
      let alive = false, state = 'missing';
      try { state = await readFile(`/proc/${child.pid}/stat`, 'utf8'); alive = !/\) [ZX] /.test(state); } catch {}
      assert.equal(alive, false, state);
    } else t.diagnostic('PID/proc views differ: process liveness is not inferred from unrelated host PIDs; socket closure and fail-closed supervision checked.');
  }
});
