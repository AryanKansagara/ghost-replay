// Standalone Vercel Node function. The trusted Python engine remains on Railway.
export const BACKEND_URL = 'https://ghost-replay-production.up.railway.app/api/run';
export const FRONTEND_ORIGIN = 'https://ghost-replay.vercel.app';
const REQUEST_LIMIT = 16_384;
const RESPONSE_LIMIT = 262_144;

class RelayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function json(data, status = 200, retryAfter) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (retryAfter && /^[0-9]{1,3}$/.test(retryAfter) && Number(retryAfter) >= 1 && Number(retryAfter) <= 120) headers['Retry-After'] = retryAfter;
  // Never inherit upstream Content-Encoding, Content-Length, cookies or proxy headers.
  return Response.json(data, { status, headers });
}
function aborted(signal) {
  if (signal.aborted) throw signal.reason;
}
async function withAbort(promise, signal) {
  const operation = Promise.resolve(promise);
  if (signal.aborted) { void operation.catch(() => {}); throw signal.reason; }
  let listener;
  const interrupted = new Promise((_, reject) => {
    listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { signal.removeEventListener('abort', listener); }
}
async function boundedBytes(body, limit, signal, overflow) {
  if (!body) return new Uint8Array();
  const reader = body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength; if (size > limit) throw overflow;
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { try { reader.releaseLock(); } catch {} }
  const result = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

// Injection is for authored tests only; HTTP inputs cannot select a target or transport.
export function createRelay({ fetchImpl = globalThis.fetch, timeoutMs = 12_000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000) throw new Error('Invalid relay deadline');
  return async function POST(request) {
    if (request.method !== 'POST') {
      const response = json({ error: { code: 'method_not_allowed', message: 'Use POST for experiments.' } }, 405);
      response.headers.set('Allow', 'POST'); return response;
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      aborted(signal);
      const origin = request.headers.get('Origin');
      if ((origin && origin !== FRONTEND_ORIGIN) || (request.headers.get('Sec-Fetch-Site') === 'cross-site' && origin !== FRONTEND_ORIGIN))
        throw new RelayError(403, 'cross_origin', 'Cross-origin experiment requests are not allowed.');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '') ||
          (request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding').toLowerCase() !== 'identity'))
        throw new RelayError(415, 'unsupported_media_type', 'Use uncompressed application/json UTF-8.');
      const declared = request.headers.get('Content-Length');
      if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > REQUEST_LIMIT))
        throw new RelayError(413, 'body_too_large', 'Request body exceeds 16 KiB.');
      const bytes = await boundedBytes(request.body, REQUEST_LIMIT, signal,
        new RelayError(413, 'body_too_large', 'Request body exceeds 16 KiB.'));
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); JSON.parse(text); }
      catch { throw new RelayError(400, 'invalid_request', 'Request body must be valid UTF-8 JSON.'); }
      // Preserve original JSON text: duplicate-key/schema rejection remains with the
      // existing strict backend; do not parse and reserialize away invalid fields.
      const upstream = await withAbort(fetchImpl(BACKEND_URL, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json',
          'Accept-Encoding': 'identity', Origin: FRONTEND_ORIGIN }, body: text,
      }), signal);
      const raw = await boundedBytes(upstream.body, RESPONSE_LIMIT, signal,
        new RelayError(502, 'upstream_too_large', 'The experiment returned an oversized response.'));
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { throw new RelayError(502, 'upstream_invalid_json', 'The experiment returned an invalid JSON response.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || upstream.status < 200 ||
          upstream.status > 599 || [204, 205, 304].includes(upstream.status))
        throw new RelayError(502, 'upstream_invalid_json', 'The experiment returned an invalid JSON response.');
      return json(data, upstream.status, upstream.headers.get('Retry-After'));
    } catch (error) {
      if (signal.aborted) return json({ error: {
        code: request.signal.aborted ? 'request_cancelled' : 'upstream_timeout',
        message: request.signal.aborted ? 'The request was cancelled.' : 'The experiment exceeded its relay time budget.',
      } }, request.signal.aborted ? 499 : 504);
      const safe = error instanceof RelayError ? error : new RelayError(502, 'upstream_unavailable', 'The experiment service is unavailable.');
      return json({ error: { code: safe.code, message: safe.message } }, safe.status);
    }
  };
}

export const POST = createRelay();
export default { fetch: POST };
