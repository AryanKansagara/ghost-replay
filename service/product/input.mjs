import { randomUUID } from 'node:crypto';
import { HttpError } from '../schema.mjs';
import { targetURL, redactText } from './security.mjs';
const bad = () => new HttpError(400,'invalid_request','Use the documented trace request schema.');
export function object(value, allowed, required=allowed) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key))) throw bad();
}
function text(value,maximum,empty=false) { if(typeof value!=='string'||value.length>maximum||(!empty&&!value.trim()))throw bad(); return value; }
export function identifier(value) { if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))throw bad();return value; }
export function name(value) { return text(value,80); }
export function requests(value,secrets=[]) {
  if(!Array.isArray(value)||value.length<1||value.length>6)throw bad(); const seen=new Set();
  return value.map(input=>{
    object(input,['id','label','method','url','baseline','assertions'],['method','url']);
    const id=input.id===undefined?randomUUID():identifier(input.id);if(seen.has(id))throw bad();seen.add(id);
    if(!['GET','HEAD'].includes(input.method))throw bad();
    const canonicalURL=targetURL(input.url).href;
    let decodedURL=canonicalURL;try{decodedURL=decodeURIComponent(canonicalURL);}catch{}
    if(secrets.some(secret=>secret&&(canonicalURL.includes(secret)||decodedURL.includes(secret))))throw new HttpError(400,'credential_url','Remove authentication values from URLs.');
    const request={id,label:redactText(input.label===undefined?'Request':text(input.label,80),secrets),method:input.method,url:canonicalURL};
    if(input.baseline!==undefined){object(input.baseline,['status','bodyText'],[]);const baseline={};
      if(input.baseline.status!==undefined){if(!Number.isInteger(input.baseline.status)||input.baseline.status<100||input.baseline.status>599)throw bad();baseline.status=input.baseline.status;}
      if(input.baseline.bodyText!==undefined)baseline.bodyText=redactText(text(input.baseline.bodyText,4096,true),secrets);
      request.baseline=baseline;
    }
    if(input.assertions!==undefined){object(input.assertions,['status','bodyIncludes','maxDurationMs'],[]);const a={};
      if(input.assertions.status!==undefined){if(!Number.isInteger(input.assertions.status)||input.assertions.status<100||input.assertions.status>599)throw bad();a.status=input.assertions.status;}
      if(input.assertions.bodyIncludes!==undefined)a.bodyIncludes=redactText(text(input.assertions.bodyIncludes,256),secrets);
      if(input.assertions.maxDurationMs!==undefined){if(!Number.isInteger(input.assertions.maxDurationMs)||input.assertions.maxDurationMs<50||input.assertions.maxDurationMs>10000)throw bad();a.maxDurationMs=input.assertions.maxDurationMs;}
      request.assertions=a;
    }
    return request;
  });
}
export function authentication(value) {
  if(value===undefined)return null;object(value,['header','value','hostname']);
  if(!['Authorization','X-Api-Key'].includes(value.header)||typeof value.value!=='string'||!value.value||value.value.length>2048||/[^\x20-\x7e]/.test(value.value))throw bad();
  if(typeof value.hostname!=='string')throw bad();const url=targetURL('https://'+value.hostname+'/');if(url.hostname!==value.hostname)throw bad();
  return {header:value.header,value:value.value,hostname:value.hostname};
}
export function strictJSON(text) {
  let i=0;
  const ws=()=>{while(/[ \r\n\t]/.test(text[i]||'!'))i++;};
  const str=()=>{ws();const begin=i;if(text[i++]!=='"')throw bad();while(i<text.length){const c=text[i++];if(c==='\\')i++;else if(c==='"'){try{return JSON.parse(text.slice(begin,i));}catch{throw bad();}}}throw bad();};
  const value=(depth=0)=>{if(depth>12)throw bad();ws();const c=text[i];
    if(c==='"')return str();
    if(c==='{'){i++;const out=Object.create(null);ws();if(text[i]==='}'){i++;return out;}while(true){const key=str();if(Object.hasOwn(out,key)||['__proto__','prototype','constructor'].includes(key))throw bad();ws();if(text[i++]!==':')throw bad();out[key]=value(depth+1);ws();if(text[i]==='}'){i++;return out;}if(text[i++]!==',')throw bad();}}
    if(c==='['){i++;const out=[];ws();if(text[i]===']'){i++;return out;}while(true){if(out.length>=64)throw bad();out.push(value(depth+1));ws();if(text[i]===']'){i++;return out;}if(text[i++]!==',')throw bad();}}
    const match=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));if(!match)throw bad();i+=match[0].length;const result=JSON.parse(match[0]);if(typeof result==='number'&&!Number.isFinite(result))throw bad();return result;
  };
  try{const out=value();ws();if(i!==text.length)throw bad();return out;}catch{throw bad();}
}
