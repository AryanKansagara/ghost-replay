import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, buildInput, validateInput, validateReport, eventPresentation, reproCLI, errorMessage } from './helpers.mjs';

test('six distinct protocol-valid schedules with and without optional noise', () => {
  assert.equal(PRESETS.length, 6);
  assert.equal(new Set(PRESETS.map(p => p.steps.join(','))).size, 6);
  for (const preset of PRESETS) for (const noise of [true, false]) for (const stock of [0,1,2,3]) {
    const input = buildInput(preset.id, stock, noise);
    assert.equal(input.schedule.length, noise ? 6 : 4); assert.equal(input.stock, stock);
    assert.equal(validateInput(input), input);
  }
});
test('input validation rejects malformed controls, duplicate steps and shell text', () => {
  const good = buildInput('shared', 1, false);
  for (const stock of [true, 1.5, -1, 4, '1']) assert.throws(() => validateInput({ ...good, stock }));
  for (const schedule of [null, ['A:read'], [...good.schedule,'A:read'], ['A:commit','A:read','B:read','B:commit'], [...good.schedule,'noise:$(touch x)']]) assert.throws(() => validateInput({ ...good, schedule }));
  assert.throws(() => buildInput('missing', 1, false)); assert.throws(() => buildInput('shared', 1, 'false'));
});
test('CLI recipe uses a quoted heredoc and only validated values', () => {
  const input = buildInput('shared', 1, true), cli = reproCLI(input);
  assert.match(cli, /<<'GHOST_REPLAY_CASE'/); assert.match(cli,/--mode buggy/); assert.match(cli,/--mode fixed/);
  const recipe=JSON.parse(cli.split('\n').slice(1,cli.split('\n').indexOf('GHOST_REPLAY_CASE')).join('\n'));
  assert.deepEqual(recipe, {schema_version:1,...input});
  assert.throws(() => reproCLI({...input,schedule:[...input.schedule,'noise:bad\nGHOST_REPLAY_CASE']}));
});
test('observed event formatting preserves zero, rejection and negative inventory', () => {
  assert.equal(eventPresentation({operation:'A:read',inventory:0}).value,'0');
  const decline=eventPresentation({operation:'B:commit',accepted:false,inventory_before:0,inventory_after:0});
  assert.equal(decline.verdict,'rejected'); assert.equal(decline.value,'0 → 0');
  assert.equal(eventPresentation({operation:'B:commit',accepted:true,inventory_before:0,inventory_after:-1}).tone,'danger');
  assert.equal(eventPresentation({operation:'noise:catalog'}).noise,true);
});
function report(input) {
  const base = mode => ({ mode, fixture:{stock:input.stock},schedule:{steps:[...input.schedule]}, events:input.schedule.map((operation, sequence)=>({operation,sequence,...(operation.endsWith(':read')?{inventory:1}:{accepted:true,inventory_before:1,inventory_after:0})})),result:{accepted:1,final_inventory:0,invariant_violated:false,complete:true} });
  return {runId:'fixture-run',buggy:base('buggy'),fixed:base('fixed'),minimization:null};
}
test('report rendering requires complete actual observations bound to the submitted inputs', () => {
  const input=buildInput('shared',1,false), value=report(input);
  assert.equal(validateReport(value,input),value);
  for (const mutate of [r=>r.fixed.result.complete=false,r=>r.buggy.result.accepted=3,r=>r.buggy.fixture.stock=2,r=>r.fixed.schedule.steps.reverse(),r=>r.buggy.events.pop(),r=>r.buggy.events[0].inventory=null,r=>r.fixed.result.invariant_violated=true,r=>r.runId='../bad']) {
    const changed=structuredClone(value);mutate(changed);assert.throws(()=>validateReport(changed,input));
  }
});
test('witness must preserve input subsequence and can exist only for a failing run', () => {
  const input=buildInput('shared',1,true),r=report(input);
  r.buggy.result={accepted:2,final_inventory:-1,invariant_violated:true,complete:true};
  r.minimization={schedule:[...PRESETS[0].steps],original_steps:6,minimal_steps:4,trials:2};
  assert.equal(validateReport(r,input),r);
  const wrong=structuredClone(r);wrong.minimization.schedule.reverse();assert.throws(()=>validateReport(wrong,input));
  const extra=structuredClone(r);extra.minimization.original_steps=9;assert.throws(()=>validateReport(extra,input));
});
test('HTTP errors preserve server explanation as text and bound retry messages', () => {
  assert.match(errorMessage({},429,'3'),/3 seconds/);
  assert.match(errorMessage(null,504,null),/deadline/);
  assert.equal(errorMessage({error:{message:'<script>untrusted</script>'}},400,'bad'),'<script>untrusted</script>');
  assert.ok(errorMessage({error:{message:'x'.repeat(500)}},400,null).length<=240);
});
