import { PRESETS, buildInput, shortStep, validateReport, eventPresentation, reproCLI, errorMessage } from '/helpers.mjs';

const $ = id => document.getElementById(id);
let busy = false, completed = null, completedInput = null;
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

function chips(steps) {
  const fragment = document.createDocumentFragment();
  steps.forEach((step, index) => {
    if (index) fragment.append(element('span', 'step-arrow', '→'));
    fragment.append(element('span', `step-chip${step.startsWith('B:') ? ' request-b' : ''}${step.startsWith('noise:') ? ' noise-chip' : ''}`, shortStep(step)));
  });
  return fragment;
}
function currentInput() {
  return buildInput(document.querySelector('input[name="preset"]:checked')?.value, Number($('stock').value), $('include-noise').checked);
}
function setStatus(message, state = '') {
  $('status-text').textContent = message;
  $('run-status').className = `run-status ${state}`;
}
function emptyTrace(container, title, detail) {
  const shell = element('div', 'trace-empty');
  const icon = element('span', 'empty-icon', '⌁'); icon.setAttribute('aria-hidden', 'true');
  shell.append(icon, element('strong', '', title), element('p', '', detail));
  container.replaceChildren(shell);
}
function clearResults() {
  completed = null; completedInput = null;
  for (const id of ['buggy-accepted', 'fixed-accepted', 'buggy-inventory', 'fixed-inventory']) {
    $(id).textContent = '—'; $(id).classList.remove('is-bad', 'is-good');
  }
  for (const mode of ['buggy', 'fixed']) { $(`${mode}-invariant`).textContent = 'Not run'; $(`${mode}-invariant`).className = 'outcome neutral'; }
  $('accepted-note').textContent = 'Observed from checkout responses'; $('inventory-note').textContent = 'Final stock after both requests';
  emptyTrace($('buggy-trace'), 'No observations yet', 'Run an interleaving to capture inventory reads and checkout commits.');
  emptyTrace($('fixed-trace'), 'A matching comparison', 'The fixed handler uses the same schedule and initial inventory.');
  $('witness-result').replaceChildren(element('span', 'witness-empty-label', 'WAITING FOR A REPRODUCED VIOLATION'), element('p', '', 'A failing run unlocks a reduced schedule and its measured reduction.'));
  $('run-reference').textContent = 'No experiment recorded'; $('duration-label').textContent = '';
  $('copy-cli').disabled = true; $('download-json').disabled = true; $('export-status').textContent = '';
  $('cli-details').hidden = true; $('cli-details').open = false; $('repro-commands').value = '';
}
function refreshInputs() {
  $('schedule-preview').replaceChildren(chips(currentInput().schedule));
  if (completed || !$('error-box').hidden) {
    clearResults(); $('error-box').hidden = true;
    setStatus('Inputs changed · run to compare');
  }
}
function setBusy(value) {
  busy = value;
  $('run-button').disabled = value; $('preset-fieldset').disabled = value; $('stock').disabled = value; $('include-noise').disabled = value;
  $('run-button').classList.toggle('is-loading', value);
  $('run-button-label').textContent = value ? 'Running experiment…' : 'Run comparison';
  $('metrics-grid').setAttribute('aria-busy', String(value)); $('trace-grid').setAttribute('aria-busy', String(value));
  $('copy-cli').disabled = value || !completed; $('download-json').disabled = value || !completed;
}
function renderTrace(container, run) {
  const list = element('ol', 'event-list'); list.setAttribute('aria-label', `${run.mode === 'buggy' ? 'Vulnerable' : 'Fixed'} observed event sequence`);
  for (const event of run.events) {
    const view = eventPresentation(event);
    const row = element('li', `event-row${view.noise ? ' noise-row' : ''}`);
    const token = element('span', `request-token${view.actor === 'B' ? ' request-b' : ''}${view.noise ? ' noise-token' : ''}`, view.actor);
    token.setAttribute('aria-label', view.noise ? 'Unrelated activity' : `Request ${view.actor}`);
    const detail = element('div', 'event-title', view.title); detail.append(element('span', 'event-detail', view.detail));
    const outcome = element('div', `event-value ${view.tone}`);
    if (view.verdict) outcome.append(element('span', `event-verdict${view.verdict === 'rejected' ? ' rejected' : ''}`, view.verdict));
    outcome.append(document.createTextNode(view.value));
    row.append(element('span', 'event-index', String(event.sequence + 1).padStart(2, '0')), token, detail, outcome);
    list.append(row);
  }
  container.replaceChildren(list);
}
function renderWitness(data) {
  const container = $('witness-result'), witness = data.minimization;
  if (!witness) {
    container.replaceChildren(element('span', 'witness-empty-label', 'NO FAILING WITNESS FOR THIS RUN'), element('p', '', 'The vulnerable handler did not violate the invariant. No failure-preserving minimization was performed.'));
    return;
  }
  const removed = witness.original_steps - witness.minimal_steps;
  const topline = element('div', 'witness-topline');
  const stat = element('span', 'witness-stat');
  stat.append(document.createTextNode(`${witness.original_steps} steps → `), element('strong', '', `${witness.minimal_steps} steps`));
  topline.append(stat, element('span', 'reduction-label', removed ? `${removed} unrelated ${removed === 1 ? 'step' : 'steps'} removed` : 'Already irreducible'));
  const schedule = element('div', 'schedule-chips'); schedule.setAttribute('aria-label', 'Reduced failing schedule'); schedule.append(chips(witness.schedule));
  const note = element('p', 'witness-limit', `${witness.trials} reduction ${witness.trials === 1 ? 'trial' : 'trials'}. One-step-minimal among valid fixture schedules; not a global minimum.`);
  container.replaceChildren(topline, schedule, note);
}
function renderReport(data, input) {
  for (const mode of ['buggy', 'fixed']) {
    const result = data[mode].result;
    $(`${mode}-accepted`).textContent = String(result.accepted);
    $(`${mode}-inventory`).textContent = String(result.final_inventory);
    $(`${mode}-accepted`).classList.toggle('is-bad', result.invariant_violated);
    $(`${mode}-inventory`).classList.toggle('is-bad', result.invariant_violated);
    $(`${mode}-inventory`).classList.toggle('is-good', !result.invariant_violated && mode === 'fixed');
    $(`${mode}-invariant`).textContent = result.invariant_violated ? 'Violated' : 'Preserved';
    $(`${mode}-invariant`).className = `outcome ${result.invariant_violated ? 'bad' : 'good'}`;
    renderTrace($(`${mode}-trace`), data[mode]);
  }
  $('accepted-note').textContent = `${input.stock} ${input.stock === 1 ? 'unit' : 'units'} available · 2 checkout requests`;
  $('inventory-note').textContent = data.buggy.result.final_inventory < 0 ? 'Negative inventory reveals an oversell' : 'Both final inventory values are observed';
  renderWitness(data);
  $('run-reference').textContent = data.runId;
  $('run-reference').title = data.runId;
  const duration = data.summary?.durationMs;
  $('duration-label').textContent = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? `${(duration / 1000).toFixed(2)}s · real HTTP` : 'Real loopback HTTP';
  completed = data; completedInput = structuredClone(input);
  $('repro-commands').value = reproCLI(completedInput); $('cli-details').hidden = false;
  setStatus(data.buggy.result.invariant_violated ? `Complete · vulnerable ${data.fixed.result.invariant_violated ? 'and fixed violate' : 'violates, fixed holds'}` : 'Complete · no violation observed', 'complete');
}
async function run() {
  if (busy) return;
  let input;
  try { input = currentInput(); } catch (error) { showError(error.message); return; }
  clearResults(); $('error-box').hidden = true; setBusy(true); setStatus('Running real HTTP comparison…', 'running');
  emptyTrace($('buggy-trace'), 'Capturing vulnerable handler', 'Executing the selected interleaving against the local checkout fixture.');
  emptyTrace($('fixed-trace'), 'Preparing the paired comparison', 'The same schedule will run against the commit-time inventory check.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
    let data;
    try { data = await response.json(); } catch { throw new Error('The local engine returned an unreadable response. Start the server and try again.'); }
    if (!response.ok) throw new Error(errorMessage(data, response.status, response.headers.get('Retry-After')));
    validateReport(data, input); renderReport(data, input);
  } catch (error) {
    clearResults();
    const message = error.name === 'AbortError' ? 'The HTTP request timed out. No completed comparison was recorded. Try again when the local engine is available.' : error instanceof TypeError ? 'Could not reach the local engine. Keep this page open through the Ghost Replay server, then try again.' : error.message;
    showError(message);
  } finally { clearTimeout(timeout); setBusy(false); }
}
function showError(message) {
  $('error-message').textContent = message; $('error-box').hidden = false; setStatus('Experiment incomplete', 'failed');
}

