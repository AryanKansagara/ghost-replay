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


/** Preference state is independent of the DOM and survives unavailable browser storage. */
export function resolveTheme(preference, systemDark) {
  return preference === 'light' || preference === 'dark' ? preference : systemDark ? 'dark' : 'light';
}
export function createThemeController({ readPreference, writePreference, systemDark, apply }) {
  let preference = null, storageAvailable = true;
  function load() {
    try { const value = readPreference(); preference = value === 'light' || value === 'dark' ? value : null; storageAvailable = true; }
    catch { preference = null; storageAvailable = false; }
  }
  function render() {
    const state = { theme: resolveTheme(preference, systemDark()), preference, storageAvailable };
    apply(state); return state;
  }
  function choose(value) {
    preference = value;
    try { writePreference(value); storageAvailable = true; } catch { storageAvailable = false; }
    return render();
  }
  load(); render();
  return {
    toggle() { return choose(resolveTheme(preference, systemDark()) === 'dark' ? 'light' : 'dark'); },
    useSystem() { return choose(null); },
    systemChanged() { return render(); },
    refresh() { load(); return render(); },
  };
}

// Product workspace helpers. The checkout protocol helpers above remain for legacy evidence tests.
export const MAX_REQUESTS = 6;
export const MAX_BASELINE = 4096;
export function newRequestId() {
  if (typeof globalThis.crypto?.randomUUID==='function') return globalThis.crypto.randomUUID();
  const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const credentialKey = key => /token|secret|password|api[-_]?key|authorization|credential|signature|session|^key$|^auth$|^code$/i.test(key);
export function publicRequestURL(value, { sanitize = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter an HTTPS URL of at most 2,048 characters.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete HTTPS URL, including the hostname.'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) throw new Error('Replay supports public HTTPS endpoints on port 443 only.');
  const host=url.hostname.toLowerCase();
  if (host==='localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || /^\[|^\d+\.\d+\.\d+\.\d+$/.test(host)) throw new Error('Use a public hostname. Local, private and literal IP destinations are not supported.');
  if (url.username || url.password) { if (!sanitize) throw new Error('Remove credentials from the URL; use the temporary authorization controls instead.'); url.username='';url.password=''; }
  const sensitive=[...url.searchParams.keys()].filter(credentialKey);
  if (sensitive.length && !sanitize) throw new Error('Remove credential query parameters; use temporary authorization instead.');
  sensitive.forEach(key=>url.searchParams.delete(key)); url.hash='';
  return url.href;
}
export function sanitizeBody(text) {
  if (typeof text !== 'string') return text;
  try {
    const source=JSON.parse(text);
    let redacted=false;
    const scrub = value => {
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,credentialKey(key)?(redacted=true,'[redacted]'):scrub(item)]));
      return value;
    };
    const clean=scrub(source);return redacted?JSON.stringify(clean,null,2):text;
  } catch { return text; }
}
export function parseHAR(text, idFactory = newRequestId) {
  if (typeof text!=='string' || new TextEncoder().encode(text).length>5*1024*1024) throw new Error('Choose a HAR file or JSON export smaller than 5 MiB.');
  let har;try{har=JSON.parse(text);}catch{throw new Error('This is not valid JSON. Export a HAR from your browser’s Network panel and try again.');}
  if (!Array.isArray(har?.log?.entries)) throw new Error('A HAR must contain log.entries. Paste the whole HAR export, not a single request.');
  const requests=[], warnings=[];let skipped=0,omittedBodies=0,cleanedURLs=0,unsupported=0;
  for (const entry of har.log.entries) {
    if (!['GET','HEAD'].includes(entry?.request?.method)) {skipped++;continue;}
    if(requests.length>=MAX_REQUESTS){skipped++;continue;}
    let url;
    try {url=publicRequestURL(entry.request.url,{sanitize:true});}
    catch {skipped++;unsupported++;continue;}
    if(url!==entry.request.url)cleanedURLs++;
    const baseline={};
    if(Number.isInteger(entry.response?.status)&&entry.response.status>=100&&entry.response.status<=599)baseline.status=entry.response.status;
    const content=entry.response?.content;
    if(entry.request.method!=='HEAD' && typeof content?.text==='string') {
      let body=content.text;
      try {
        if(content.encoding==='base64')body=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(body),c=>c.charCodeAt(0)));
        else if(content.encoding)throw new Error('unsupported encoding');
        if(body.length>MAX_BASELINE)throw new Error('oversized baseline');
        // Preserve byte-for-byte text when no recognized credential fields require redaction.
        const sanitized=sanitizeBody(body);
        const scrubbed=sanitized;
        if(scrubbed.length>MAX_BASELINE)throw new Error('oversized redacted baseline');
        baseline.bodyText=scrubbed;
      } catch {omittedBodies++;}
    }
    const target=new URL(url);
    requests.push({id:idFactory(),label:(target.pathname==='/'?target.hostname:target.pathname).slice(0,80),method:entry.request.method,url,...(Object.keys(baseline).length?{baseline}:{}),assertions:{}});
  }
  if(!requests.length)throw new Error('No supported public HTTPS GET or HEAD requests were found. Other methods and private destinations cannot be replayed.');
  if(skipped)warnings.push(`${skipped} ${skipped===1?'entry was':'entries were'} skipped (unsupported method, destination, or six-request limit).`);
  if(cleanedURLs)warnings.push(`${cleanedURLs} ${cleanedURLs===1?'URL was':'URLs were'} cleaned of fragments or credential fields.`);
  if(omittedBodies)warnings.push(`${omittedBodies} response ${omittedBodies===1?'body was':'bodies were'} omitted because the encoding or 4,096-character baseline limit was unsupported. Status baselines were kept.`);
  return {requests,warnings,skipped,omittedBodies,unsupported,imported:requests.length};
}
export function prepareRequests(requests) {
  if(!Array.isArray(requests)||!requests.length||requests.length>MAX_REQUESTS)throw new Error('Add between one and six requests before continuing.');
  const ids=new Set();
  return requests.map((request,index)=>{
    const prefix=`Request ${index+1}: `;
    if(typeof request.id!=='string'||!request.id||ids.has(request.id))throw new Error(prefix+'request identifiers must be unique.');
    ids.add(request.id);
    if(!['GET','HEAD'].includes(request.method))throw new Error(prefix+'only GET and HEAD can be replayed.');
    let url;try{url=publicRequestURL(request.url);}catch(error){throw new Error(prefix+error.message);}
    const value={id:request.id,label:(String(request.label||'').trim()||`Request ${index+1}`).slice(0,80),method:request.method,url};
    const baseline={},assertions={};
    for(const [source,dest] of [[request.baseline,baseline],[request.assertions,assertions]]) {
      if(source?.status!==undefined&&source.status!=='') {
        const number=typeof source.status==='number'?source.status:Number(source.status);
        if(!Number.isInteger(number)||number<100||number>599)throw new Error(prefix+'status must be an integer from 100 to 599.');
        dest.status=number;
      }
    }
    if(request.baseline?.bodyText!==undefined) {
      if(typeof request.baseline.bodyText!=='string'||request.baseline.bodyText.length>MAX_BASELINE)throw new Error(prefix+'baseline body must be at most 4,096 characters.');
      baseline.bodyText=request.baseline.bodyText;
    }
    if(request.assertions?.bodyIncludes) {
      if(typeof request.assertions.bodyIncludes!=='string'||request.assertions.bodyIncludes.length>256)throw new Error(prefix+'body assertion must be at most 256 characters.');
      assertions.bodyIncludes=request.assertions.bodyIncludes;
    }
    if(request.assertions?.maxDurationMs!==undefined&&request.assertions.maxDurationMs!=='') {
      const number=Number(request.assertions.maxDurationMs);
      if(typeof request.assertions.maxDurationMs==='boolean'||!Number.isInteger(number)||number<50||number>10000)throw new Error(prefix+'duration assertion must be 50–10,000 ms.');
      assertions.maxDurationMs=number;
    }
    if(Object.keys(baseline).length)value.baseline=baseline;
    if(Object.keys(assertions).length)value.assertions=assertions;
    return value;
  });
}
export function formatDuration(ms) {
  return typeof ms==='number'&&Number.isFinite(ms)?(ms<1000?`${Math.round(ms)} ms`:`${(ms/1000).toFixed(2)} s`):'—';
}
export function displayDate(value) {
  const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'Date unavailable';
}
export function comparePreview(before,after) {
  if(typeof before!=='string'||typeof after!=='string')return null;
  let index=0;while(index<before.length&&index<after.length&&before[index]===after[index])index++;
  if(index===before.length&&index===after.length)return null;
  return {index,before:before.slice(Math.max(0,index-35),index+100),after:after.slice(Math.max(0,index-35),index+100)};
}

