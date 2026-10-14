'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fixture}=require('./ls-fixture');
const {HybridAdapter}=require('../lib/hybrid-adapter');
const {FlowEngine}=require('../lib/flow-engine');

test('embedded TS engine resolves references and calls without VS Code semantic commands',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-local-ts-'));
  const f=fixture(root,{
    'service.ts':'export function normalize(x:number){return x+1}\nexport function loadUser(){return normalize(1)}\n',
    'page.ts':'import {loadUser} from "./service";\nexport function Page(){return loadUser()}\nexport function Toolbar(){return loadUser()}\n'
  });
  // If the local engine accidentally touches executeCommand, fail loudly.
  f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code semantic provider must not be used in local mode');};
  f.vscode.workspace.textDocuments=[];
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:8000,localEngineStartupMs:12000,maxFiles:1000});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:12000});
  try{
    const graph=await engine.build({file:'service.ts',line:2,column:18},{depth:1});
    assert.equal(graph.target.name,'loadUser');
    assert.ok(graph.nodes.some(n=>n.name==='Page'));
    assert.ok(graph.nodes.some(n=>n.name==='Toolbar'));
    assert.ok(graph.nodes.some(n=>n.name==='normalize'));
    assert.ok(graph.edges.some(e=>e.source==='code-flow-lens-local-engine'));
  }finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('embedded Java index provides cross-file references/callers without redhat.java',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-local-java-'));
  const files={
    'Service.java':'class Service { int load(){ return normalize(); } int normalize(){ return 1; } }\n',
    'Page.java':'class Page { int render(){ Service s=new Service(); return s.load(); } }\n'
  };
  const f=fixture(root,files); // document facade is enough; semantic commands are forbidden below.
  // Fix language ids for Java files in this synthetic VS Code facade.
  const originalOpen=f.vscode.workspace.openTextDocument;
  f.vscode.workspace.openTextDocument=async u=>{const d=await originalOpen(u);if(u.fsPath.endsWith('.java'))d.languageId='java';return d;};
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code Java provider must not be used');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:8000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:12000});
  try{
    const graph=await engine.build({file:'Service.java',line:1,column:21},{depth:1});
    assert.equal(graph.target.name,'load');
    assert.ok(graph.nodes.some(n=>n.name==='render'));
    assert.ok(graph.nodes.some(n=>n.name==='normalize'));
  }finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});


