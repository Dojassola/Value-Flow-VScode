'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {parseTS}=require('../lib/ts-analysis');
const {makeCodeFlow,sliceData}=require('../lib/code-flow');
const {CodeExplorer,workerParse,javaParse}=require('../lib/code-explorer');
const {FlowEngine}=require('../lib/flow-engine');
const {VSCodeAdapter}=require('../lib/vscode-adapter');
const {fixture}=require('./ls-fixture');
const loc={uri:'file:///test.ts',file:'test.ts',line:1,column:1};
function flow(code,needle='function'){return makeCodeFlow(parseTS(code,'test.ts',code.indexOf(needle)),code,loc,code.indexOf(needle));}
const byCode=(g,s)=>g.nodes.find(n=>n.code===s||n.code?.includes(s));
const producers=(g,n,binding)=>g.dataEdges.filter(e=>e.to===n.id&&(!binding||e.label===binding)).map(e=>g.nodes.find(x=>x.id===e.from).code);

test('TS CFG contains both if branches, branch join, exact source and local alias reaching definitions',()=>{
 const src='function f(input:number) { let a=input; if(a>0){ a=2; } else { a=3; } const b=a; return b; }';
 const g=flow(src,'const b'),join=byCode(g,'const b=a;');
 assert.deepEqual(producers(g,join,'a').sort(),['a=2;','a=3;']);
 const first=byCode(g,'let a=input;');assert.ok(producers(g,first,'input').some(x=>x.startsWith('function f')));
 assert.ok(g.edges.some(e=>e.type==='true'));assert.ok(g.edges.some(e=>e.type==='false'));
 assert.equal(g.selectedNodeId,join.id);
 const upstream=sliceData(g,join.id,'incoming');assert.ok(upstream.nodes.some(n=>n.code==='a=2;'));assert.ok(upstream.nodes.some(n=>n.code==='a=3;'));
 const downstream=sliceData(g,first.id,'outgoing');assert.ok(downstream.nodes.some(n=>n.role==='condition'));
 for(const n of g.nodes.filter(n=>!['exit','throwExit','external','opaque-call-result'].includes(n.role))) assert.equal(n.code,src.slice(n.start,n.end));
});
test('local overwrites kill previous definitions and same-name block variables are separate bindings',()=>{
 const g=flow('function f(a:number){ let x=a; { let x=9; sink(x); } x=2; const y=x; return y; }','const y');
 assert.deepEqual(producers(g,byCode(g,'const y=x;'),'x'),['x=2;']);
 assert.deepEqual(producers(g,byCode(g,'sink(x);'),'x'),['let x=9;']);
 assert.notEqual(byCode(g,'let x=9;').writes[0].id,byCode(g,'let x=a;').writes[0].id);
});
test('loops preserve continue-to-update, break-to-exit and mark post-return code unreachable',()=>{
 const g=flow('function f(n:number){let x=0;for(let i=0;i<n;i++){ if(i===2) continue; if(i===5) break; x+=i;} return x; x=999;}');
 const update=byCode(g,'i++'),jump=byCode(g,'continue;'),ret=byCode(g,'return x;'),br=byCode(g,'break;');
 assert.ok(g.edges.some(e=>e.from===jump.id&&e.to===update.id&&e.type==='continue'));
 assert.ok(g.edges.some(e=>e.from===br.id&&e.to===ret.id&&e.type==='break'));
 assert.equal(byCode(g,'x=999;').unreachable,true);
 const infinite=flow('function f(){for(;;){continue;} return 7;}');
 assert.equal(infinite.nodes.find(n=>n.role==='condition').code,'true /* for (;;) */');
 assert.equal(byCode(infinite,'return 7;').unreachable,true);
});
test('switch fallthrough and do-while use actual AST structure; opaque try is explicitly marked',()=>{
 const g=flow('function f(x:number){switch(x){case 1:x=2;case 2:x=3;break;default:x=4;}do{x--;}while(x>0);try{foo()}finally{bar()}return x;}');
 assert.ok(g.edges.some(e=>e.from===byCode(g,'x=2;').id&&e.to===byCode(g,'x=3;').id));
 assert.ok(g.nodes.some(n=>n.role==='opaque'));assert.ok(g.edges.some(e=>e.type==='unknown_control'));assert.ok(g.analysis.warnings.length>0);
});
test('call return values remain explicit opaque boundaries, not invented propagation across functions',()=>{
 const g=flow('function f(){const a=load();const b=transform(a);return b;}','const b');
 assert.ok(g.nodes.some(n=>n.role==='opaque-call-result'&&n.name==='load() result'));
 assert.ok(producers(g,byCode(g,'const b=transform(a);'),'a').includes('const a=load();'));
 assert.match(g.limitations.join(' '),/No interprocedural/);
});
test('AST workers support cancellation and diagnostics without evaluating source',async()=>{
 const out=await workerParse({text:'function f(){throw new Error("not executed");}',file:'x.ts',offset:12});
 assert.equal(out.body.statements[0].kind,'throw');
 const c=new AbortController();c.abort();await assert.rejects(workerParse({text:'const x=1',file:'x.ts',offset:0},c.signal));
 assert.ok(parseTS('function f( {','x.ts').warnings.length);
});

