export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const invalid = () => new HttpError(400, 'invalid_request', 'Use a valid schedule and stock between 0 and 100.');
const required = ['A:read', 'A:commit', 'B:read', 'B:commit'];

export function validateRequest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).length !== 2 || !Object.hasOwn(data, 'schedule') || !Object.hasOwn(data, 'stock') ||
      !Number.isInteger(data.stock) || data.stock < 0 || data.stock > 100 ||
      !Array.isArray(data.schedule) || data.schedule.length < 4 || data.schedule.length > 12) throw invalid();
  for (const step of data.schedule) {
    if (typeof step !== 'string' || (!required.includes(step) && !/^noise:[A-Za-z0-9_-]{1,48}$/.test(step))) throw invalid();
  }
  for (const step of required) if (data.schedule.filter(value => value === step).length !== 1) throw invalid();
  for (const actor of ['A', 'B']) if (data.schedule.indexOf(`${actor}:read`) > data.schedule.indexOf(`${actor}:commit`)) throw invalid();
  return data;
}

// Deliberately restricted JSON parser for this one request contract. In particular,
// duplicate keys and integer spellings containing a fraction/exponent fail closed.
export function parseRequest(text) {
  let i = 0;
  const whitespace = () => { while (i < text.length && /[ \t\r\n]/.test(text[i])) i++; };
  const take = char => { whitespace(); if (text[i++] !== char) throw invalid(); };
  const string = () => {
    whitespace(); const start = i; if (text[i++] !== '"') throw invalid();
    while (i < text.length) {
      const char = text[i++];
      if (char === '\\') { if (i === text.length) throw invalid(); i++; }
      else if (char === '"') {
        try { return JSON.parse(text.slice(start, i)); } catch { throw invalid(); }
      }
    }
    throw invalid();
  };
  const array = () => {
    take('['); const values = []; whitespace();
    if (text[i] === ']') { i++; return values; }
    while (true) {
      values.push(string()); if (values.length > 12) throw invalid(); whitespace();
      if (text[i] === ']') { i++; return values; }
      take(',');
    }
  };
  const integer = () => {
    whitespace(); const match = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(i));
    if (!match || match[0].length > 4) throw invalid(); i += match[0].length;
    return Number(match[0]);
  };
  take('{'); const data = Object.create(null), keys = new Set();
  while (true) {
    const key = string(); if (keys.has(key) || !['schedule', 'stock'].includes(key)) throw invalid();
    keys.add(key); take(':'); data[key] = key === 'schedule' ? array() : integer(); whitespace();
    if (text[i] === '}') { i++; break; } take(',');
  }
  whitespace(); if (i !== text.length) throw invalid();
  return validateRequest(data);
}