/** Missing observations never imply either a passing check or an absent configuration. */
export function assertionViews(result, request) {
  const checks = Array.isArray(result?.assertions) ? result.assertions.map(check => ({ ...check })) : [];
  for (const [kind, expected] of Object.entries(request?.assertions || {})) {
    if (!checks.some(check => check.kind === kind)) checks.push({ kind, expected, passed: null,
      message: result?.actual === null ? 'Not evaluated: no response was received.' : 'No assertion outcome was retained in this run.' });
  }
  return checks.map(check => ({ ...check, state: check.passed === true ? 'passed' : check.passed === false ? 'failed' : 'not_evaluated' }));
}

/** Saving configuration does not send replay requests to the target. */
export function operationStatus(operation,count,connected) {
  if(operation==='save')return {running:false,label:'Saving trace…',caption:'SAVING TRACE',description:'Saving request configuration to your private workspace. No replay requests are being sent.'};
  if(operation==='replay')return {running:true,label:'Replaying…',caption:'REPLAY IN PROGRESS',description:'Waiting for live responses. Results are saved to your private workspace.'};
  return {running:false,label:`Replay ${count} ${count===1?'request':'requests'}`,caption:connected?'READY WHEN YOU ARE':'CONNECTING TO YOUR WORKSPACE',description:'Responses are measured live. Nothing is precomputed.'};
}