test('real JDK parse-only helper produces Java CFG, local dataflow and overload-specific method selection',async()=>{
 const source='class Demo { int f(int input) { int a=input; if(a>0){a=2;}else{a=3;} int b=a; return b; } int f(String s){return 9;} }';
 const offset=source.indexOf('int b');const ir=await javaParse({text:source,file:'Demo.java',offset},'java');
 const g=makeCodeFlow(ir,source,{...loc,uri:'file:///Demo.java',file:'Demo.java'},offset);
 assert.ok(g.analysis.coverage.parser.includes('javac'));
 assert.deepEqual(producers(g,byCode(g,'int b=a;'),'a').sort(),['a=2;','a=3;']);
 const second=await javaParse({text:source,file:'Demo.java',offset:source.indexOf('String s')},'java');
 assert.match(second.entry.code,/String s/);assert.ok(!second.entry.code.includes('int input'));
});
test('Java loop continue, shadowing and opaque exception blocks are retained with warnings',async()=>{
 const src='class Demo { int f(int n){int x=0; {int y=n; sink(y);} for(int i=0;i<n;i++){if(i==2)continue;if(i==3)break;x+=i;}try{x=7;}finally{x=8;}return x;} }';
 const ir=await javaParse({text:src,file:'Demo.java',offset:src.indexOf('int x')},'java');const g=makeCodeFlow(ir,src,loc,src.indexOf('int x'));
 assert.ok(g.edges.some(e=>e.type==='continue'));assert.ok(g.edges.some(e=>e.type==='break'));assert.ok(g.nodes.some(n=>n.role==='opaque'));
 assert.match(g.analysis.warnings.map(w=>w.message).join(' '),/opaque|summar|exception/i);
});
test('Java missing executable and cancelled parser return explicit errors rather than empty graphs',async()=>{
 await assert.rejects(javaParse({text:'class A{}',file:'A.java',offset:0},'/not/a/java'),/ENOENT|JDK|java/i);
 const a=new AbortController();a.abort();await assert.rejects(javaParse({text:'class A{int f(){return 1;}}',file:'A.java',offset:16},'java',a.signal));
});

