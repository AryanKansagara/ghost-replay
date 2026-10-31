// Hosted container smoke; never prints capability tokens or request bodies.
const base=process.env.SMOKE_URL||'http://127.0.0.1:3000';
async function call(path,method='GET',data,token){const response=await fetch(base+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json'}),...(token?{'X-Workspace-Token':token}:{})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(3000)});return {status:response.status,data:await response.json()};}
function expect(value,message){if(!value)throw Error(message);}
try{
 const a=await call('/api/workspaces','POST',{}),b=await call('/api/workspaces','POST',{});expect(a.status===201&&b.status===201,'bootstrap');const token=a.data.workspaceToken;
 const save=await call('/api/scenarios','POST',{name:'Container smoke',requests:[{method:'GET',url:'https://example.com/'}]},token);expect(save.status===200,'save');const id=save.data.scenario.id;
 expect((await call('/api/scenarios?id='+id,'GET',undefined,b.data.workspaceToken)).status===404,'isolation');
 expect((await call('/api/scenarios?id='+id,'GET',undefined,token)).data.scenario.requests.length===1,'reopen');
 expect((await call('/api/runs','POST',{requests:[{method:'GET',url:'https://127.0.0.1/'}]},token)).status===400,'private destination');
 expect((await call('/api/workspace','GET',undefined,token)).data.scenarios.length===1,'history');
 expect((await call('/api/scenarios','DELETE',{id},token)).status===200,'delete trace');
 expect((await call('/api/workspace','DELETE',{},token)).status===200,'delete workspace');
 expect((await call('/api/workspace','GET',undefined,token)).status===401,'invalidate');
 await call('/api/workspace','DELETE',{},b.data.workspaceToken);
 console.log(JSON.stringify({productSmoke:'passed',checks:9,externalTargetRequests:0}));
}catch{console.error('{"productSmoke":"failed"}');process.exitCode=1;}
