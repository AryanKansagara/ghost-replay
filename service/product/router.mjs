import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { HttpError } from '../schema.mjs';
import { WorkspaceStore } from './store.mjs';
import { strictJSON, object, identifier, name, requests, authentication } from './input.mjs';
import { redactText } from './security.mjs';
import { executeRequests } from './executor.mjs';
const routes=new Set(['/api/workspaces','/api/workspace','/api/scenarios','/api/runs']);
export function createProduct({dataDir,fetcher}={}){
 const store=new WorkspaceStore(dataDir);let active=null,closed=false,budget=10,refill=performance.now(),metadata=120,metadataAt=refill;
 const send=(res,status,value)=>{if(res.destroyed||res.writableEnded)return;const body=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length});res.end(body);};
 const fail=(res,error)=>{res.setHeader('Connection','close');const e=error?.errcode===13?new HttpError(507,'storage_capacity','Workspace disk capacity reached; delete saved items before retrying.'):error instanceof HttpError?error:new HttpError(503,'storage_unavailable','Workspace storage is unavailable.');if([429,503].includes(e.status))res.setHeader('Retry-After','6');send(res,e.status,{error:{code:e.code,message:e.message}});};
 async function body(req,signal){if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')||(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity'))throw new HttpError(415,'unsupported_media_type','Use uncompressed application/json UTF-8.');
  if(Number(req.headers['content-length'])>65536)throw new HttpError(413,'body_too_large','Trace body exceeds 64 KiB.');
  return new Promise((resolve,reject)=>{let size=0,chunks=[];const clean=()=>{clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',end);req.removeListener('aborted',abort);req.removeListener('error',abort);signal.removeEventListener('abort',abort);};const bad=e=>{clean();req.resume();reject(e);};const abort=()=>bad(new HttpError(499,'cancelled','Request cancelled.'));const data=chunk=>{size+=chunk.length;if(size>65536)bad(new HttpError(413,'body_too_large','Trace body exceeds 64 KiB.'));else chunks.push(chunk);};const end=()=>{clean();try{resolve(strictJSON(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(new HttpError(400,'invalid_request','Use valid UTF-8 JSON and the documented schema.'));}};const timer=setTimeout(()=>bad(new HttpError(408,'body_timeout','Trace body did not arrive in time.')),2000);req.on('data',data);req.once('end',end);req.once('aborted',abort);req.once('error',abort);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 }
 return {
  matches:path=>routes.has(path),get ready(){return !closed;},get busy(){return active!==null;},
  async handle(req,res){const controller=new AbortController();const disconnect=()=>{if(!res.writableFinished)controller.abort(new HttpError(499,'cancelled','Request cancelled.'));};res.once('close',disconnect);
   try{if(closed)throw new HttpError(503,'not_ready','Workspace service is shutting down.');const now=performance.now();metadata=Math.min(120,metadata+(now-metadataAt)*120/60000);metadataAt=now;if(metadata<1)throw new HttpError(429,'rate_limited','Workspace request budget exhausted.');metadata--;
    const url=new URL(req.url,'http://service.invalid');if([...url.searchParams.keys()].some(k=>k!=='id')||url.searchParams.getAll('id').length>1)throw new HttpError(400,'invalid_request','Unsupported query.');const path=url.pathname;
    if(path==='/api/workspaces'&&req.method==='POST'){object(await body(req,controller.signal),[]);return send(res,201,store.create());}
    const workspace=store.authenticate(req.headers['x-workspace-token']);
    if(path==='/api/workspace'&&req.method==='GET')return send(res,200,{workspace,scenarios:store.list(workspace.id,'scenario').map(s=>({id:s.id,name:s.name,requestCount:s.requests.length,updatedAt:s.updatedAt})),runs:store.list(workspace.id,'run').map(r=>({id:r.id,name:r.name,createdAt:r.createdAt,summary:r.summary,durationMs:r.durationMs}))});
    if(path==='/api/workspace'&&req.method==='DELETE'){if(active)throw new HttpError(409,'busy','Wait for the active replay before deleting a workspace.');object(await body(req,controller.signal),[]);store.destroy(workspace.id);return send(res,200,{deleted:true});}
    const kind=path==='/api/scenarios'?'scenario':path==='/api/runs'?'run':null;
    if(kind&&req.method==='GET')return send(res,200,{[kind]:store.get(workspace.id,kind,identifier(url.searchParams.get('id')))});
    if(kind&&req.method==='DELETE'){const data=await body(req,controller.signal);object(data,['id']);store.delete(workspace.id,kind,identifier(data.id));return send(res,200,{deleted:true});}
    if(kind==='scenario'&&req.method==='POST'){const data=await body(req,controller.signal);object(data,['id','name','requests'],['name','requests']);const id=data.id===undefined?randomUUID():identifier(data.id);let createdAt=new Date().toISOString();if(data.id!==undefined)createdAt=store.get(workspace.id,kind,id).createdAt;const scenario={id,name:redactText(name(data.name)),requests:requests(data.requests),createdAt,updatedAt:new Date().toISOString()};return send(res,200,{scenario:store.put(workspace.id,kind,scenario)});}
    if(kind==='run'&&req.method==='POST'){
     if(active)throw new HttpError(429,'busy','A replay is already running. Try again shortly.');const data=await body(req,controller.signal);object(data,['name','requests','auth'],['requests']);const auth=authentication(data.auth);const secrets=auth?[auth.value,...(auth.header==='Authorization'?auth.value.split(/\s+/).slice(1):[])]:[];const canonical=requests(data.requests,secrets);if(auth&&!canonical.some(r=>new URL(r.url).hostname===auth.hostname))throw new HttpError(400,'invalid_auth_scope','Authentication hostname must match a request exactly.');
     if(active)throw new HttpError(429,'busy','A replay is already running. Try again shortly.');const now=performance.now();budget=Math.min(10,budget+(now-refill)*10/60000);refill=now;if(budget<1)throw new HttpError(429,'rate_limited','Replay budget exhausted.');budget--;active=controller;const began=performance.now(),timer=setTimeout(()=>controller.abort(new HttpError(504,'run_timeout','Replay exceeded 19 seconds.')),19000);
     try{const run={id:randomUUID(),name:redactText(data.name===undefined?'Untitled replay':name(data.name),secrets),createdAt:new Date().toISOString(),requests:canonical};run.results=await executeRequests(canonical,{signal:controller.signal,auth,fetcher});if(controller.signal.aborted)throw controller.signal.reason;run.durationMs=Math.round(performance.now()-began);run.summary={total:run.results.length,passed:0,failed:0,errors:0,changed:0};for(const r of run.results){run.summary[r.outcome==='error'?'errors':r.outcome]++;if(r.comparison.statusChanged||r.comparison.bodyChanged)run.summary.changed++;}store.put(workspace.id,'run',run);return send(res,200,{run});}finally{clearTimeout(timer);active=null;}
    }
    throw new HttpError(405,'method_not_allowed','Unsupported workspace operation.');
   }catch(error){fail(res,error);}finally{res.removeListener('close',disconnect);}
  },
  async close(){closed=true;active?.abort(new HttpError(503,'shutting_down','Service shutting down.'));while(active)await new Promise(r=>setTimeout(r,10));store.close();},store
 };
}
