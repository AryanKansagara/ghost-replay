import assert from 'node:assert/strict';

const base = process.env.SMOKE_URL || 'http://127.0.0.1:3000';
const get = path => fetch(base + path, { signal: AbortSignal.timeout(10_000) });
const ready = await get('/readyz'); assert.equal(ready.status, 200); assert.equal((await ready.json()).status, 'ready');
for (const path of ['/', '/app.js', '/styles.css', '/helpers.mjs']) assert.equal((await get(path)).status, 200);
for (const path of ['/ghost_replay/core.py', '/.git/config', '/helpers.test.mjs']) assert.equal((await get(path)).status, 404);
const schedule = ['noise:catalog', 'A:read', 'B:read', 'A:commit', 'B:commit'];
const response = await fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ schedule, stock: 1 }), signal: AbortSignal.timeout(10_000) });
assert.equal(response.status, 200); const result = await response.json();
assert.equal(result.buggy.result.final_inventory, -1); assert.equal(result.fixed.result.final_inventory, 0);
assert.equal(result.minimization.minimal_steps, 4); assert.equal(result.summary.removedSteps, 1);
console.log(JSON.stringify({ smoke: 'passed', transport: result.buggy.transport, buggyViolation: result.summary.buggyViolation,
  fixedViolation: result.summary.fixedViolation, minimizedSteps: result.minimization.minimal_steps }));
