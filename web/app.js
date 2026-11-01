import { createThemeController, newRequestId, MAX_REQUESTS, parseHAR, prepareRequests, publicRequestURL, formatDuration, displayDate, assertionViews, operationStatus } from '/helpers.mjs';
const $ = id => document.getElementById(id);
const el = (tag, className, text) => { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text;return node; };
const themeKey='ghost-replay-theme', workspaceKey='ghost-replay-workspace';
const colorPreference=window.matchMedia('(prefers-color-scheme: dark)');
const themes=createThemeController({readPreference:()=>localStorage.getItem(themeKey),writePreference:value=>value===null?localStorage.removeItem(themeKey):localStorage.setItem(themeKey,value),systemDark:()=>colorPreference.matches,apply:({theme,preference,storageAvailable})=>{
  document.documentElement.dataset.theme=theme; $('theme-label').textContent=theme==='dark'?'Dark':'Light';
  $('theme-toggle').setAttribute('aria-label',`Switch to ${theme==='dark'?'light':'dark'} theme`);$('theme-system').setAttribute('aria-pressed',String(preference===null));
  $('theme-status').textContent=`${theme} theme. ${preference===null?'Following system appearance.':'User preference selected.'}${storageAvailable?'':' Browser storage is unavailable; this choice applies to this page only.'}`;
  document.querySelector('meta[name="theme-color"]').setAttribute('content',theme==='dark'?'#101215':'#f5f6f3');
}});
$('theme-toggle').addEventListener('click',()=>themes.toggle());$('theme-system').addEventListener('click',()=>themes.useSystem());colorPreference.addEventListener('change',()=>themes.systemChanged());
window.addEventListener('storage',event=>{if(event.key===themeKey||event.key===null)themes.refresh();});
const state={token:null,workspace:null,scenarios:[],runs:[],requests:[],selected:null,scenarioId:null,dirty:false,busy:false,operation:null,connecting:false,connected:false,view:'studio',report:null,historyRun:null};
let storageAvailable=true,confirmResolve=null,importEpoch=0;
function notify(message){$('notification-text').textContent=message;$('notification').hidden=false;}
function showError(message,title='Something needs your attention'){ $('error-title').textContent=title;$('error-text').textContent=message;$('error-banner').hidden=false; }
function hideError(){$('error-banner').hidden=true;$('retry-workspace').hidden=true;}
function selected(){return state.requests.find(r=>r.id===state.selected);}
function markDirty(){state.dirty=true;$('draft-status').textContent='UNSAVED CHANGES';updateActions();}
function clearAuth(){ $('auth-enabled').checked=false;$('auth-value').value='';$('auth-host').value='';$('auth-fields').hidden=true; }
function persistToken(token){try{token?localStorage.setItem(workspaceKey,token):localStorage.removeItem(workspaceKey);storageAvailable=true;}catch{storageAvailable=false;}}
function storedToken(){try{const token=localStorage.getItem(workspaceKey);return typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token)?token:null;}catch{storageAvailable=false;return null;}}
async function api(path,{method='GET',body,anonymous=false}={}){
  const headers={Accept:'application/json'};if(!anonymous&&state.token)headers['X-Workspace-Token']=state.token;
  if(body!==undefined){headers['Content-Type']='application/json';if(new TextEncoder().encode(JSON.stringify(body)).length>65536)throw new Error('This trace is larger than the 64 KiB request limit. Remove or shorten response baselines.');}
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),35000);
  try{
    const response=await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'omit'});
    let text;try{text=await response.text();}catch{throw new Error('The service response could not be read. Refresh the page or reconnect to the workspace and try again.');}
    let data;try{data=JSON.parse(text);}catch{throw new Error(`The service returned an unreadable response (HTTP ${response.status}). Reconnect and try again; no results have been invented.`);}
    if(!response.ok){const message=typeof data?.error?.message==='string'?data.error.message:typeof data?.error==='string'?data.error:`The request failed (HTTP ${response.status}).`;const error=new Error(message);error.status=response.status;error.code=data?.error?.code;throw error;}
    return data;
  }catch(error){if(error.name==='AbortError')throw new Error('The request reached its time limit. Check Run history before trying again; a completed run may already have been saved.');if(error instanceof TypeError)throw new Error('The service could not be reached. Check your connection, then reconnect to this workspace.');throw error;}
  finally{clearTimeout(timeout);}
}
function updateWorkspace(data){
  state.workspace=data.workspace;state.scenarios=Array.isArray(data.scenarios)?data.scenarios:[];state.runs=Array.isArray(data.runs)?data.runs:[];state.connected=true;
  $('workspace-state').textContent=storageAvailable?'Anonymous · saved in this browser':'This page only · storage unavailable';$('workspace-id').textContent=data.workspace?.id||'Connected';
  $('scenario-count').textContent=String(state.scenarios.length);$('run-count').textContent=String(state.runs.length);updateActions();
  if(state.view==='scenarios')renderScenarios();if(state.view==='history')renderHistory();
}
async function refreshWorkspace(){const data=await api('/api/workspace');updateWorkspace(data);return data;}
async function initializeWorkspace(fresh=false){
  if(state.connecting)return;state.connecting=true;state.connected=false;$('workspace-state').textContent='Connecting…';updateActions();hideError();
  try{
    state.token=fresh?null:storedToken();
    if(!state.token){const created=await api('/api/workspaces',{method:'POST',body:{},anonymous:true});if(!/^[A-Za-z0-9_-]{43}$/.test(created.workspaceToken??''))throw new Error('The service did not return a usable workspace access token.');state.token=created.workspaceToken;persistToken(state.token);}
    await refreshWorkspace();
  }catch(error){$('workspace-state').textContent='Connection unavailable';showError(error.message,'Workspace could not connect');$('retry-workspace').hidden=false;const unavailable=error.status===401||error.status===404;$('retry-workspace').textContent=unavailable?'Start new workspace':'Reconnect';$('retry-workspace').dataset.fresh=String(unavailable);}
  finally{state.connecting=false;updateActions();}
}
function updateActions(){
  const locked=state.busy||!state.connected,hasRequests=state.requests.length>0;
  $('run-button').disabled=locked||!hasRequests;$('save-trace').disabled=locked||!hasRequests;
  $('add-request').disabled=state.busy||state.requests.length>=MAX_REQUESTS;$('empty-add-request').disabled=state.busy;
  $('new-trace').disabled=state.busy;$('remove-request').disabled=state.busy;
  for(const button of document.querySelectorAll('.import-trigger,.new-trace-trigger'))button.disabled=state.busy;
  for(const id of ['trace-name','request-label','request-method','request-url','baseline-status','include-baseline-body','baseline-body','assert-status','assert-duration','assert-contains','clear-baseline','auth-enabled','auth-host','auth-header','auth-value'])$(id).disabled=state.busy;
  $('request-workbench').setAttribute('aria-busy',String(state.busy));
  const status=operationStatus(state.operation,state.requests.length,state.connected);
  $('run-button').classList.toggle('running',status.running);$('run-label').textContent=status.label;
  $('run-caption').textContent=status.caption;$('run-description').textContent=status.description;
  $('save-trace').textContent=state.operation==='save'?'Saving trace…':'Save trace';
}
function setBusy(value,operation=null){state.busy=value;state.operation=value?operation:null;updateActions();renderRequestList();}
function switchView(view){
  state.view=view;for(const name of ['studio','scenarios','history'])$(`${name}-view`).hidden=name!==view;
  for(const button of document.querySelectorAll('.nav-item')){button.classList.toggle('active',button.dataset.view===view);if(button.dataset.view===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  $('view-label').textContent={studio:'Request studio',scenarios:'Saved traces',history:'Run history'}[view];
  if(view==='scenarios')renderScenarios();if(view==='history')renderHistory();
}
function renderRequestList(){
  const list=$('request-list');list.replaceChildren();$('request-count').textContent=`${state.requests.length} / ${MAX_REQUESTS}`;
  for(const request of state.requests){const button=el('button',`request-item${request.id===state.selected?' selected':''}`);button.type='button';button.disabled=state.busy;button.setAttribute('aria-pressed',String(request.id===state.selected));
    const label=el('span','request-item-main');label.append(el('span','method-tag',request.method),el('strong','',request.label||'Untitled request'));
    let sub='Add a destination';try{sub=new URL(request.url).hostname;}catch{}
    button.append(label,el('small','',sub));button.addEventListener('click',()=>{state.selected=request.id;renderEditor();renderRequestList();});list.append(button);
  }
}
function refreshAuthHosts(){
  const previous=$('auth-host').value,hosts=[...new Set(state.requests.flatMap(request=>{try{return[new URL(publicRequestURL(request.url)).hostname];}catch{return[];}}))];
  const placeholder=el('option','','Select a destination…');placeholder.value='';$('auth-host').replaceChildren(placeholder);
  for(const host of hosts){const option=el('option','',host);option.value=host;$('auth-host').append(option);}
  $('auth-host').value=hosts.includes(previous)?previous:'';
}
function renderEditor(){
  const request=selected();if(!request)return;
  $('request-label').value=request.label||'';$('request-url').value=request.url||'';$('request-method').value=request.method;
  $('editor-heading').textContent=request.label||'Configure request';
  $('baseline-status').value=request.baseline?.status??'';const hasBody=typeof request.baseline?.bodyText==='string';$('include-baseline-body').checked=hasBody;$('baseline-body').value=request.baseline?.bodyText??'';$('baseline-body').hidden=!hasBody;
  $('baseline-tag').textContent=request.baseline&&Object.keys(request.baseline).length?'CAPTURED':'NONE';
  $('assert-status').value=request.assertions?.status??'';$('assert-duration').value=request.assertions?.maxDurationMs??'';$('assert-contains').value=request.assertions?.bodyIncludes??'';
  $('assertion-tag').textContent=Object.values(request.assertions||{}).filter(v=>v!==undefined&&v!=='').length?'CONFIGURED':'OPTIONAL';
}
function renderStudio(){
  const has=state.requests.length>0;$('empty-studio').hidden=has;$('request-workbench').hidden=!has;$('auth-section').hidden=!has;$('run-bar').hidden=!has;
  renderRequestList();if(has)renderEditor();refreshAuthHosts();updateActions();
}
function addRequest(){if(state.busy||state.requests.length>=MAX_REQUESTS)return;const request={id:newRequestId(),label:'',method:'GET',url:'',assertions:{}};state.requests.push(request);state.selected=request.id;markDirty();renderStudio();$('request-url').focus();}
async function confirmAction(title,message,action='Delete'){
  if(confirmResolve)return false;$('confirm-heading').textContent=title;$('confirm-message').textContent=message;$('confirm-delete').textContent=action;
  $('confirm-dialog').showModal();return new Promise(resolve=>{confirmResolve=resolve;});
}
function finishConfirm(value){$('confirm-dialog').close();const resolve=confirmResolve;confirmResolve=null;resolve?.(value);}
async function newTrace(){if(state.busy)return;if(state.dirty&&state.requests.length&&!await confirmAction('Start a new trace?','Your unsaved draft exists only in this page. Save it first if you want to keep it.','Start new'))return;state.requests=[];state.selected=null;state.scenarioId=null;state.dirty=false;state.report=null;$('trace-name').value='Untitled trace';$('draft-status').textContent='UNSAVED DRAFT';$('studio-results').replaceChildren();clearAuth();switchView('studio');renderStudio();}
function updateRequest(){
  const request=selected();if(!request||state.busy)return;request.label=$('request-label').value;request.url=$('request-url').value;request.method=$('request-method').value;
  const baseline={},assertions={};if($('baseline-status').value!=='')baseline.status=$('baseline-status').value;if($('include-baseline-body').checked)baseline.bodyText=$('baseline-body').value;
  if($('assert-status').value!=='')assertions.status=$('assert-status').value;if($('assert-duration').value!=='')assertions.maxDurationMs=$('assert-duration').value;if($('assert-contains').value!=='')assertions.bodyIncludes=$('assert-contains').value;
  request.baseline=baseline;request.assertions=assertions;$('baseline-body').hidden=!$('include-baseline-body').checked;
  $('editor-heading').textContent=request.label||'Configure request';$('baseline-tag').textContent=Object.keys(baseline).length?'CAPTURED':'NONE';$('assertion-tag').textContent=Object.keys(assertions).length?'CONFIGURED':'OPTIONAL';markDirty();renderRequestList();refreshAuthHosts();
}
async function saveTrace(){
  if(state.busy||!state.connected)return;hideError();let requests;try{requests=prepareRequests(state.requests);}catch(error){showError(error.message,'Check your trace before saving');return;}
  setBusy(true,'save');try{const response=await api('/api/scenarios',{method:'POST',body:{...(state.scenarioId?{id:state.scenarioId}:{}),name:$('trace-name').value.trim()||'Untitled trace',requests}});const scenario=response.scenario;if(!scenario?.id)throw new Error('The service did not confirm the saved trace.');state.scenarioId=scenario.id;state.dirty=false;$('draft-status').textContent='SAVED TO WORKSPACE';await refreshWorkspace();notify('Trace saved. It is available in Saved traces; no authorization credentials were included.');}catch(error){showError(error.message,'Trace could not be saved');}finally{setBusy(false);}
}
function loadingPanel(title,message){const panel=el('div','panel empty-state compact');panel.append(el('span','loading-ring'),el('h2','',title),el('p','',message));return panel;}
async function runTrace(){
  if(state.busy||!state.connected)return;hideError();let payload;
  try{
    payload={name:$('trace-name').value.trim()||'Untitled trace',requests:prepareRequests(state.requests)};
    if($('auth-enabled').checked){const hostname=$('auth-host').value,value=$('auth-value').value;if(!hostname)throw new Error('Choose the exact hostname that should receive temporary authorization.');if(!value||value.length>2048||/[^\x20-\x7e]/.test(value))throw new Error('Authorization must be 1–2,048 printable ASCII characters.');payload.auth={hostname,header:$('auth-header').value,value};}
  }catch(error){showError(error.message,'Check your requests before replaying');return;}
  setBusy(true,'replay');$('studio-results').replaceChildren(loadingPanel(`Replaying ${payload.requests.length} ${payload.requests.length===1?'request':'requests'}…`,'Sending real HTTPS requests and comparing captured responses. This can take up to 30 seconds.'));
  try{
    const response=await api('/api/runs',{method:'POST',body:payload});if(!response.run?.id||!Array.isArray(response.run.results))throw new Error('The service did not return a complete run record. Open Run history to check whether it was saved.');
    state.report=response.run;renderReport($('studio-results'),response.run);notify(`Replay complete. ${response.run.summary?.total??response.run.results.length} requests recorded in Run history.`);
    try{await refreshWorkspace();}catch{notify('Replay complete and saved. The history list could not refresh; use Refresh in Run history.');}
  }catch(error){$('studio-results').replaceChildren();showError(error.message,'Replay did not complete');}
  finally{clearAuth();if(payload.auth)payload.auth.value='';setBusy(false);}
}
function emptyCollection(title,message,buttonText,action){const panel=el('div','panel empty-state');panel.append(el('span','empty-symbol','⌁'),el('h2','',title),el('p','',message));if(buttonText){const button=el('button','primary-button',buttonText);button.type='button';button.addEventListener('click',action);panel.append(button);}return panel;}
function renderScenarios(){
  const target=$('scenarios-content');target.replaceChildren();if(!state.connected){target.append(emptyCollection('Workspace unavailable','Reconnect to load your saved traces.'));return;}
  if(!state.scenarios.length){target.append(emptyCollection('A home for repeatable checks.','Save a trace from the request studio to reuse its destinations, baselines, and assertions.','Create a trace',()=>switchView('studio')));return;}
  const grid=el('div','saved-grid');
  for(const scenario of state.scenarios){const card=el('article','panel saved-card');const badge=el('span','saved-card-symbol','▤');badge.setAttribute('aria-hidden','true');card.append(badge,el('h2','',scenario.name),el('p','',`${scenario.requestCount} ${scenario.requestCount===1?'request':'requests'} · Updated ${displayDate(scenario.updatedAt)}`));const actions=el('div','saved-card-actions');const open=el('button','secondary-button','Open trace');open.type='button';open.disabled=state.busy;open.addEventListener('click',()=>openScenario(scenario.id));const remove=el('button','quiet-button danger-text','Delete');remove.type='button';remove.disabled=state.busy;remove.setAttribute('aria-label',`Delete saved trace ${scenario.name}`);remove.addEventListener('click',()=>deleteRecord('scenarios',scenario.id,scenario.name));actions.append(open,remove);card.append(actions);grid.append(card);}target.append(grid);
}
async function openScenario(id){if(state.busy)return;if(state.dirty&&state.requests.length&&!await confirmAction('Replace the current draft?','The unsaved request draft will be replaced by this saved trace.','Open trace'))return;hideError();try{const {scenario}=await api(`/api/scenarios?id=${encodeURIComponent(id)}`);if(!scenario?.requests)throw new Error('This trace could not be opened. Refresh Saved traces and try again.');state.requests=structuredClone(scenario.requests);state.selected=state.requests[0]?.id;state.scenarioId=scenario.id;state.dirty=false;$('trace-name').value=scenario.name;$('draft-status').textContent='SAVED TO WORKSPACE';$('studio-results').replaceChildren();state.report=null;clearAuth();switchView('studio');renderStudio();notify('Saved trace opened. Add temporary authorization again if the endpoint requires it.');}catch(error){showError(error.message,'Trace could not open');}}
function renderHistory(){
  const target=$('history-content');target.replaceChildren();if(!state.connected){target.append(emptyCollection('Workspace unavailable','Reconnect to load saved runs.'));return;}
  if(!state.runs.length){target.append(emptyCollection('Your first replay belongs here.','Run a trace to keep its actual responses and comparison evidence in this workspace.','Open request studio',()=>switchView('studio')));return;}
  const panel=el('div','panel history-panel'),table=el('table','history-table');const caption=el('caption','sr-only','Saved replay runs');const head=el('thead'),hr=el('tr');for(const text of ['Run','Requests','Changes','Duration','Recorded',''])hr.append(el('th','',text));head.append(hr);const body=el('tbody');
  for(const run of state.runs){const tr=el('tr',state.historyRun?.id===run.id?'active-run':'');const name=el('td');const open=el('button','history-name',run.name||'Untitled run');open.type='button';open.addEventListener('click',()=>openRun(run.id));name.append(open,el('small','',run.id.slice(0,8)));tr.append(name,el('td','mono',String(run.summary?.total??'—')));const changes=el('td');changes.append(el('span',`pill ${run.summary?.changed?'warning':'neutral'}`,`${run.summary?.changed??0} changed`));tr.append(changes,el('td','mono',formatDuration(run.durationMs)),el('td','history-date',displayDate(run.createdAt)));const action=el('td');const remove=el('button','quiet-button danger-text','Delete');remove.type='button';remove.disabled=state.busy;remove.setAttribute('aria-label',`Delete run ${run.name}`);remove.addEventListener('click',()=>deleteRecord('runs',run.id,run.name));action.append(remove);tr.append(action);body.append(tr);}table.append(caption,head,body);panel.append(table);target.append(panel);
}
async function openRun(id){if(state.busy)return;hideError();$('history-results').replaceChildren(loadingPanel('Opening saved evidence…','Loading the recorded responses from your private workspace.'));try{const {run}=await api(`/api/runs?id=${encodeURIComponent(id)}`);if(!run?.results)throw new Error('The saved run record is unavailable.');state.historyRun=run;renderReport($('history-results'),run);renderHistory();}catch(error){$('history-results').replaceChildren();showError(error.message,'Run could not open');}}
async function deleteRecord(kind,id,name){if(state.busy||!await confirmAction(kind==='runs'?'Delete this saved run?':'Delete this saved trace?',`“${name||'Untitled'}” will be permanently removed from this workspace. This cannot be undone.`))return;hideError();try{await api(`/api/${kind}`,{method:'DELETE',body:{id}});if(kind==='runs'&&state.historyRun?.id===id){state.historyRun=null;$('history-results').replaceChildren();}if(kind==='scenarios'&&state.scenarioId===id){state.scenarioId=null;state.dirty=true;$('draft-status').textContent='UNSAVED DRAFT';}await refreshWorkspace();notify(kind==='runs'?'Run deleted from the workspace.':'Saved trace deleted.');}catch(error){showError(error.message,'The saved item could not be deleted');}}
async function exportRun(id,button){button.disabled=true;try{const {run}=await api(`/api/runs?id=${encodeURIComponent(id)}`);if(!run?.id)throw new Error('The server did not return a saved run to export.');const blob=new Blob([JSON.stringify({schemaVersion:1,run},null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=`ghost-replay-${run.id.replace(/[^a-zA-Z0-9-]/g,'')}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('JSON export requested. It contains the saved, redacted run; no workspace token or temporary authorization.');}catch(error){showError(error.message,'Run could not be exported');}finally{button.disabled=false;}}
async function useRunAsDraft(run){if(state.busy)return;if(!Array.isArray(run.requests)){showError('This older run does not contain a reusable request configuration. Import its original HAR or add a request manually.');return;}if(state.dirty&&state.requests.length&&!await confirmAction('Replace the current draft?','The unsaved draft will be replaced by the saved run’s requests.','Use requests'))return;state.requests=structuredClone(run.requests);state.selected=state.requests[0]?.id;state.scenarioId=null;state.dirty=true;$('trace-name').value=(run.name||'Replayed trace').slice(0,80);$('draft-status').textContent='NEW DRAFT FROM SAVED RUN';state.report=null;$('studio-results').replaceChildren();clearAuth();switchView('studio');renderStudio();notify('Requests reopened as a new draft. Temporary authorization has not been restored.');}
function renderReport(target,run){
  target.replaceChildren();const header=el('div','report-heading');const title=el('div');title.append(el('span','eyebrow','OBSERVED RESPONSE EVIDENCE'),el('h2','',run.name||'Untitled run'),el('p','',`${displayDate(run.createdAt)} · ${formatDuration(run.durationMs)} total · ${run.id.slice(0,8)}`));const actions=el('div','report-actions');const again=el('button','secondary-button','Use as new trace');again.type='button';again.addEventListener('click',()=>useRunAsDraft(run));const download=el('button','secondary-button','↓ Export JSON');download.type='button';download.addEventListener('click',()=>exportRun(run.id,download));actions.append(again,download);header.append(title,actions);target.append(header);
  const metrics=el('div','metrics-grid');for(const [label,value,tone] of [['Requests',run.summary?.total??run.results.length,''],['Passed',run.summary?.passed??0,'good'],['Failed',run.summary?.failed??0,'bad'],['Changed',run.summary?.changed??0,'warning'],['Errors',run.summary?.errors??0,'bad']]){const metric=el('div','panel metric-card');metric.append(el('span','metric-label',label),el('strong',`metric-value ${tone}`,String(value)));metrics.append(metric);}target.append(metrics);
  const panel=el('div','panel report-panel');const tableWrap=el('div','result-table-wrap');const table=el('table','result-table');const caption=el('caption','sr-only','Observed request results. Select a request to inspect its response and assertions.');const head=el('thead'),tr=el('tr');for(const label of ['Request','HTTP','Time','Result'])tr.append(el('th','',label));head.append(tr);const body=el('tbody'),detail=el('section','result-detail');detail.setAttribute('aria-label','Selected request evidence');const rows=[];
  const select=(result,index)=>{rows.forEach((row,i)=>row.classList.toggle('selected-result',i===index));renderResultDetail(detail,result,run.requests?.find(request=>request.id===result.id));};
  run.results.forEach((result,index)=>{const row=el('tr'),name=el('td');const button=el('button','result-name');button.type='button';button.append(el('span','method-tag',result.method),el('strong','',result.label||result.url));button.setAttribute('aria-label',`Inspect ${result.label||result.url}`);button.addEventListener('click',()=>select(result,index));name.append(button,el('small','result-url',result.url));const actual=result.actual;row.append(name,el('td','mono',actual?String(actual.status):'—'),el('td','mono',formatDuration(actual?.durationMs??result.durationMs)));const outcome=el('td');const changed=result.comparison?.statusChanged||result.comparison?.bodyChanged;const label=result.outcome==='error'?'Error':result.outcome==='failed'?'Failed':changed?'Changed':'Passed';outcome.append(el('span',`pill ${result.outcome==='error'||result.outcome==='failed'?'bad':changed?'warning':'good'}`,label));row.append(outcome);rows.push(row);body.append(row);});table.append(caption,head,body);tableWrap.append(table);panel.append(tableWrap,detail);target.append(panel);if(run.results.length)select(run.results[0],0);
}
function renderResultDetail(target,result,request){
  target.replaceChildren();const heading=el('div','detail-heading');const title=el('div');title.append(el('h3','',result.label||'Request evidence'),el('p','mono wrap-anywhere',`${result.method} ${result.url}`));heading.append(title);target.append(heading);
  if(result.error){const error=el('div','result-error');error.append(el('strong','',result.error.code||'Request error'),el('p','',result.error.message||'This destination could not be replayed. Check the public HTTPS URL and try again.'));target.append(error);}
  const facts=el('div','response-facts');const actual=result.actual;
  for(const [label,value] of [['Actual status',actual?.status??'No response'],['Baseline status',result.baseline?.status??'Not captured'],['Duration',formatDuration(actual?.durationMs??result.durationMs)],['Response bytes',actual?.bodyBytes===undefined?'—':actual.bodyBytes.toLocaleString()]]){const item=el('div');item.append(el('span','',label),el('strong','mono',String(value)));facts.append(item);}target.append(facts);
  const comparisons=el('div','comparison-strip');for(const [label,value] of [['Status',result.comparison?.statusChanged],['Body',result.comparison?.bodyChanged]])comparisons.append(el('span',`pill ${value===true?'warning':value===false?'good':'neutral'}`,`${label}: ${value===true?'changed':value===false?'matched':'no baseline'}`));if(result.redacted||actual?.redacted||result.baseline?.redacted)comparisons.append(el('span','pill neutral','Sensitive content redacted'));target.append(comparisons);
  const checks=assertionViews(result,request);const assertions=el('div','assertions-block');assertions.append(el('h4','','Assertions'));if(!checks.length)assertions.append(el('p','muted','No explicit assertions were configured for this request.'));
  for(const check of checks){const tone=check.state==='passed'?'good':check.state==='failed'?'bad':'neutral',verdict=check.state==='passed'?'Passed':check.state==='failed'?'Failed':'Not evaluated';const line=el('div','assertion-line');line.append(el('span',`assertion-symbol ${tone}`,check.state==='passed'?'✓':check.state==='failed'?'×':'—'),el('span','',`${({status:'Status equals',bodyIncludes:'Body contains',maxDurationMs:'Duration at most'})[check.kind]||check.kind} ${String(check.expected)}${check.kind==='maxDurationMs'?' ms':''} · ${check.message||verdict}`),el('span',`pill ${tone}`,verdict));assertions.append(line);}target.append(assertions);
  const diff=result.comparison?.firstDifference;if(diff){const note=el('div','difference-note');note.append(el('span','eyebrow','FIRST DIFFERENCE'),el('p','',`The response body first differs at character ${diff.index}.`));target.append(note);}
  const bodies=el('div','body-grid');
  for(const [label,body,meta] of [['Captured baseline',result.baseline?.bodyPreview,'Reference response'],['Actual response',actual?.bodyPreview,actual?.bodyTruncated?'Preview truncated · hash retained':result.method==='HEAD'?'HEAD requests have no response body':'Measured response preview']]){const box=el('div','body-box'),heading=el('div','body-heading');heading.append(el('strong','',label),el('span','',meta));box.append(heading);const pre=el('pre',typeof body==='string'?'':'empty-body');if(typeof body==='string'){if(diff&&Number.isInteger(diff.index)&&diff.index>=0&&diff.index<body.length){pre.append(document.createTextNode(body.slice(0,diff.index)),el('mark','first-difference',body[diff.index]),document.createTextNode(body.slice(diff.index+1)));}else pre.textContent=body||'(empty body)';}else pre.textContent='No response body captured';pre.tabIndex=0;pre.setAttribute('aria-label',`${label} body`);box.append(pre);bodies.append(box);}target.append(bodies);
  if(actual?.bodySha256){const hash=el('details','hash-details');hash.append(el('summary','','Response fingerprint'));const pre=el('code','wrap-anywhere',actual.bodySha256);hash.append(pre,el('p','muted','Hash of the retained sanitized response text. It does not prove source authenticity.'));target.append(hash);}
}
function openImport(){if(state.busy)return;importEpoch++;$('import-error').hidden=true;$('import-dialog').showModal();}
function closeImport(){importEpoch++;$('import-dialog').close();$('har-paste').value='';$('har-file').value='';$('import-error').hidden=true;}
function importHAR(text){
  try{const parsed=parseHAR(text),room=MAX_REQUESTS-state.requests.length;if(room<=0)throw new Error('This trace already has six requests. Remove a request or start a new trace before importing.');const imported=parsed.requests.slice(0,room);state.requests.push(...imported);state.selected=imported[0].id;markDirty();renderStudio();closeImport();switchView('studio');notify(`${imported.length} ${imported.length===1?'request':'requests'} imported. Request headers were discarded.${parsed.requests.length>room?' Extra requests did not fit the six-request limit.':''} ${parsed.warnings.join(' ')}`);}catch(error){$('import-error').textContent=error.message;$('import-error').hidden=false;}
}
for(const button of document.querySelectorAll('.nav-item'))button.addEventListener('click',()=>switchView(button.dataset.view));
for(const button of document.querySelectorAll('.import-trigger'))button.addEventListener('click',openImport);
for(const button of document.querySelectorAll('.new-trace-trigger'))button.addEventListener('click',newTrace);
$('empty-add-request').addEventListener('click',addRequest);$('add-request').addEventListener('click',addRequest);$('new-trace').addEventListener('click',newTrace);$('save-trace').addEventListener('click',saveTrace);$('run-button').addEventListener('click',runTrace);
$('trace-name').addEventListener('input',markDirty);
for(const id of ['request-label','request-url','request-method','baseline-status','include-baseline-body','baseline-body','assert-status','assert-duration','assert-contains'])$(id).addEventListener(['request-method','include-baseline-body'].includes(id)?'change':'input',updateRequest);
$('clear-baseline').addEventListener('click',()=>{const request=selected();if(!request)return;delete request.baseline;markDirty();renderEditor();});
$('remove-request').addEventListener('click',()=>{if(state.busy)return;state.requests=state.requests.filter(r=>r.id!==state.selected);state.selected=state.requests[0]?.id;markDirty();renderStudio();});
$('auth-enabled').addEventListener('change',()=>{$('auth-fields').hidden=!$('auth-enabled').checked;if(!$('auth-enabled').checked)$('auth-value').value='';});
$('cancel-import').addEventListener('click',closeImport);$('import-dialog').addEventListener('close',()=>{importEpoch++;$('har-paste').value='';$('har-file').value='';});
$('import-paste').addEventListener('click',()=>importHAR($('har-paste').value));$('har-file').addEventListener('change',async()=>{const file=$('har-file').files[0];if(!file)return;if(file.size>5*1024*1024){$('import-error').textContent='Choose a HAR file smaller than 5 MiB.';$('import-error').hidden=false;return;}const epoch=importEpoch;try{const text=await file.text();if(epoch===importEpoch&&$('import-dialog').open)importHAR(text);}catch{if(epoch===importEpoch&&$('import-dialog').open){$('import-error').textContent='The file could not be read. Try pasting its HAR JSON instead.';$('import-error').hidden=false;}}});
$('dismiss-error').addEventListener('click',()=>{$('error-banner').hidden=true;});$('dismiss-notification').addEventListener('click',()=>{$('notification').hidden=true;});$('retry-workspace').addEventListener('click',()=>initializeWorkspace($('retry-workspace').dataset.fresh==='true'));
$('refresh-history').addEventListener('click',async()=>{hideError();try{await refreshWorkspace();notify('Workspace history refreshed.');}catch(error){showError(error.message,'History could not refresh');}});
$('privacy-button').addEventListener('click',()=>$('privacy-dialog').showModal());$('confirm-cancel').addEventListener('click',()=>finishConfirm(false));$('confirm-delete').addEventListener('click',()=>finishConfirm(true));$('confirm-dialog').addEventListener('cancel',event=>{event.preventDefault();finishConfirm(false);});
$('delete-workspace').addEventListener('click',async()=>{if(state.busy)return;$('privacy-dialog').close();if(!await confirmAction('Permanently delete this workspace?','All saved traces and runs will be deleted, and this browser’s access token will be removed. This cannot be undone.','Delete workspace'))return;try{await api('/api/workspace',{method:'DELETE',body:{}});persistToken(null);state.token=null;state.connected=false;state.scenarios=[];state.runs=[];state.requests=[];state.selected=null;state.scenarioId=null;state.dirty=false;state.report=null;state.historyRun=null;$('studio-results').replaceChildren();$('history-results').replaceChildren();$('trace-name').value='Untitled trace';$('draft-status').textContent='UNSAVED DRAFT';clearAuth();renderStudio();switchView('studio');notify('Workspace and its saved data deleted. A new empty private workspace is being created.');await initializeWorkspace(true);}catch(error){showError(error.message,'Workspace could not be deleted');}});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&state.view==='studio'&&!document.querySelector('dialog[open]')){event.preventDefault();runTrace();}});
renderStudio();void initializeWorkspace();
