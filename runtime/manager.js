'use strict';
const crypto=require('node:crypto'),path=require('node:path');
const {launch,detectBrowser}=require('./cdp');const {installProbe}=require('./probe');const {redact,text,safeUrl,origin,local}=require('./privacy');const {domSnapshot,targetInfo,inputFocus,maskPage}=require('./dom');
const {fail}=require('../lib/util');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const LIMITS={events:1000,snapshots:20,bodyBytes:32768,maxSessions:2};
class RuntimeManager{
 constructor({enabled=false,chrome,remoteOrigins=[],unsafeTestNoSandbox=false,fixtureResponder,offlineDocument}={}){Object.assign(this,{enabled,chrome,unsafeTestNoSandbox,fixtureResponder,offlineDocument});this.remoteOrigins=new Set(remoteOrigins.map(origin));this.sessions=new Map();this.starting=0;this.disposed=false;}
 async status(){let browser=null,error=null;try{browser=await detectBrowser(this.chrome);}catch(e){error=e.message;}return{enabled:this.enabled,browser,error,sessions:[...this.sessions.values()].map(s=>({sessionId:s.id,url:safeUrl(s.url),projectId:s.projectId})),limits:LIMITS,note:'Runtime observation is optional and browser state is ephemeral. Static analysis remains available without it.'};}
 get(id){const s=this.sessions.get(id);if(!s||s.closed)fail('RUNTIME_SESSION_NOT_FOUND','Unknown/closed runtime session; call runtime_start after consent.');return s;}
 add(s,type,data={},extra={}){const e={seq:++s.seq,id:'e'+s.seq,at:Date.now(),type,data:redact(data),...extra};s.events.push(e);if(s.events.length>LIMITS.events){s.events.shift();s.dropped++;}return e;}
 async evaluate(s,fn,args){const expression='('+fn.toString()+')('+JSON.stringify(args||{})+')';const r=await s.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,timeout:5000});if(r.exceptionDetails)throw new Error(text(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result?.value;}
 permittedOrigin(value){return local(value)||this.remoteOrigins.has(origin(value));}
 async start(args,workspace){
  if(!this.enabled||this.disposed)fail('RUNTIME_DISABLED','Runtime observation is disabled for this session. Static analysis remains available.');
  if(this.sessions.size+this.starting>=LIMITS.maxSessions)fail('RUNTIME_LIMIT','Stop an unused runtime session first.');
  const url=new URL(args.url);origin(args.url);if(!this.permittedOrigin(args.url))fail('ORIGIN_NOT_ALLOWED','Start a localhost dev app, or permit this exact origin in the installer with --runtime-origin after user consent.');
  const origins=new Set([url.origin]);for(const value of args.allowedOrigins||[]){if(!this.permittedOrigin(value))fail('ORIGIN_NOT_ALLOWED','Origin not authorized in local runtime configuration: '+origin(value));origins.add(origin(value));}
  const options={captureState:!!args.captureState,captureBodies:!!args.captureBodies,captureText:!!args.captureText,captureVisual:!!args.captureVisual,allowActions:!!args.allowActions,maskSelectors:args.maskSelectors||[]};
  this.starting++;let browser,s;
  try{browser=await launch({executable:this.chrome,headless:args.headless===true,unsafeTestNoSandbox:this.unsafeTestNoSandbox});
   const c=browser.client;const target=(await c.send('Target.getTargets')).targetInfos.find(t=>t.type==='page');const attached=await c.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
   if(this.disposed)fail('RUNTIME_DISABLED','The runtime observer was closed while starting.');
   s={id:crypto.randomUUID(),projectId:args.projectId,workspace,url:args.url,browser,target:target.targetId,cdpSession:attached.sessionId,send:(m,p)=>c.send(m,p,attached.sessionId),seq:0,events:[],dropped:0,snapshots:new Map(),requests:new Map(),pending:new Set(),options,origins,tail:Promise.resolve(),closed:false,documentEpoch:0};this.sessions.set(s.id,s);
   c.on('event',m=>{if(m.sessionId===s.cdpSession){const job=this.onEvent(s,m).catch(e=>{if(!s.closed)this.add(s,'observer.warning',{message:e.message});});s.pending.add(job);job.finally(()=>s.pending.delete(job));}});
   c.once('closed',()=>{if(!s.closed)this.stop(s.id).catch(()=>{});});
   await s.send('Page.enable');await s.send('Runtime.enable');await s.send('Network.enable',{maxTotalBufferSize:2*1024*1024,maxResourceBufferSize:131072,maxPostDataSize:0});
   await s.send('Network.setBypassServiceWorker',{bypass:true});await s.send('Network.setCacheDisabled',{cacheDisabled:true});await s.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
   await c.send('Browser.setDownloadBehavior',{behavior:'deny'});
   await s.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+installProbe.toString()+')('+JSON.stringify(options)+')'});
   await s.send('Emulation.setDeviceMetricsOverride',{width:args.width||1280,height:args.height||800,deviceScaleFactor:1,mobile:false});
   this.add(s,'session.start',{url:safeUrl(args.url),options,origins:[...origins],browser:browser.version.product,evidence:'Observed runtime; only this scenario, not all paths.'});
   if(this.offlineDocument!==undefined){await this.evaluate(s,installProbe,options);const tree=await s.send('Page.getFrameTree');await s.send('Page.setDocumentContent',{frameId:tree.frameTree.frame.id,html:this.offlineDocument});this.add(s,'test.offline_fixture',{warning:'Offline test fixture, not a live backend.'});}
   else{const nav=await s.send('Page.navigate',{url:args.url});if(nav.errorText)throw new Error('Navigation failed: '+nav.errorText+'. Check URL, browser policy and dev server.');}
   const until=Date.now()+15000;let ready=false;while(Date.now()<until&&!s.closed){try{ready=await this.evaluate(s,()=>document.readyState!=='loading'&&!!window.__CODE_FLOW_RUNTIME__);if(ready)break;}catch{}await sleep(80);}if(!ready)throw new Error('Runtime probe did not initialize. Check navigation, allowed origins or page policy.');
   await this.evaluate(s,o=>{for(const selector of o.maskSelectors)document.querySelector(selector);return true;},options);
   s.ttl=setTimeout(()=>this.stop(s.id).catch(()=>{}),30*60*1000);s.ttl.unref();
   return{sessionId:s.id,projectId:s.projectId,browser:browser.version.product,url:safeUrl(args.url),options,limits:LIMITS,expiresInMinutes:30,warning:'Loading the app can execute effects and API writes even when allowActions=false. Isolated profile; no existing logins imported. Only observed paths, main frame and bounded evidence. Local source and runtime timelines are not automatically causally merged.'};
  }catch(e){if(s)await this.stop(s.id);else if(browser)await browser.close();throw e;}finally{this.starting--;}
 }
 async onEvent(s,m){if(s.closed)return;const p=m.params||{};
  if(m.method==='Fetch.requestPaused'){
   if(this.fixtureResponder){const response=await this.fixtureResponder(p.request);if(response){await s.send('Fetch.fulfillRequest',{requestId:p.requestId,...response});return;}}
   let allowed=false;try{allowed=s.origins.has(origin(p.request.url));}catch{}
   if(!allowed){this.add(s,'network.blocked',{url:safeUrl(p.request.url),reason:'Origin not in session scope'});await s.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'});}else await s.send('Fetch.continueRequest',{requestId:p.requestId});
  }else if(m.method==='Network.requestWillBeSent'){
   if(s.requests.size>=500)s.requests.delete(s.requests.keys().next().value);
   const info={url:safeUrl(p.request.url),method:p.request.method,type:p.type};
   const frames=p.initiator?.stack?.callFrames?.slice(0,8).map(f=>({function:f.functionName,url:safeUrl(f.url),line:f.lineNumber+1,column:f.columnNumber+1}));
   const event=this.add(s,'network.request',{...info,initiator:frames||[],note:'Generated/browser source positions; sourcemaps are not automatically resolved.'},{requestId:p.requestId});s.requests.set(p.requestId,{...info,eventId:event.id});
  }else if(m.method==='Network.responseReceived'){
   const item=s.requests.get(p.requestId);if(item){item.mime=p.response.mimeType;item.status=p.response.status;item.size=Number(p.response.headers?.['content-length']||p.response.headers?.['Content-Length']||0);}
   this.add(s,'network.response',{url:safeUrl(p.response.url),status:p.response.status,mime:p.response.mimeType},{requestId:p.requestId,cause:item?.eventId||null,evidence:'browser-protocol'});
  }else if(m.method==='Network.loadingFinished'){
   const item=s.requests.get(p.requestId);if(item&&s.options.captureBodies&&/json/i.test(item.mime||'')){
    if(item.size>LIMITS.bodyBytes||p.encodedDataLength>LIMITS.bodyBytes)this.add(s,'network.body_omitted',{reason:'size limit',url:item.url},{requestId:p.requestId});
    else try{const b=await s.send('Network.getResponseBody',{requestId:p.requestId});const bytes=Buffer.from(b.body,b.base64Encoded?'base64':'utf8');if(bytes.length>LIMITS.bodyBytes)throw Error('JSON body exceeds capture limit');const value=JSON.parse(bytes.toString('utf8'));this.add(s,'network.json',{url:item.url,value},{requestId:p.requestId,cause:item.eventId,evidence:'browser-protocol'});}catch(e){this.add(s,'network.body_omitted',{url:item.url,reason:e.message},{requestId:p.requestId});}
   }s.requests.delete(p.requestId);
  }else if(m.method==='Network.loadingFailed'){this.add(s,'network.failed',{message:p.errorText,canceled:p.canceled},{requestId:p.requestId});s.requests.delete(p.requestId);
  }else if(m.method==='Runtime.exceptionThrown'){this.add(s,'browser.error',{message:s.options.captureText?p.exceptionDetails.exception?.description||p.exceptionDetails.text:'Message omitted (captureText=false)',line:p.exceptionDetails.lineNumber+1,url:safeUrl(p.exceptionDetails.url)},{evidence:'browser-protocol'});
  }else if(m.method==='Runtime.consoleAPICalled'){this.add(s,'console.'+p.type,{message:s.options.captureText?p.args?.map(a=>typeof a.value==='string'?a.value:a.type==='object'?'[object]':String(a.value)).join(' '):'[text capture disabled]'});
  }else if(m.method==='Page.javascriptDialogOpening'){this.add(s,'browser.dialog',{type:p.type,message:s.options.captureText?p.message:'[omitted]'});await s.send('Page.handleJavaScriptDialog',{accept:false});
  }else if(m.method==='Page.frameNavigated'&&!p.frame.parentId){s.documentEpoch++;this.add(s,'page.navigation',{url:safeUrl(p.frame.url),epoch:s.documentEpoch});}
 }
 async drain(s){try{const r=await this.evaluate(s,()=>window.__CODE_FLOW_RUNTIME__?.drain());if(r){for(const e of r.events.slice(0,500))this.add(s,e.type,e.data,{probeId:'d'+s.documentEpoch+':'+e.id,probeCause:e.cause?'d'+s.documentEpoch+':'+e.cause:null,observedAt:e.at,evidence:'page-instrumentation'});if(r.dropped)this.add(s,'probe.truncated',{dropped:r.dropped});}}catch(e){this.add(s,'probe.unavailable',{message:e.message});}}
 async snapshot(id){const s=this.get(id);await this.drain(s);const raw=await this.evaluate(s,domSnapshot,s.options);const value=redact(raw);value.truncated=!!value.truncated||(raw.elements?.length||0)>(value.elements?.length||0);if(value.react)value.react.truncated=!!value.react.truncated||(raw.react?.components?.length||0)>(value.react.components?.length||0);const snapshot={snapshotId:crypto.randomUUID(),sessionId:id,at:Date.now(),...value};s.snapshots.set(snapshot.snapshotId,snapshot);if(s.snapshots.size>LIMITS.snapshots)s.snapshots.delete(s.snapshots.keys().next().value);this.add(s,'snapshot',{snapshotId:snapshot.snapshotId,elements:snapshot.elements?.length,components:snapshot.react?.components?.length});return snapshot;}
 async events(id,after=0,limit=100){const s=this.get(id);await this.drain(s);const list=s.events.filter(e=>e.seq>after).slice(0,limit);return{sessionId:id,events:list,nextAfter:list.at(-1)?.seq||after,hasMore:s.events.some(e=>e.seq>(list.at(-1)?.seq||after)),oldestAvailable:s.events[0]?.seq||0,dropped:s.dropped,truncated:after<(s.events[0]?.seq||1)-1};}
 async action(args){const s=this.get(args.sessionId);if(!s.options.allowActions)fail('RUNTIME_ACTIONS_DISABLED','Start a new session with allowActions after explicit user consent. Actions can change server data.');
  this.add(s,'action.start',{action:args.action,selector:args.selector,text:args.action==='fill'?'[not recorded]':undefined});
  if(args.action==='click'||args.action==='fill'){
    if(!args.selector)throw Error('selector is required.');
    for(const selector of s.options.maskSelectors){const privateMatch=await this.evaluate(s,({target,mask})=>document.querySelector(target)?.closest(mask)!=null,{target:args.selector,mask:selector});if(privateMatch)throw Error('Masked elements must be handled manually.');}
    const target=await this.evaluate(s,targetInfo,{selector:args.selector});
    if(args.action==='click'){await s.send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1});await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1});}
    else{if(typeof args.text!=='string')throw Error('text is required for fill');await this.evaluate(s,inputFocus,{selector:args.selector});await s.send('Input.insertText',{text:args.text});}
  }else if(args.action==='wait')await sleep(args.ms??250);
  else if(args.action==='viewport'){if(!args.width||!args.height)throw Error('width and height are required');await s.send('Emulation.setDeviceMetricsOverride',{width:args.width,height:args.height,deviceScaleFactor:1,mobile:false});}
  else throw Error('Unsupported action');
  await sleep(100);await this.drain(s);this.add(s,'action.complete',{action:args.action});return{sessionId:s.id,performed:args.action,note:'Action dispatched. Inspect snapshots/events; this is not an assertion that the application reached its intended state.'};
 }
 async screenshot(id){const s=this.get(id);if(!s.options.captureVisual)fail('VISUAL_CAPTURE_DISABLED','Start a new session with captureVisual=true after user consent. Images may contain personal data.');
  let masks=0;try{masks=await this.evaluate(s,maskPage,s.options);const img=await s.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});if(img.data.length>4*1024*1024)fail('IMAGE_TOO_LARGE','Viewport image exceeds 3 MB. Reduce viewport size.');return{sessionId:id,mimeType:'image/png',maskCount:masks,sha256:crypto.createHash('sha256').update(Buffer.from(img.data,'base64')).digest('hex'),note:'Viewport only. Best-effort masking; unmarked text/canvas content can still contain private data.',_imageBase64:img.data};}finally{try{await this.evaluate(s,()=>{document.getElementById('__cfl_capture_masks')?.remove();});}catch{}}
 }
 compare(id,before,after){const s=this.get(id),a=s.snapshots.get(before),b=s.snapshots.get(after);if(!a||!b)fail('SNAPSHOT_NOT_FOUND','Snapshots must be from this session and still retained (last 20).');const diff=(aa,bb,key)=>{const old=new Map(aa.map(e=>[e[key],e])),now=new Map(bb.map(e=>[e[key],e]));return{added:bb.filter(e=>!old.has(e[key])),removed:aa.filter(e=>!now.has(e[key])),changed:bb.filter(e=>old.has(e[key])&&JSON.stringify(old.get(e[key]))!==JSON.stringify(e)).map(e=>({id:e[key],before:old.get(e[key]),after:e}))};};return{sessionId:id,before,after,dom:diff(a.elements||[],b.elements||[],'selector'),react:diff(a.react?.components||[],b.react?.components||[],'id'),viewport:{before:a.viewport,after:b.viewport},note:'Observed DOM/state difference. Not a visual pass/fail and not reverse execution.'};}
 async export(id,limit=150){const s=this.get(id);await this.drain(s);const events=s.events.slice(-limit).sort((a,b)=>(a.observedAt||a.at)-(b.observedAt||b.at)||a.seq-b.seq),nodes=events.map((e,i)=>({id:e.id,type:'codeBlock',role:i===0?'root':'observation',name:e.type,code:JSON.stringify(e.data,null,2),layer:Math.floor(i/4),reads:[],writes:[],calls:[],observedAt:e.observedAt||e.at}));if(!nodes.length)throw Error('No observations');const edges=[];for(let i=1;i<nodes.length;i++)edges.push({id:'t'+i,from:nodes[i-1].id,to:nodes[i].id,type:'follows_observed',label:'observed order (not causality)'});
   const graph={graphId:'runtime-'+s.id,kind:'runtime-timeline',readOnlySnapshot:true,rootId:nodes[0].id,selectedNodeId:nodes[0].id,target:{name:'Observed runtime - '+safeUrl(s.url)},nodes,edges,dataEdges:[],revision:s.seq,analysis:{busy:false,stale:false,pending:[],warnings:[{code:'RUNTIME_EVIDENCE',stage:'runtime',message:'Observed scenario only. Edges show chronology, not causal data flow. State/effects have different capture methods; inspect evidence provenance.'}]}};
   return{format:'code-flow-lens.snapshot',formatVersion:1,workspace:s.workspace,createdAt:new Date().toISOString(),source:{mode:'runtime',version:require('../package.json').version},graph,cards:{},evidence:{events,snapshots:[...s.snapshots.values()].slice(-3),dropped:s.dropped,options:s.options}};
 }
 async stop(id){const s=this.sessions.get(id);if(!s)return{sessionId:id,closed:true};s.closed=true;clearTimeout(s.ttl);this.sessions.delete(id);await s.browser.close();s.events=[];s.snapshots.clear();return{sessionId:id,closed:true,warning:'This does not undo any web app/API side effects.'};}
 async call(name,args,workspace){if(name==='runtime_status')return this.status();if(name==='runtime_start')return this.start(args,workspace);if(name==='runtime_stop')return this.stop(args.sessionId);const s=this.get(args.sessionId);const run=()=>{switch(name){case'runtime_snapshot':return this.snapshot(s.id);case'runtime_events':return this.events(s.id,args.after,args.limit);case'runtime_action':return this.action(args);case'runtime_screenshot':return this.screenshot(s.id);case'runtime_compare':return this.compare(s.id,args.before,args.after);case'runtime_export':return this.export(s.id,args.limit);default:throw Error('Unknown runtime tool');}};const r=s.tail.catch(()=>{}).then(run);s.tail=r.catch(()=>{});return r;}
 async dispose(){this.disposed=true;await Promise.all([...this.sessions.keys()].map(id=>this.stop(id)));}
}
module.exports={RuntimeManager,LIMITS};
