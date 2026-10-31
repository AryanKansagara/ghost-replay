import https from 'node:https';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { HttpError } from '../schema.mjs';
import { targetURL, resolvePublic, redactText } from './security.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export async function publicFetch(input,{signal,auth,resolver,transport=https.request}={}){
 const url=targetURL(input.url), address=await resolvePublic(url,signal,resolver);
 const headers={Accept:'application/json, text/plain;q=0.9, */*;q=0.1','Accept-Encoding':'identity','User-Agent':'GhostReplay/1.0 (read-only trace replay)'};
 if(auth&&url.hostname===auth.hostname)headers[auth.header]=auth.value;
 return new Promise((resolve,reject)=>{
  let done=false;const finish=(error,value)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const request=transport(url,{method:input.method,headers,agent:false,rejectUnauthorized:true,servername:url.hostname.replace(/^\[|\]$/g,''),lookup:(_host,options,cb)=>{if(options?.all)cb(null,[address]);else cb(null,address.address,address.family);}},response=>{
   let size=0;const chunks=[];response.on('data',chunk=>{size+=chunk.length;if(size>65536){request.destroy(new HttpError(502,'response_too_large','Response exceeds 64 KiB.'));return;}chunks.push(chunk);});
   response.once('error',error=>finish(error));response.once('end',()=>{
    if(response.headers['content-encoding']&&!/^identity$/i.test(response.headers['content-encoding']))return finish(new HttpError(502,'encoded_response','Server ignored identity encoding; compressed responses are not replayed.'));
    let body;try{body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{return finish(new HttpError(502,'binary_response','Only UTF-8 response bodies are supported.'));}
    const safeHeaders={};for(const key of ['content-type','cache-control','etag','last-modified','content-length'])if(typeof response.headers[key]==='string')safeHeaders[key]=response.headers[key].slice(0,512);
    finish(null,{status:response.statusCode,headers:safeHeaders,body,bodyBytes:size});
   });
  });
  const abort=()=>request.destroy(signal.reason||new Error('cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  request.once('error',error=>finish(error));request.end();
 });
}
export async function executeRequests(inputs,{signal,auth,fetcher=publicFetch}={}){
 const secrets=auth?[auth.value,...(auth.header==='Authorization'?auth.value.split(/\s+/).slice(1):[])]:[];const results=[];
 for(const input of inputs){if(signal.aborted)throw signal.reason;const began=performance.now();const result={id:input.id,label:input.label,url:input.url,method:input.method,actual:null,baseline:{},comparison:{statusChanged:null,bodyChanged:null,firstDifference:null},assertions:[],redacted:false};
  if(input.baseline?.status!==undefined)result.baseline.status=input.baseline.status;
  if(input.baseline?.bodyText!==undefined){result.baseline.bodyPreview=input.baseline.bodyText;result.baseline.bodySha256=hash(input.baseline.bodyText);}
  try{
   const local=AbortSignal.any([signal,AbortSignal.timeout(3000)]);const raw=await fetcher(input,{signal:local,auth});const durationMs=Math.round(performance.now()-began);const body=redactText(raw.body,secrets);result.redacted=body!==raw.body;
   result.actual={status:raw.status,durationMs,headers:Object.fromEntries(Object.entries(raw.headers).map(([k,v])=>[k,redactText(v,secrets)])),bodyPreview:body.slice(0,4096),bodyBytes:raw.bodyBytes,bodyTruncated:body.length>4096,bodySha256:hash(body)};
   if(input.baseline?.status!==undefined)result.comparison.statusChanged=input.baseline.status!==raw.status;
   if(input.baseline?.bodyText!==undefined){const before=input.baseline.bodyText;result.comparison.bodyChanged=before!==body;if(before!==body){let index=0;while(index<Math.min(before.length,body.length)&&before[index]===body[index])index++;result.comparison.firstDifference={index,before:before.slice(Math.max(0,index-30),index+90),after:body.slice(Math.max(0,index-30),index+90)};}}
   for(const [kind,expected]of Object.entries(input.assertions||{})){const passed=kind==='status'?raw.status===expected:kind==='bodyIncludes'?body.includes(expected):durationMs<=expected;result.assertions.push({kind,expected,passed,message:passed?'Assertion passed.':'Assertion failed.'});}
   if(raw.status>=300&&raw.status<400)result.error={code:'redirect_blocked',message:'Redirect received and not followed.'};
   result.outcome=result.error?'error':result.comparison.statusChanged||result.comparison.bodyChanged||result.assertions.some(a=>!a.passed)||(raw.status>=400&&input.baseline?.status===undefined&&input.assertions?.status===undefined)?'failed':'passed';
  }catch(error){result.assertions=Object.entries(input.assertions||{}).map(([kind,expected])=>({kind,expected,passed:null,message:'Not evaluated: no response was received.'}));result.outcome='error';result.error={code:error instanceof HttpError?error.code:(signal.aborted?'cancelled':'network_error'),message:error instanceof HttpError?error.message:'HTTPS request failed or exceeded its 3 second deadline.'};}
  result.durationMs=Math.round(performance.now()-began);results.push(result);
 }
 return results;
}
