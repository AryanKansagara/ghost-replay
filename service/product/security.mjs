import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { HttpError } from '../schema.mjs';

const denied4 = [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['168.63.129.16',32],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['192.88.99.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]];
function ipv4(value) { return value.split('.').reduce((n, part) => n * 256 + Number(part), 0) >>> 0; }
function ipv6(value) {
  if (value.includes('.')) {
    const last = value.lastIndexOf(':'); const n = ipv4(value.slice(last + 1));
    value = value.slice(0, last + 1) + (n >>> 16).toString(16) + ':' + (n & 65535).toString(16);
  }
  const halves = value.split('::'); const a = halves[0] ? halves[0].split(':') : [];
  const b = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1 ? a : [...a, ...Array(8-a.length-b.length).fill('0'), ...b];
  return groups.reduce((n, part) => (n << 16n) | BigInt('0x' + part), 0n);
}
export function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const n = ipv4(address);
    return !denied4.some(([base, bits]) => {
      const normalized = ipv4(base);
      const mask = (0xffffffff << (32-bits)) >>> 0;
      return ((n & mask) >>> 0) === ((normalized & mask) >>> 0);
    });
  }
  if (family !== 6 || address.includes('%')) return false;
  const n = ipv6(address);
  if ((n >> 32n) === 0xffffn) return publicAddress([24,16,8,0].map(shift => Number((n >> BigInt(shift)) & 255n)).join('.'));
  if ((n >> 125n) !== 1n) return false; // Global unicast 2000::/3 only.
  if ((n >> 105n) === (ipv6('2001::') >> 105n)) return false;
  if ((n >> 96n) === (ipv6('2001:db8::') >> 96n)) return false;
  if ((n >> 108n) === (ipv6('3fff::') >> 108n)) return false;
  if ((n >> 112n) === 0x2002n) return false; // Embedded 6to4 address can hide private IPv4.
  return true;
}
export const sensitiveKey = /authorization|cookie|password|passwd|secret|token|api[_-]?key|session|credential|signature/i;
export function targetURL(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new HttpError(400,'invalid_url','Use a public HTTPS URL without credentials.');
  let url; try { url = new URL(value); } catch { throw new HttpError(400,'invalid_url','Use a public HTTPS URL without credentials.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash)
    throw new HttpError(400,'invalid_url','Only public HTTPS port 443 without credentials or fragments is supported.');
  for (const key of url.searchParams.keys()) if (sensitiveKey.test(key) || /^(?:key|auth|apikey|accesstoken|refreshtoken|password|signature|sessionid)$/i.test(key))
    throw new HttpError(400,'credential_url','Remove credential-bearing URL parameters; use ephemeral authentication instead.');
  const host = url.hostname.replace(/^\[|\]$/g,'');
  if (isIP(host) && !publicAddress(host)) throw new HttpError(400,'private_destination','Private or special-use destinations are blocked.');
  if (!isIP(host) && (!host.includes('.') || host.endsWith('.') || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))
    throw new HttpError(400,'invalid_url','Use a canonical public DNS hostname.');
  return url;
}
export async function resolvePublic(url, signal, resolver = lookup) {
  const host = url.hostname.replace(/^\[|\]$/g,'');
  let records;
  if (isIP(host)) records = [{address:host,family:isIP(host)}];
  else {
    let listener;
    const cancelled = new Promise((_,reject) => { listener=()=>reject(signal.reason); signal.addEventListener('abort',listener,{once:true}); });
    try { if(signal.aborted) throw signal.reason; records = await Promise.race([resolver(host,{all:true,verbatim:true}),cancelled]); }
    finally { signal.removeEventListener('abort',listener); }
  }
  if (!Array.isArray(records) || records.length === 0 || records.length > 32 ||
      records.some(record => !publicAddress(record.address) || isIP(record.address) !== record.family))
    throw new HttpError(400,'private_destination','DNS must resolve exclusively to public addresses.');
  return records.find(record=>record.family===4) || records[0];
}

export function redactText(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length)) text=text.split(secret).join('[REDACTED]');
  try {
    const parsed=JSON.parse(text);
    const clean = (node, depth=0) => {
      if(depth>20) return '[REDACTED]';
      if(Array.isArray(node)) return node.map(value=>clean(value,depth+1));
      if(node&&typeof node==='object') return Object.fromEntries(Object.entries(node).map(([key,value])=>[key,sensitiveKey.test(key)||/^(?:apikey|accessToken|refreshToken|sessionId)$/i.test(key)?'[REDACTED]':clean(value,depth+1)]));
      return node;
    };
    text=JSON.stringify(clean(parsed));
  } catch {}
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer [REDACTED]')
    .replace(/((?:password|api[_-]?key|access[_-]?token|secret|authorization)\s*[=:]\s*)[^\s&,;"']+/gi,'$1[REDACTED]');
}