for (const [index, preset] of PRESETS.entries()) {
  const option = element('div', 'preset-option');
  const radio = element('input'); radio.type = 'radio'; radio.name = 'preset'; radio.id = `preset-${preset.id}`; radio.value = preset.id; radio.checked = index === 0;
  radio.setAttribute('aria-label', `${preset.name}: ${preset.steps.join(', ')}`);
  const label = element('label'); label.htmlFor = radio.id;
  const name = element('span', 'preset-name', preset.name); name.append(element('span', 'radio-mark'));
  const detail = element('span', 'preset-detail', preset.steps.map(step => step.replace(':read', 'r').replace(':commit', 'c')).join(' → ')); detail.setAttribute('aria-hidden', 'true');
  label.append(name, detail); option.append(radio, label); $('preset-grid').append(option);
  radio.addEventListener('change', refreshInputs);
}
$('stock').addEventListener('change', refreshInputs); $('include-noise').addEventListener('change', refreshInputs);
$('run-button').addEventListener('click', run);
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); run(); } });
$('download-json').addEventListener('click', () => {
  if (!completed || busy) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(completed, null, 2) + '\n'], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `ghost-replay-${completed.runId}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('export-status').textContent = 'JSON download requested for this completed run.';
});
$('copy-cli').addEventListener('click', async () => {
  if (!completedInput || busy) return;
  try { await navigator.clipboard.writeText(reproCLI(completedInput)); $('export-status').textContent = 'Reproduction commands copied. Run them from the Ghost Replay repository.'; }
  catch {
    $('export-status').textContent = 'Clipboard access is unavailable. Commands are shown below; use Ctrl/Cmd+C to copy the selection.';
    $('cli-details').open = true; $('repro-commands').focus(); $('repro-commands').select();
  }
});
refreshInputs();
