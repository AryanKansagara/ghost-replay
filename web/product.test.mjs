import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertionViews, newRequestId, parseHAR, prepareRequests, publicRequestURL, sanitizeBody, comparePreview, formatDuration } from './helpers.mjs';
const uuid='00000000-0000-4000-8000-000000000001';
const entry=(url='https://example.com/health',method='GET',text='{"ok":true}')=>({request:{url,method,headers:[{name:'Authorization',value:'Bearer FORBIDDEN'},{name:'Cookie',value:'FORBIDDEN'}]},response:{status:200,headers:[{name:'Set-Cookie',value:'FORBIDDEN'}],content:{text}}});
const har=entries=>JSON.stringify({log:{entries}});
const manual=()=>({id:uuid,label:'Health',method:'GET',url:'https://example.com/health',assertions:{status:200,bodyIncludes:'ok',maxDurationMs:500}});

test('HAR import keeps real baseline and drops all request and response headers',()=>{
 const {requests}=parseHAR(har([entry()]),()=>uuid);
 assert.equal(requests[0].baseline.status,200);assert.equal(requests[0].baseline.bodyText,'{"ok":true}');
 assert.deepEqual(prepareRequests(requests),requests.map(({assertions,...record})=>record));
 assert.ok(!JSON.stringify(requests).includes('FORBIDDEN'));assert.ok(!('headers'in requests[0]));
});
test('HAR import filters unsupported methods and private destinations with explicit counts',()=>{
 const result=parseHAR(har([entry(),entry('https://example.com/action','POST'),entry('http://example.com/'),entry('https://127.0.0.1/'),entry('https://thing.local/')]),()=>uuid);
 assert.equal(result.imported,1);assert.equal(result.skipped,4);assert.ok(result.warnings.length);
 assert.throws(()=>parseHAR(har([entry('https://example.com/action','DELETE')])) ,/No supported/);
});
test('import removes URL credentials and recognized credential query values',()=>{
 const result=parseHAR(har([entry('https://user:FORBIDDEN@example.com/path?api_key=FORBIDDEN&safe=1#FORBIDDEN')]),()=>uuid);
 assert.equal(result.requests[0].url,'https://example.com/path?safe=1');assert.equal(result.imported,1);
 assert.ok(!JSON.stringify(result.requests).includes('FORBIDDEN'));
 assert.throws(()=>publicRequestURL('https://example.com/?access_token=secret'),/credential/);
 assert.throws(()=>publicRequestURL('https://user:secret@example.com/'),/credentials/);
});
test('base64 Unicode baselines decode correctly and unsupported/large bodies are not false prefixes',()=>{
 const value=entry();value.response.content={encoding:'base64',text:btoa(unescape(encodeURIComponent('🐧 café')))};
 const good=parseHAR(har([value]),()=>uuid);assert.equal(good.requests[0].baseline.bodyText,'🐧 café');
 for(const content of [{encoding:'gzip',text:'not supported'},{encoding:'base64',text:'not-base64?'},{text:'x'.repeat(4097)}]){
  const e=entry();e.response.content=content;const r=parseHAR(har([e]),()=>uuid);assert.equal(r.omittedBodies,1);assert.equal(r.requests[0].baseline.status,200);assert.equal(r.requests[0].baseline.bodyText,undefined);
 }
});
test('JSON credential keys are redacted without reformatting an ordinary baseline',()=>{
 const original='{ "ok": true, "note": "[redacted]" }';assert.equal(sanitizeBody(original),original);
 const result=parseHAR(har([entry('https://example.com/','GET','{"data":{"api_key":"FORBIDDEN"},"ok":true}')]),()=>uuid);
 assert.ok(!JSON.stringify(result.requests).includes('FORBIDDEN'));assert.match(result.requests[0].baseline.bodyText,/\[redacted\]/);
});
test('HAR bounds and malformed formats return actionable errors',()=>{
 for(const text of ['{','[]','{"entries":[]}'])assert.throws(()=>parseHAR(text),/JSON|HAR/);
 assert.throws(()=>parseHAR(' '.repeat(5*1024*1024+1)),/5 MiB/);
 let serial=0;const many=parseHAR(har(Array.from({length:9},()=>entry())),()=>`r-${++serial}`);assert.equal(many.requests.length,6);assert.equal(many.skipped,3);
});
test('request preparation whitelists config fields and never carries temporary credentials',()=>{
 const value={...manual(),headers:{Authorization:'FORBIDDEN'},auth:'FORBIDDEN',extra:'FORBIDDEN'};
 const [clean]=prepareRequests([value]);assert.deepEqual(clean,manual());assert.ok(!JSON.stringify(clean).includes('FORBIDDEN'));
 assert.equal(prepareRequests([{...manual(),label:'   '}])[0].label,'Request 1');
});
test('request preparation rejects unsupported transport, invalid assertions and duplicate identities',()=>{
 for(const url of ['http://example.com/','https://localhost/','https://10.0.0.1/','https://[::1]/','https://example.com:8080/','javascript:alert(1)','https://example.com/?signature=secret'])assert.throws(()=>prepareRequests([{...manual(),url}]));
 assert.throws(()=>prepareRequests([{...manual(),method:'POST'}]));assert.throws(()=>prepareRequests([manual(),manual()]));assert.throws(()=>prepareRequests([]));
 for(const assertions of [{status:99},{status:600},{bodyIncludes:'x'.repeat(257)},{maxDurationMs:49},{maxDurationMs:true},{maxDurationMs:10001}])assert.throws(()=>prepareRequests([{...manual(),assertions}]));
 assert.throws(()=>prepareRequests([{...manual(),baseline:{bodyText:'x'.repeat(4097)}}]));
});
test('preview comparisons and durations describe actual supplied values including empty/zero',()=>{
 assert.equal(comparePreview('',''),null);assert.equal(comparePreview(undefined,'body'),null);assert.equal(comparePreview('hello','help').index,3);
 assert.equal(formatDuration(0),'0 ms');assert.equal(formatDuration(1250),'1.25 s');assert.equal(formatDuration(null),'—');
});
test('product UI is blank until data and keeps secret storage/export boundaries explicit',()=>{
 const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
 assert.match(html,/Your first replay starts with a request/);assert.match(html,/id="har-file"/);assert.match(html,/id="auth-value" type="password"/);
 assert.match(app,/requests:\[\]/);assert.match(app,/workspaceKey='ghost-replay-workspace'/);
 assert.doesNotMatch(app,/localStorage\.setItem\([^,]*(?:auth|request|draft)/i);
 assert.doesNotMatch(app,/\.innerHTML\s*=/);assert.match(app,/X-Workspace-Token/);
 assert.match(app,/\/api\/scenarios/);assert.match(app,/\/api\/runs/);
 assert.doesNotMatch(html,/SHARED SNAPSHOT|checkout race|precomputed results/i);
});

test('browser request IDs remain UUIDs on HTTP previews without randomUUID',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 try {Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues(bytes){bytes.fill(127);return bytes;}}});assert.match(newRequestId(),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);}
 finally{Object.defineProperty(globalThis,'crypto',descriptor);}
});
test('prepared HAR and manual input match the actual backend request schema',async()=>{
 const {requests:backendRequests}=await import('../service/product/input.mjs');
 for(const source of [parseHAR(har([entry()]),()=>uuid).requests,[manual()]]) {
  const prepared=prepareRequests(source),validated=backendRequests(prepared);
  assert.equal(validated[0].id,prepared[0].id);assert.equal(validated[0].url,prepared[0].url);assert.equal(validated[0].method,prepared[0].method);
 }
});