test('embedded TS engine overlays unsaved editor content and never waits on VS Code providers',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-local-overlay-'));
  const disk='export function work(){return 1}\n';
  const f=fixture(root,{'service.ts':disk,'page.ts':'import {work} from "./service";\nexport function Page(){return work()}\n'});
  f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used');};
  const pagePath=path.join(root,'page.ts'),doc=f.document(pagePath),overlay='import {work} from "./service";\nexport function Page(){return work()}\nexport function Unsaved(){return work()}\n';
  doc.version=2;doc.isDirty=true;doc.getText=()=>overlay;f.vscode.workspace.textDocuments=[doc];
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:8000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:12000});
  try{const graph=await engine.build({file:'service.ts',line:1,column:17},{depth:1});assert.ok(graph.nodes.some(n=>n.name==='Unsaved'));}
  finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('explicit embedded query timeout kills its worker instead of leaving a zombie provider query',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-local-timeout-'));
  const files={'a.ts':'export function a(){return 1}\n'};
  for(let i=0;i<120;i++)files[`use-${i}.ts`]=`import {a} from "./a"; export function b${i}(){return a()}\n`;
  const f=fixture(root,files);f.vscode.workspace.textDocuments=[];
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:3000,localEngineStartupMs:8000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'a.ts',line:1,column:17});
    await assert.rejects(adapter.local.query('references',{target},target,undefined,1),e=>e.code==='LOCAL_ENGINE_TIMEOUT'||e.code==='LOCAL_ENGINE_RESTARTED');
    await new Promise(r=>setTimeout(r,20));assert.equal(adapter.local.workers.size,0);
  }
  finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('adaptive semantic budgets reserve more time for references and implementations than fast queries',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-local-budget-'));
  const f=fixture(root,{'a.ts':'export const a=1\n'});
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:2500,localEngineStartupMs:6000,localEngineMaxFiles:100});
  try{
    assert.ok(adapter.local.budgetFor('definitions')>=4000);
    assert.ok(adapter.local.budgetFor('references')>=4000);
    assert.ok(adapter.local.budgetFor('implementations')>=4000);
    assert.ok(adapter.local.budgetFor('prepare')>=4000);
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('embedded TS engine prioritizes the selected package when root discovery budget skipped it',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-local-focus-'));
  const files={
    'a-first.ts':'export const first=1\n',
    'b-second.ts':'export const second=2\n',
    'z-package/package.json':'{"name":"focused-package"}',
    'z-package/tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler'},include:['src/**/*.ts']}),
    'z-package/src/service.ts':'export function loadUser(){return 1}\n',
    'z-package/src/page.ts':'import {loadUser} from "./service";\nexport function Page(){return loadUser()}\n'
  };
  const f=fixture(root,files);f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used');};
  // A budget of one source file guarantees z-package/src/* is skipped by the
  // initial root scan. The selected file must still create a focused context.
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:8000,localEngineStartupMs:12000,localEngineMaxFiles:1});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:12000});
  try{
    const graph=await engine.build({file:'z-package/src/service.ts',line:1,column:17},{depth:1});
    assert.equal(graph.target.name,'loadUser');
    assert.ok(graph.nodes.some(n=>n.name==='Page'));
    assert.ok(!graph.warnings?.some(w=>/not indexed within this compilation context/i.test(String(w))));
  }finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('embedded TS engine restores a selected project dropped by the compilation-context budget',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-local-context-budget-'));
  const files={};
  for(let i=0;i<18;i++){
    const name=String(i).padStart(2,'0');
    files[`pkg-${name}/tsconfig.json`]=JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler'},include:['src/**/*.ts']});
    files[`pkg-${name}/src/index.ts`]=`export const value${i}=${i}\n`;
  }
  files['pkg-17/src/index.ts']='export function selected(){return 17}\n';
  files['pkg-17/src/use.ts']='import {selected} from "./index";\nexport function Consumer(){return selected()}\n';
  const f=fixture(root,files);f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:8000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:15000});
  try{
    const graph=await engine.build({file:'pkg-17/src/index.ts',line:1,column:17},{depth:1});
    assert.equal(graph.target.name,'selected');
    assert.ok(graph.nodes.some(n=>n.name==='Consumer'));
  }finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('embedded value tracer follows assignments, arguments and returns across workspace functions',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-value-trace-'));
  const f=fixture(root,{
    'flow.ts':'export function normalize(x:number){const y=x+1;return y*2}\nexport function run(userId:number){const result=normalize(userId);return result}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used by value tracer');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,valueEngineTimeoutMs:10000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.ts',line:2,column:21});
    const graph=await adapter.valueTrace(target,{direction:'outgoing',depth:6,maxNodes:120});
    assert.equal(graph.kind,'value-flow');
    assert.ok(graph.nodes.some(n=>n.name==='x'));
    assert.ok(graph.nodes.some(n=>n.name==='normalize return'));
    assert.ok(graph.nodes.some(n=>n.name==='result'));
    assert.ok(graph.edges.some(e=>e.type==='argument'));
    assert.ok(graph.edges.some(e=>e.type==='call_return'));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('multi-symbol correlation identifies shared object/write and shared function parameter',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-correlation-'));
  const f=fixture(root,{
    'flow.ts':'function normalize(x:number){return x}\nexport function run(userId:number,accountId:number){const payload={userId,accountId}; const a=normalize(userId); const b=normalize(accountId); return payload}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used by correlation');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,valueEngineTimeoutMs:10000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  try{
    const a=await adapter.target({file:'flow.ts',line:2,column:21});
    const b=await adapter.target({file:'flow.ts',line:2,column:35});
    const graph=await adapter.correlate([a,b],{depth:5,maxNodes:160});
    assert.equal(graph.kind,'correlation');
    assert.ok(graph.correlations.length>0);
    const types=new Set(graph.correlations.flatMap(c=>c.types));
    assert.ok(types.has('shared_write_target')||types.has('shared_parameter')||types.has('common_destination'));
    assert.ok(graph.nodes.some(n=>n.role==='intersection'));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('static simulation injects a user value, chooses concrete branch and follows direct workspace calls without eval',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-simulation-'));
  const f=fixture(root,{
    'flow.ts':'function double(x:number){return x*2}\nexport function run(value:number){let n=value; if(n>3){n=n+1}else{n=0} const result=double(n); return result}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used by simulation');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,valueEngineTimeoutMs:10000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.ts',line:2,column:21});
    const graph=await adapter.simulateValue(target,{value:5,maxSteps:120,maxDepth:4});
    assert.equal(graph.kind,'simulation');
    assert.equal(graph.result,'12');
    assert.ok(graph.nodes.some(n=>n.role==='inject'&&n.simulationValue==='5'));
    assert.ok(graph.nodes.some(n=>/if => true/.test(n.name)));
    assert.ok(graph.nodes.some(n=>/return 12/.test(n.name)));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('value tracer carries React JSX props into destructured component parameters and local consumers',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-value-jsx-'));
  const f=fixture(root,{
    'flow.tsx':'function Child({value}:{value:number}){const doubled=value*2;return <span>{doubled}</span>}\nexport function Parent(source:number){return <Child value={source}/>}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used by JSX value tracing');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,valueEngineTimeoutMs:10000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.tsx',line:2,column:24});
    const graph=await adapter.valueTrace(target,{direction:'outgoing',depth:6,maxNodes:120});
    assert.ok(graph.edges.some(e=>e.type==='jsx_prop'));
    assert.ok(graph.nodes.some(n=>n.name==='value'));
    assert.ok(graph.nodes.some(n=>n.name==='doubled'));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('value tracer carries JSX props through a props object property read',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-value-jsx-props-'));
  const f=fixture(root,{
    'flow.tsx':'function Child(props:{value:number}){const doubled=props.value*2;return <span>{doubled}</span>}\nexport function Parent(source:number){return <Child value={source}/>}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used by JSX props-object tracing');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,valueEngineTimeoutMs:10000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.tsx',line:2,column:24});
    const graph=await adapter.valueTrace(target,{direction:'outgoing',depth:6,maxNodes:120});
    assert.ok(graph.nodes.some(n=>n.name==='Child.value'));
    assert.ok(graph.nodes.some(n=>n.name==='doubled'));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('static simulation can inject a local variable value and override its initializer on the simulated root path',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-simulation-local-'));
  const f=fixture(root,{
    'flow.ts':'export function run(input:number){\n  let value=input+1;\n  if(value>5){value=value+1}\n  return value*2\n}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used by local simulation');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,valueEngineTimeoutMs:10000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.ts',line:2,column:7});
    const graph=await adapter.simulateValue(target,{value:7,maxSteps:120,maxDepth:4});
    assert.equal(graph.result,'16');
    assert.ok(graph.nodes.some(n=>n.role==='inject'&&n.simulationValue==='7'));
    assert.ok(!graph.analysis.warnings.some(w=>/could not be injected/.test(w.message)));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('static simulation can inject one destructured binding without requiring concrete sibling values',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-simulation-destructure-'));
  const f=fixture(root,{
    'flow.ts':'export function run(obj:{a:number,b:number}){\n  const {a,b}=obj;\n  return a*10\n}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used by destructuring simulation');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,valueEngineTimeoutMs:10000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.ts',line:2,column:10});
    const graph=await adapter.simulateValue(target,{value:5,maxSteps:120,maxDepth:4});
    assert.equal(graph.result,'50');
    assert.ok(graph.nodes.some(n=>n.role==='inject'&&n.simulationValue==='5'));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('correlation also reports shared function scope, shared call sites, common callers and common callees',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-correlation-structural-'));
  const f=fixture(root,{
    'scope.ts':'export function pair(a:number,b:number){console.log(a);console.error(b);}\nfunction sink(a:number,b:number){return a-b}\nexport function joined(a:number,b:number){return sink(a,b)}\n',
    'calls.ts':'function common(){return 1}\nfunction alpha(){return common()}\nfunction beta(){return common()}\nexport function orchestrate(){alpha();beta()}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used by structural correlation');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:5000,valueEngineTimeoutMs:10000,localEngineStartupMs:12000,localEngineMaxFiles:1000});
  try{
    const a=await adapter.target({file:'scope.ts',line:1,column:22});
    const b=await adapter.target({file:'scope.ts',line:1,column:31});
    const scopeGraph=await adapter.correlate([a,b],{depth:3,maxNodes:160});
    const scopeTypes=new Set(scopeGraph.correlations.flatMap(c=>c.types));
    assert.ok(scopeTypes.has('shared_function_scope'));
    const ja=await adapter.target({file:'scope.ts',line:3,column:24});
    const jb=await adapter.target({file:'scope.ts',line:3,column:33});
    const joinedGraph=await adapter.correlate([ja,jb],{depth:3,maxNodes:160});
    assert.ok(joinedGraph.correlations.flatMap(c=>c.types).includes('shared_call_site'));
    const alpha=await adapter.target({file:'calls.ts',line:2,column:10});
    const beta=await adapter.target({file:'calls.ts',line:3,column:10});
    const fnGraph=await adapter.correlate([alpha,beta],{depth:3,maxNodes:180});
    const fnTypes=new Set(fnGraph.correlations.flatMap(c=>c.types));
    assert.ok(fnTypes.has('common_caller'));
    assert.ok(fnTypes.has('common_callee'));
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('2500 ms baseline no longer turns a medium TS package into cascading relation timeouts',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-adaptive-package-'));
  const files={
    'service.ts':'export function target(x:number){return x+1}\n',
    'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler'},include:['**/*.ts']})
  };
  for(let i=0;i<320;i++)files[`src/use-${i}.ts`]=`import {target} from "../service"; export function use${i}(){return target(${i})}\n`;
  const f=fixture(root,files);f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:2500,localEngineStartupMs:6000,localEngineMaxFiles:8000});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:20000});
  try{
    const graph=await engine.build({file:'service.ts',line:1,column:17},{depth:1,maxReferences:80,maxNodes:60});
    const timeoutWarnings=graph.analysis.warnings.filter(w=>w.code==='LOCAL_ENGINE_TIMEOUT'||w.code==='LOCAL_ENGINE_RESTARTED');
    assert.equal(timeoutWarnings.length,0);
    assert.ok(graph.analysis.counts.references>0);
    assert.ok(graph.analysis.counts.callers>0);
  }finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('instant relationship worker starts focus-only and does not spawn the precision worker for a normal graph',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-instant-start-'));
  const files={'app/core.ts':'export function target(){return 1}\n','app/use.ts':'import {target} from "./core"; export function use(){return target()}\n'};
  for(let i=0;i<300;i++)files[`unrelated/u${i}.ts`]=`export const u${i}=${i}\n`;
  const f=fixture(root,files);f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:3000,localEngineStartupMs:6000,localEngineMaxFiles:8000});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:12000});
  try{
    const target=await adapter.target({file:'app/core.ts',line:1,column:17});
    const status=await adapter.local.status(target);
    assert.equal(status.discoveredSourceFiles,1,'startup should register only the focused file');
    assert.equal(adapter.local.heavyWorkers.size,0,'normal status must not start precision analysis');
    const graph=await engine.build({file:'app/core.ts',line:1,column:17},{depth:1});
    assert.ok(graph.nodes.some(n=>n.name==='use'));
    assert.equal(adapter.local.heavyWorkers.size,0,'normal relationship graph must stay on the fast worker');
    assert.equal(adapter.local.workers.size,1);
  }finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('instant AST index follows a re-export alias/barrel without building a TypeScript Program',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-instant-barrel-'));
  const f=fixture(root,{
    'package.json':'{"name":"barrel"}',
    'core.ts':'export function target(){return 1}\n',
    'barrel.ts':'export { target as renamed } from "./core";\n',
    'page.ts':'import { renamed as run } from "./barrel"; export function Page(){return run()}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:1000,localEngineStartupMs:6000,localEngineMaxFiles:1000});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:12000});
  try{
    const graph=await engine.build({file:'core.ts',line:1,column:17},{depth:1,maxReferences:20,maxNodes:30});
    assert.ok(graph.nodes.some(n=>n.name==='Page'),'barrel alias should resolve to the caller');
    assert.ok(graph.analysis.counts.references>0);
    assert.equal(graph.analysis.timings.semanticProgramBuildMs,0);
    const target=await adapter.target({file:'core.ts',line:1,column:17});
    const status=await adapter.local.status(target);
    assert.equal(status.quick.backend,'persistent-bloom-ast-index');
  }finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('instant AST index handles local export lists without a module specifier',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-instant-local-export-'));
  const f=fixture(root,{
    'package.json':'{"name":"local-export"}',
    'core.ts':'function target(){return 1}\nexport { target };\n',
    'page.ts':'import { target as run } from "./core"; export function Page(){return run()}\n'
  });
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:1000,localEngineStartupMs:6000,localEngineMaxFiles:1000});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:12000});
  try{
    const graph=await engine.build({file:'core.ts',line:1,column:10},{depth:1,maxReferences:20,maxNodes:30});
    assert.equal(graph.target.name,'target');
    assert.ok(graph.nodes.some(n=>n.name==='Page'),'local export list should resolve to imported caller');
    assert.ok(graph.analysis.counts.references>0);
    assert.ok(!graph.analysis.warnings.some(w=>/Cannot read properties of undefined/.test(String(w.message||w))));
  }finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('instant graph stays responsive in a large package because normal relations never build a semantic Program',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-instant-large-'));
  const files={'package.json':'{"name":"large"}','service.ts':'export function target(x:number){return x+1}\n'};
  for(let i=0;i<700;i++)files[`src/use-${i}.ts`]=`import {target} from "../service"; export function use${i}(){return target(${i})}\n`;
  for(let i=0;i<700;i++)files[`other/u-${i}.ts`]=`export type T${i}={a:${i},b:string}; export const v${i}:${i}=${i}\n`;
  const f=fixture(root,files);f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:500,localEngineStartupMs:6000,localEngineMaxFiles:8000});
  const engine=new FlowEngine(adapter,{operationTimeoutMs:12000});
  try{
    const started=Date.now();
    const graph=await engine.build({file:'service.ts',line:1,column:17},{depth:1,maxReferences:40,maxNodes:45});
    const elapsed=Date.now()-started;
    assert.ok(graph.analysis.counts.references>0);
    assert.ok(graph.analysis.counts.callers>0);
    assert.ok(!graph.analysis.warnings.some(w=>w.code==='LOCAL_ENGINE_TIMEOUT'||w.code==='LOCAL_ENGINE_RESTARTED'));
    assert.ok(elapsed<5000,`large-package instant graph took ${elapsed}ms`);
    assert.equal(graph.analysis.timings.semanticProgramBuildMs,0);
  }finally{engine.dispose();adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('simulation stays on the fast worker and never starts the precision worker',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-quick-simulation-'));
  const f=fixture(root,{'flow.ts':'function double(x:number){return x*2}\nexport function run(value:number){let n=value+1; return double(n)}\n'});
  f.vscode.workspace.textDocuments=[];f.vscode.commands.executeCommand=async()=>{throw new Error('VS Code provider must not be used by quick simulation');};
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:2500,valueEngineTimeoutMs:50,localEngineStartupMs:6000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.ts',line:2,column:21});
    const started=Date.now();
    const graph=await adapter.simulateValue(target,{value:5,maxSteps:120,maxDepth:4,timeBudgetMs:500});
    assert.equal(graph.result,'12');
    assert.equal(adapter.local.heavyWorkers.size,0,'simulateValue must not spawn the precision worker');
    assert.ok(Date.now()-started<2500,'quick simulation should finish before the old precision watchdog');
    assert.equal(graph.analysis.coverage.kind,'quick-syntax-abstract-interpretation');
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('quick simulation returns a partial graph at its own step budget instead of timing out the worker',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-quick-simulation-budget-'));
  const body=Array.from({length:80},(_,i)=>`v=v+${i+1};`).join('');
  const f=fixture(root,{'flow.ts':`export function run(input:number){let v=input;${body}return v}\n`});
  f.vscode.workspace.textDocuments=[];
  const adapter=new HybridAdapter(f.vscode,{mode:'local',localEngineTimeoutMs:2500,valueEngineTimeoutMs:50,localEngineStartupMs:6000,localEngineMaxFiles:1000});
  try{
    const target=await adapter.target({file:'flow.ts',line:1,column:39});
    const graph=await adapter.simulateValue(target,{value:1,maxSteps:20,maxDepth:2,timeBudgetMs:150});
    assert.equal(graph.kind,'simulation');
    assert.equal(graph.analysis.state,'partial');
    assert.ok(graph.analysis.coverage.cutoffs.includes('internalBudget'));
    assert.ok(graph.nodes.length>0);
    assert.equal(adapter.local.heavyWorkers.size,0);
  }finally{adapter.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('persistent bloom prefilter survives recreation and narrows candidate files without parsing the workspace',()=>{
  const {BloomFileIndex}=require('../lib/bloom-file-index');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-bloom-persist-')),cache=path.join(root,'.cache');
  try{
    const a=path.join(root,'a.ts'),b=path.join(root,'b.ts'),c=path.join(root,'c.ts');
    fs.writeFileSync(a,'export function target(){return 1}\n');
    fs.writeFileSync(b,'import {target} from "./a"; target();\n');
    fs.writeFileSync(c,'export const unrelated=123\n');
    const idx=new BloomFileIndex(root,cache);for(const f of [a,b,c]){const st=fs.statSync(f);idx.updateText(root,f,fs.readFileSync(f,'utf8'),st)}idx.saveSoon(root);
    const first=idx.candidates(root,['target'],{limit:20});assert.ok(first.includes(a));assert.ok(first.includes(b));assert.ok(!first.includes(c));
    const again=new BloomFileIndex(root,cache);const second=again.candidates(root,['target'],{limit:20});assert.ok(second.includes(a));assert.ok(second.includes(b));assert.ok(!second.includes(c));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
