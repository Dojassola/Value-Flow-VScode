'use strict';
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {FlowError,checkAbort}=require('./util');
const TS_FILE=/\.[cm]?[jt]sx?$/i;
const HEAVY_OPS=new Set(['correlate']);
class LocalLanguageClient{
  constructor(vscode,{log=()=>{},queryTimeoutMs=3000,heavyTimeoutMs=6000,startupTimeoutMs=6000,maxFiles=8000,cacheDir=null}={}){
    this.vscode=vscode;this.log=log;this.queryTimeoutMs=queryTimeoutMs;this.heavyTimeoutMs=heavyTimeoutMs;this.startupTimeoutMs=startupTimeoutMs;this.maxFiles=maxFiles;
    this.workers=new Map();this.heavyWorkers=new Map();this.next=1;this.overlayFingerprints=new Map();this.cacheDir=cacheDir;this.disposed=false;
  }
  roots(){return(this.vscode.workspace.workspaceFolders||[]).filter(f=>f.uri.scheme==='file').map(f=>({name:f.name,path:f.uri.fsPath}));}
  targetFile(value){let file=value;if(value?.location?.uri)file=this.vscode.Uri.parse(value.location.uri).fsPath;else if(value?.uri)file=this.vscode.Uri.parse(value.uri).fsPath;else if(typeof value==='string'&&value.startsWith('file:'))file=this.vscode.Uri.parse(value).fsPath;else if(value?.location?.file)file=value.location.file;else if(value?.file)file=value.file;return typeof file==='string'?path.resolve(file):null;}
  rootFor(value){const file=this.targetFile(value);const roots=this.roots().filter(r=>file===r.path||file?.startsWith(r.path+path.sep)).sort((a,b)=>b.path.length-a.path.length);if(!roots.length)throw new FlowError('OUTSIDE_WORKSPACE','Local language engine only analyzes open workspace folders.');return roots[0];}
  mapFor(kind){return kind==='precision'?this.heavyWorkers:this.workers;}
  async workerFor(root,signal,focusFile=null,kind='fast'){checkAbort(signal);if(this.disposed)throw new FlowError('CANCELLED','The local engine was disposed.');const map=this.mapFor(kind);let state=map.get(root.path);if(state&&!state.dead)return this.ready(state,signal);state=this.spawn(root,focusFile,kind);map.set(root.path,state);return this.ready(state,signal);}
  spawn(root,focusFile=null,kind='fast'){
    const script=kind==='precision'?'value-language-worker.js':'local-language-worker.js';
    const worker=new Worker(path.join(__dirname,script),{workerData:{root:root.path,maxFiles:this.maxFiles,queryTimeoutMs:this.queryTimeoutMs,focusFile,cacheDir:this.cacheDir},resourceLimits:{maxOldGenerationSizeMb:kind==='precision'?384:256}});
    const state={root,kind,worker,pending:new Map(),dead:false,status:null,tail:Promise.resolve()};
    state.ready=new Promise((resolve,reject)=>{state.resolveReady=resolve;state.rejectReady=reject;});
    // A restart may reject the promise before any waiter attached; mark handled
    // so Node never logs an unhandled rejection. Callers still see the failure
    // through the handlers attached in ready().
    state.ready.catch(()=>{});
    worker.on('message',m=>{
      if(m.type==='ready'){state.status=m.status;state.resolveReady(state);return;}
      const p=state.pending.get(m.id);if(!p)return;state.pending.delete(m.id);clearTimeout(p.timer);p.signal?.removeEventListener('abort',p.abort);
      if(p.cancelled)return;
      m.error?p.reject(Object.assign(new FlowError(m.error.code||'LOCAL_ENGINE_ERROR',m.error.message||'Local engine error',m.error.details),{stack:m.error.stack})):p.resolve(m.result);
    });
    const fail=e=>{if(state.dead)return;state.dead=true;state.rejectReady(e);for(const p of state.pending.values()){clearTimeout(p.timer);p.signal?.removeEventListener('abort',p.abort);if(!p.cancelled)p.reject(e);}state.pending.clear();const map=this.mapFor(kind);if(map.get(root.path)===state)map.delete(root.path);this.overlayFingerprints.delete(`${kind}|${root.path}`);};
    worker.on('error',e=>fail(new FlowError('LOCAL_ENGINE_CRASH',`Embedded ${kind} worker crashed: ${e.message}`)));
    worker.on('exit',code=>{if(!state.dead)fail(new FlowError('LOCAL_ENGINE_EXIT',`Embedded ${kind} worker exited (${code}). It will restart on the next query.`));});
    return state;
  }
  ready(state,signal){checkAbort(signal);return new Promise((resolve,reject)=>{const timeout=state.kind==='precision'?Math.max(this.startupTimeoutMs,10000):this.startupTimeoutMs;const timer=setTimeout(()=>{this.restart(state,'startup timeout');reject(new FlowError('LOCAL_ENGINE_STARTUP_TIMEOUT',`Embedded ${state.kind} engine did not start within ${timeout} ms.`));},timeout);const abort=()=>{clearTimeout(timer);reject(new FlowError('CANCELLED','Analysis cancelled.'));};signal?.addEventListener('abort',abort,{once:true});state.ready.then(v=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(v);},e=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(e);});});}
  restart(state,reason){if(!state||state.dead)return;this.log(`Local ${state.kind} engine restart: ${state.root.name}: ${reason}`);state.dead=true;
    // Wake anyone still waiting on startup so they fail fast instead of hanging
    // until their own startup timeout fires.
    state.rejectReady(new FlowError('LOCAL_ENGINE_RESTARTED',`Embedded ${state.kind} worker restarted after ${reason}.`));
    for(const p of state.pending.values()){clearTimeout(p.timer);p.signal?.removeEventListener('abort',p.abort);if(!p.cancelled)p.reject(new FlowError('LOCAL_ENGINE_RESTARTED',`Embedded ${state.kind} worker restarted after ${reason}.`));}state.pending.clear();state.worker.terminate();const map=this.mapFor(state.kind);if(map.get(state.root.path)===state)map.delete(state.root.path);this.overlayFingerprints.delete(`${state.kind}|${state.root.path}`);}
  overlays(root){const docs=(this.vscode.workspace.textDocuments||[]).filter(d=>d.uri.scheme==='file'&&d.uri.fsPath.startsWith(root.path+path.sep)&&TS_FILE.test(d.uri.fsPath)&&d.getText().length<=2_000_000);const fingerprint=docs.map(d=>`${d.uri.fsPath}:${d.version}:${d.isDirty?1:0}`).sort().join('|');return{fingerprint,items:docs.map(d=>({file:d.uri.fsPath,text:d.getText(),version:d.version,dirty:d.isDirty}))};}
  enqueue(state,op,args,signal,timeout=this.queryTimeoutMs){const run=()=>{checkAbort(signal);if(state.dead)throw new FlowError('LOCAL_ENGINE_RESTARTED',`Embedded ${state.kind} worker restarted.`);return this.raw(state,op,args,signal,timeout);};const result=state.tail.catch(()=>{}).then(run);state.tail=result.catch(()=>{});return result;}
  async sync(state,signal){const o=this.overlays(state.root),key=`${state.kind}|${state.root.path}`;if(this.overlayFingerprints.get(key)===o.fingerprint)return;this.overlayFingerprints.set(key,o.fingerprint);try{await this.enqueue(state,'setOverlays',{items:o.items},signal,state.kind==='precision'?Math.max(this.heavyTimeoutMs,6000):Math.max(this.queryTimeoutMs,3000));}catch(e){this.overlayFingerprints.delete(key);throw e;}}
  budgetFor(op,explicit){if(explicit!==undefined&&explicit!==null)return explicit;const base=Math.max(800,this.queryTimeoutMs);if(HEAVY_OPS.has(op)||op==='valueTrace')return this.heavyTimeoutMs;if(op==='simulateValue')return Math.min(5000,Math.max(2500,Math.round(base*1.5)));if(['references','implementations','calls','prepare','definitions'].includes(op))return Math.min(20000,Math.max(12000,Math.round(base*4)));if(op==='findSymbols')return Math.min(8000,Math.max(3500,Math.round(base*1.4)));if(op==='containingSymbols')return Math.min(5000,Math.max(2500,base));return base;}
  raw(state,op,args,signal,timeout=this.queryTimeoutMs){
    checkAbort(signal);const id=this.next++;
    return new Promise((resolve,reject)=>{
      const p={resolve,reject,signal,cancelled:false,timer:null,abort:null};
      p.abort=()=>{if(!state.pending.has(id)||p.cancelled)return;p.cancelled=true;state.pending.delete(id);clearTimeout(p.timer);p.signal?.removeEventListener('abort',p.abort);
        if(state.kind==='precision')this.restart(state,`${op} superseded`);
        reject(new FlowError('CANCELLED',state.kind==='fast'?'Analysis superseded. The bounded index query will finish in-place; the worker and warm caches are preserved.':'Analysis cancelled. The precision worker was stopped.'));
      };
      p.timer=setTimeout(()=>{if(!state.pending.has(id))return;state.pending.delete(id);this.restart(state,`${op} exceeded ${timeout} ms`);if(!p.cancelled)reject(new FlowError('LOCAL_ENGINE_TIMEOUT',`Embedded ${state.kind} query ${op} exceeded ${timeout} ms. The worker was restarted.`));},timeout);
      state.pending.set(id,p);signal?.addEventListener('abort',p.abort,{once:true});state.worker.postMessage({id,op,args});if(signal?.aborted)p.abort();
    });
  }
  async query(op,args,target,signal,timeout){const subject=target||args.target||args.targets?.[0]||args.location||args.args?.file;const root=this.rootFor(subject),kind=HEAVY_OPS.has(op)?'precision':'fast';const state=await this.workerFor(root,signal,this.targetFile(subject),kind);await this.sync(state,signal);const started=Date.now(),budget=this.budgetFor(op,timeout);if(op==='valueTrace')args={...args,options:{...args.options,timeBudgetMs:Math.max(100,budget-500)}};const result=await this.enqueue(state,op,args,signal,budget);this.log(`Local ${kind} ${op}: ${Date.now()-started} ms / ${budget} ms budget (${root.name})`);return result;}

  async warm(value){
    try{const root=this.rootFor(value),file=this.targetFile(value),state=await this.workerFor(root,undefined,file,'fast');await this.sync(state,undefined);if(file&&/\.[cm]?[jt]sx?$/i.test(file))this.enqueue(state,'warmIndex',{file},undefined,2500).catch(()=>{});return state.status;}
    catch(error){this.log(`Local fast prewarm skipped: ${error.code||'ERROR'}: ${error.message}`);return null;}
  }
  async status(target,signal){const root=this.rootFor(target),state=await this.workerFor(root,signal,this.targetFile(target),'fast');await this.sync(state,signal);const current=await this.enqueue(state,'status',{},signal,3000);state.status=current;return current;}
  invalidate({structure=false}={}){for(const state of [...this.workers.values(),...this.heavyWorkers.values()])if(!state.dead)this.enqueue(state,structure?'refresh':'invalidate',{},undefined,state.kind==='precision'?6000:3000).catch(()=>{});this.overlayFingerprints.clear();}
  updateSettings({queryTimeoutMs,heavyTimeoutMs,startupTimeoutMs,maxFiles}){this.queryTimeoutMs=queryTimeoutMs||this.queryTimeoutMs;this.heavyTimeoutMs=heavyTimeoutMs||this.heavyTimeoutMs;this.startupTimeoutMs=startupTimeoutMs||this.startupTimeoutMs;if(maxFiles&&maxFiles!==this.maxFiles){this.maxFiles=maxFiles;for(const s of [...this.workers.values(),...this.heavyWorkers.values()])this.restart(s,'maxFiles setting changed');}}
  dispose(){this.disposed=true;for(const s of [...this.workers.values(),...this.heavyWorkers.values()])this.restart(s,'extension disposed');this.workers.clear();this.heavyWorkers.clear();}
}
module.exports={LocalLanguageClient};