test('semantic root, definition and implementation merge; distinct functions in the same file remain distinct',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-dedup-'));const f=fixture(root,{'a.ts':'export function normalize(x:number){return x+1;}\nexport function load(){return normalize(1);}\n','b.ts':'import {load as get} from "./a"; export const value=get();'});
 const adapter=new VSCodeAdapter(f.vscode),engine=new FlowEngine(adapter);
 try{const g=await engine.build({file:'a.ts',line:2,column:18},{depth:1});
 const symbols=g.nodes.filter(n=>n.type==='symbol');assert.equal(symbols.filter(n=>n.name==='load').length,1);
 assert.ok(symbols.find(n=>n.name==='load').roles.includes('definition'));assert.ok(symbols.find(n=>n.name==='load').roles.includes('implementation'));
 assert.ok(symbols.some(n=>n.name==='normalize'));assert.ok(!g.edges.some(e=>e.from===e.to&&['defined_at','implemented_by'].includes(e.type)));
 const alias=await engine.build({file:'b.ts',line:1,column:54},{depth:1});assert.equal(alias.nodes.filter(n=>n.location?.file==='a.ts'&&n.location?.line===2).length,1);
 }finally{engine.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('Java provider lifecycle warns on missing/lightweight server and awaits standard readiness',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-java-api-'));const f=fixture(root,{'a.ts':'const a=1;'});let readyCalls=0;
 f.vscode.extensions={getExtension:()=>null};const a=new VSCodeAdapter(f.vscode);
 try{assert.match((await a.ensureLanguage({languageId:'java'}))[0],/no redhat/);
 f.vscode.extensions.getExtension=()=>({activate:async()=>({serverMode:'LightWeight'})});assert.match((await a.ensureLanguage({languageId:'java'}))[0],/Standard/);
 f.vscode.extensions.getExtension=()=>({activate:async()=>({serverMode:'Standard',serverReady:async()=>{readyCalls++;return true;}})});
 assert.deepEqual(await a.ensureLanguage({languageId:'java'}),[]);assert.equal(readyCalls,1);
 }finally{a.invalidate();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('React hierarchy follows semantic alias references, groups repeated JSX and includes prop expressions',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-react-tree-'));
 const f=fixture(root,{'Card.tsx':'export function Card(p:{name:string}) { return <b>{p.name}</b>; }','Page.tsx':'import {Card as UserCard} from "./Card";\nexport function Page(){return <section><UserCard name="A"/><UserCard name="B"/></section>;}'});
 const a=new VSCodeAdapter(f.vscode),x=new CodeExplorer(a),engine=new FlowEngine(a);engine.explorer=x;
 try{const g=await x.componentHierarchy({file:'Card.tsx',line:1,column:18},{depth:1});assert.deepEqual(g.nodes.map(n=>n.name).sort(),['Card','Page']);
 assert.equal(g.edges.length,1);assert.equal(g.edges[0].locations.length,2);assert.ok(g.edges[0].props.some(p=>p.expression==='"A"'));
 const fromPage=await x.componentHierarchy({file:'Page.tsx',line:2,column:18},{depth:1,direction:'outgoing'});assert.equal(fromPage.nodes.length,2);
 const compact=await x.componentHierarchy({file:'Card.tsx',line:1,column:18},{depth:1,includeCode:false});
 assert.ok(compact.nodes.every(n=>!('code'in n)));assert.ok(compact.edges.every(e=>e.props.every(p=>!('expression'in p))));
 const cfg=await x.codeFlow({file:'Card.tsx',line:1,column:18},{includeCode:false});assert.equal(cfg.kind,'code-flow');assert.ok(cfg.nodes.every(n=>!('code'in n)));
 const traced=await x.dataFlow({file:'Card.tsx',line:1,column:18},{includeCode:true});assert.ok(traced.nodes.some(n=>'code'in n));
 }finally{engine.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('conditional expressions and short-circuit writes keep preceding possible definitions',()=>{
 const g=flow('function f(ready:boolean){let a=0; ready && (a=1); const b=a; return b;}','const b');
 const p=producers(g,byCode(g,'const b=a;'),'a');assert.ok(p.includes('let a=0;'));assert.ok(p.includes('ready && (a=1);'));
});
test('Java signed call hierarchy names and broad method definition ranges normalize to one declaration',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-java-range-'));const f=fixture(root,{'a.ts':'export function load(x:number) { return x+1; }\n'});const original=f.vscode.commands.executeCommand;
 f.vscode.commands.executeCommand=async(command,...args)=>{const result=await original(command,...args);if(command==='vscode.prepareCallHierarchy')return result.map(x=>({...x,name:x.name+'(int) : int'}));if(['vscode.executeDefinitionProvider','vscode.executeImplementationProvider'].includes(command))return result.map(x=>({...x,range:{start:new f.vscode.Position(0,0),end:new f.vscode.Position(0,46)}}));return result;};
 const a=new VSCodeAdapter(f.vscode),engine=new FlowEngine(a);try{const g=await engine.build({file:'a.ts',line:1,column:18},{depth:1});assert.equal(g.nodes.filter(n=>n.type==='symbol').length,1);assert.notEqual(g.nodes[0].callHierarchy.incoming,'unavailable');assert.equal(g.nodes[0].location.column,17);assert.ok(g.nodes[0].roles.includes('implementation'));}finally{engine.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('selecting a JSX child usage resolves that child rather than its enclosing parent',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-react-target-'));const f=fixture(root,{'Card.tsx':'export function Card(){return <b>card</b>;}','Page.tsx':'import {Card} from "./Card";\nexport function Page(){return <Card/>;}'});const a=new VSCodeAdapter(f.vscode),engine=new FlowEngine(a),x=new CodeExplorer(a);engine.explorer=x;
 try{const g=await x.componentHierarchy({file:'Page.tsx',line:2,column:32},{depth:1});assert.equal(g.target.name,'Card');const rootNode=g.nodes.find(n=>n.id===g.rootId);assert.ok(rootNode);assert.equal(rootNode.name,'Card');assert.ok(rootNode.location);}finally{engine.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
