'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fixture}=require('./ls-fixture');
const {HybridAdapter}=require('../lib/hybrid-adapter');
const {ClassDiagramEngine}=require('../lib/class-diagram');
const {inferReactProps}=require('../lib/react-props');

test('UML analyzer builds classes/interfaces/React components with members and dependency edges using local AST',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-uml-'));
  const f=fixture(root,{'model.tsx':`import {Remote} from './remote';\ninterface Props { title:string; count?:number }\nclass Base { protected id:number=1; ping(x:string):boolean{return !!x} }\nclass Service extends Base { private remote:Remote; run(value:number):string{return String(value)} }\nexport function Card({title,count=1}:Props){ return <Remote title={title}/> }\n`,'remote.tsx':'export function Remote({title}:{title:string}){return <div>{title}</div>}'});
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('provider forbidden')};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,localEngineStartupMs:8000,localEngineMaxFiles:1000});
  try{
    const engine=new ClassDiagramEngine(adapter),g=await engine.analyze({file:'model.tsx',line:4,column:7});
    assert.equal(g.kind,'class-diagram');
    const service=g.nodes.find(n=>n.name==='Service');assert.ok(service);assert.ok(service.uml.fields.some(x=>x.includes('remote')));assert.ok(service.uml.methods.some(x=>x.includes('run(')));
    assert.ok(g.edges.some(e=>e.type==='extends'));
    assert.ok(g.nodes.some(n=>n.name==='Card'&&n.stereotype==='React component'));
    assert.ok(g.edges.some(e=>e.type==='renders'));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('React prop inference fills safe JSON values from types and destructuring defaults',()=>{
  const text=`interface Props { title:string; count:number; active?:boolean; items:string[]; onSave?:()=>void }\nexport function Card({title,count=3,active,items}:Props){return <div>{title}{count}</div>}`;
  const r=inferReactProps(text,'Card.tsx','Card');
  assert.equal(r.props.title,'example');assert.equal(r.props.count,3);assert.equal(r.props.active,true);assert.deepEqual(r.props.items,[]);assert.equal(Object.hasOwn(r.props,'onSave'),false);
});

test('LSP-free value origin follows a destructured callback parameter back through callback invocation',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-callback-origin-'));
  const src=`function gerarLotesPorQuadra(callback:(items:any[])=>void, source:any){ const quadra=source; callback([quadra]); }\nexport function iniciar(source:any){ gerarLotesPorQuadra(([quadra])=>{ const id=Number(quadra.properties.id); return id; }, source); }\n`;
  const f=fixture(root,{'flow.ts':src});f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider forbidden')};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,localEngineStartupMs:8000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.ts',line:2,column:88});
    const g=await adapter.valueTrace(target,{direction:'incoming',depth:7,maxNodes:120});
    assert.equal(g.kind,'value-flow');
    assert.ok(g.nodes.some(n=>/callback argument/.test(n.name)));
    assert.ok(g.nodes.some(n=>/quadra declaration/.test(n.name)));
    assert.ok(g.nodes.some(n=>n.name==='source'||/source/.test(n.name)));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('value tracing preserves imported property origins, node budgets and module variable scopes',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-value-origin-'));
  const f=fixture(root,{'model.ts':'export const record={properties:{id:42,ignored:99}};','flow.ts':`import {record as input} from './model';\nconst copy=input;\nconst selected=copy.properties.id;\nconst forwarded=selected;\nfunction read(){const selected=7;return selected;}\n`});
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider forbidden')};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,localEngineStartupMs:8000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.ts',line:3,column:32});
    const origin=await adapter.valueTrace(target,{direction:'incoming',depth:8,maxNodes:120});
    assert.equal(origin.target.name,'copy.properties.id');assert.ok(origin.nodes.some(n=>n.name==='42'));assert.ok(!origin.nodes.some(n=>n.name==='99'));
    const rootNode=origin.nodes.find(n=>n.id===origin.rootId);assert.equal(rootNode.location.column,32);
    const limited=await adapter.valueTrace(target,{direction:'incoming',depth:8,maxNodes:3});
    assert.equal(limited.nodes.length,3);assert.equal(limited.analysis.state,'partial');assert.ok(limited.analysis.coverage.cutoffs.includes('maxNodes'));assert.ok(limited.analysis.warnings.length);
    const selected=await adapter.target({file:'flow.ts',line:3,column:7}),outgoing=await adapter.valueTrace(selected,{direction:'outgoing',depth:5,maxNodes:120});
    assert.ok(outgoing.nodes.some(n=>n.name==='forwarded'));assert.ok(!outgoing.nodes.some(n=>n.name==='read return'));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('simulation can inject at an unresolved identifier occurrence instead of requiring a declaration',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-occurrence-sim-'));
  const f=fixture(root,{'flow.ts':'export function run(){ return externalValue + 2 }\n'});f.vscode.workspace.textDocuments=[];
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,localEngineStartupMs:8000,localEngineMaxFiles:1000});
  try{const target=await adapter.target({file:'flow.ts',line:1,column:31});const g=await adapter.simulateValue(target,{value:5,maxSteps:50,maxDepth:2});assert.equal(g.kind,'simulation');assert.ok(g.nodes.some(n=>n.role==='inject'));assert.equal(g.result,'7');}
  finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