test('network errors retain configured checks as not evaluated, including older empty assertion records',()=>{
 const request=manual(),result={actual:null,assertions:[],error:{code:'network_error'}};
 const views=assertionViews(result,request);assert.equal(views.length,3);
 assert.ok(views.every(check=>check.passed===null&&check.state==='not_evaluated'));
 assert.match(views[0].message,/no response/);assert.equal(views[0].expected,200);
 assert.deepEqual(result.assertions,[]);
});
test('backend null assertions stay neutral while actual pass/fail evidence is preserved',()=>{
 const result={actual:null,assertions:[{kind:'status',expected:200,passed:null,message:'Not evaluated: no response was received.'}]};
 assert.equal(assertionViews(result,{assertions:{status:200}})[0].state,'not_evaluated');
 assert.deepEqual(assertionViews({actual:{status:200},assertions:[{kind:'status',expected:200,passed:true},{kind:'bodyIncludes',expected:'missing',passed:false}]}).map(c=>c.state),['passed','failed']);
});
test('unretained checks are distinct from no configured checks',()=>{
 assert.deepEqual(assertionViews({actual:null,assertions:[]},{assertions:{}}),[]);
 const views=assertionViews({actual:{status:200},assertions:[]},{assertions:{status:200}});
 assert.equal(views[0].state,'not_evaluated');assert.match(views[0].message,/No assertion outcome/);
});
