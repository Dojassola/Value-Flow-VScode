'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {TypeScriptHost}=require('./local-typescript-host');
const {VSCodeAdapter}=require('./vscode-adapter');
const {ValueEngine}=require('./value-engine');
const {errorInfo}=require('./util');
const host=new TypeScriptHost(workerData.root,{maxFiles:workerData.maxFiles||8000,focusFile:workerData.focusFile||null});
const adapter=new VSCodeAdapter(host.facade,{timeoutMs:Math.max(1000,workerData.queryTimeoutMs||3000)});adapter.ensureLanguage=async()=>[];
const value=new ValueEngine(host,adapter);
async function run(op,args){
  if(op==='setOverlays')return{changed:host.setOverlays(args.items||[]),generation:host.generation};
  if(op==='invalidate'){host.bump();return{generation:host.generation};}
  if(op==='refresh'){host.refresh(true);return{status:host.status()};}
  if(op==='status')return{...host.status(),backend:'precision-value-engine'};
  if(op==='valueTrace')return value.trace(args.target,args.options||{});
  if(op==='correlate')return value.correlate(args.targets,args.options||{});
  if(op==='simulateValue')return value.simulate(args.target,args.options||{});
  throw new Error('Unsupported precision operation: '+op);
}
parentPort.postMessage({type:'ready',status:{backend:'precision-value-engine',root:host.root}});
parentPort.on('message',async m=>{try{parentPort.postMessage({id:m.id,result:await run(m.op,m.args||{})});}catch(error){parentPort.postMessage({id:m.id,error:errorInfo(error)});}});
