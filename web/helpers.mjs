/** Pure presentation/input helpers; never manufactures experiment results. */
const definitions = [
  ['shared', 'Shared snapshot', ['A:read', 'B:read', 'A:commit', 'B:commit']],
  ['b-commit', 'B commits first', ['A:read', 'B:read', 'B:commit', 'A:commit']],
  ['b-arrival', 'B arrives first', ['B:read', 'A:read', 'A:commit', 'B:commit']],
  ['mirrored', 'Mirrored overlap', ['B:read', 'A:read', 'B:commit', 'A:commit']],
  ['a-serial', 'A completes first', ['A:read', 'A:commit', 'B:read', 'B:commit']],
  ['b-serial', 'B completes first', ['B:read', 'B:commit', 'A:read', 'A:commit']],
];
export const PRESETS = Object.freeze(definitions.map(([id, name, steps]) => Object.freeze({ id, name, steps: Object.freeze(steps) })));
const protocol = ['A:read', 'A:commit', 'B:read', 'B:commit'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateInput(input) {
  if (!object(input) || !Number.isInteger(input.stock) || input.stock < 0 || input.stock > 3
      || !Array.isArray(input.schedule) || input.schedule.length < 4 || input.schedule.length > 12
      || !input.schedule.every(step => typeof step === 'string' && (protocol.includes(step) || /^noise:[A-Za-z0-9_-]{1,48}$/.test(step)))
      || !protocol.every(step => input.schedule.filter(item => item === step).length === 1)
      || ['A', 'B'].some(actor => input.schedule.indexOf(`${actor}:read`) > input.schedule.indexOf(`${actor}:commit`)))
    throw new Error('Choose a valid schedule and an integer inventory from 0 to 3.');
  return input;
}

export function buildInput(presetId, stock, noise) {
  const preset = PRESETS.find(item => item.id === presetId);
  if (!preset || typeof noise !== 'boolean') throw new Error('Choose one of the six supported interleavings.');
  const schedule = [...preset.steps];
  if (noise) { schedule.splice(2, 0, 'noise:help'); schedule.unshift('noise:catalog'); }
  return validateInput({ stock, schedule });
}

export function shortStep(step) {
  return step.startsWith('noise:') ? step.slice(6) : step.replace(':', ' · ');
}

export function validateReport(data, input) {
  validateInput(input);
  if (!object(data) || typeof data.runId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(data.runId))
    throw new Error('The engine returned an invalid run reference.');
  for (const mode of ['buggy', 'fixed']) {
    const run = data[mode], result = run?.result;
    if (!object(run) || run.mode !== mode || !object(result) || result.complete !== true
        || !Number.isInteger(result.accepted) || result.accepted < 0 || result.accepted > 2
        || !Number.isInteger(result.final_inventory) || result.final_inventory !== input.stock - result.accepted
        || typeof result.invariant_violated !== 'boolean'
        || result.invariant_violated !== (result.final_inventory < 0 || result.accepted > input.stock)
        || run.fixture?.stock !== input.stock
        || JSON.stringify(run.schedule?.steps) !== JSON.stringify(input.schedule)
        || !Array.isArray(run.events) || run.events.length !== input.schedule.length
        || !run.events.every((event, index) => object(event) && event.operation === input.schedule[index] && event.sequence === index))
      throw new Error('The engine returned incomplete or inconsistent observations. No comparison was displayed.');
    for (const event of run.events) {
      if (event.operation.endsWith(':read') && !Number.isInteger(event.inventory))
        throw new Error('The engine returned an incomplete inventory read.');
      if (event.operation.endsWith(':commit') && (typeof event.accepted !== 'boolean'
          || !Number.isInteger(event.inventory_before) || !Number.isInteger(event.inventory_after)))
        throw new Error('The engine returned an incomplete checkout commit.');
    }
  }
  if (data.minimization !== null) {
    const witness = data.minimization;
    if (!object(witness) || !data.buggy.result.invariant_violated)
      throw new Error('The engine returned an inconsistent minimization result.');
    validateInput({ stock: input.stock, schedule: witness.schedule });
    let cursor = 0;
    for (const step of input.schedule) if (step === witness.schedule[cursor]) cursor++;
    if (witness.original_steps !== input.schedule.length || witness.minimal_steps !== witness.schedule.length
        || cursor !== witness.schedule.length || !Number.isInteger(witness.trials) || witness.trials < 0)
      throw new Error('The reduced witness does not match this experiment.');
  }
  return data;
}

export function eventPresentation(event) {
  const operation = event.operation;
  if (operation.startsWith('noise:')) return { actor: '·', title: operation.slice(6), detail: 'No effect on checkout state', value: '—', verdict: '', tone: 'neutral', noise: true };
  const [actor, phase] = operation.split(':');
  if (phase === 'read') return { actor, title: 'Read inventory', detail: `Request ${actor} stores a snapshot`, value: String(event.inventory), verdict: 'snapshot', tone: 'neutral', noise: false };
  return { actor, title: 'Commit checkout', detail: event.accepted ? `Request ${actor} accepted` : `Request ${actor} declined`,
    value: `${event.inventory_before} → ${event.inventory_after}`, verdict: event.accepted ? 'accepted' : 'rejected',
    tone: event.inventory_after < 0 ? 'danger' : event.accepted ? 'neutral' : 'safe', noise: false };
}

export function reproCLI(input) {
  validateInput(input);
  const recipe = JSON.stringify({ schema_version: 1, stock: input.stock, schedule: input.schedule }, null, 2);
  // Fixed filename/delimiter, JSON integers, and restricted operation alphabet: no shell expansion.
  return `cat > ghost-replay-case.json <<'GHOST_REPLAY_CASE'\n${recipe}\nGHOST_REPLAY_CASE\npython -m ghost_replay reproduce --bundle ghost-replay-case.json --mode buggy\npython -m ghost_replay reproduce --bundle ghost-replay-case.json --mode fixed\n`;
}

export function errorMessage(body, status, retryAfter) {
  const detail = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 240) : '';
  const defaults = { 400: 'The engine rejected these experiment inputs.', 413: 'The request is too large.',
    415: 'The engine requires a JSON request.', 429: 'The engine is busy or its request limit was reached.',
    503: 'The local engine is unavailable.', 504: 'The experiment reached its execution deadline.' };
  const retry = /^\d{1,3}$/.test(retryAfter ?? '') ? ` Try again after ${Number(retryAfter)} seconds.` : '';
  return (detail || defaults[status] || `The local engine returned HTTP ${status}.`) + retry;
}
