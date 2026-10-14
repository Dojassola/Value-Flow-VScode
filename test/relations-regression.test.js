'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueryCache } = require('../lib/query-cache');
const { VSCodeAdapter } = require('../lib/vscode-adapter');
const { FlowEngine } = require('../lib/flow-engine');
const { FakeAdapter } = require('./fake-adapter');
const { fixture } = require('./ls-fixture');

test('empty provider replies are not negative-cached; nonempty replies still are', async () => {
  const cache = new QueryCache(); let requests = 0;
  const task = async () => ++requests === 1 ? [] : [{ name: 'available after indexing' }];
  assert.deepEqual(await cache.run('refs', task), []);
  assert.equal((await cache.run('refs', task))[0].name, 'available after indexing');
  await cache.run('refs', task);
  assert.equal(requests, 2);
  assert.equal(cache.stats.cacheHits, 1);
});

test('undefined replies are not cached but concurrent consumers still share one real request', async () => {
  const cache = new QueryCache(); let requests = 0;
  const task = async () => { requests++; await new Promise(r=>setTimeout(r,10)); return undefined; };
  await Promise.all([cache.run('cold',task),cache.run('cold',task)]);
  assert.equal(requests,1);
  await cache.run('cold',task);
  assert.equal(requests,2);
});

test('real TS provider after cold activation recovers initially missing refs and calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfl-cold-'));
  const f = fixture(root, {
    'lib.ts': 'export function load() { return 42; }\n',
    'page.ts': 'import {load} from "./lib";\nexport function Page(){return load();}\n'
  });
  let activations=0;
  const extension={isActive:false,activate:async()=>{activations++;extension.isActive=true;return{};}};
  f.vscode.extensions={getExtension:id=>id==='vscode.typescript-language-features'?extension:undefined};
  const actual=f.vscode.commands.executeCommand, seen=new Map(), logs=[];
  f.vscode.commands.executeCommand=async(command,...args)=>{
    const count=(seen.get(command)||0)+1;seen.set(command,count);
    if(['vscode.executeDefinitionProvider','vscode.executeReferenceProvider','vscode.prepareCallHierarchy'].includes(command)&&count===1)return [];
    return actual(command,...args);
  };
  const a=new VSCodeAdapter(f.vscode,{log:line=>logs.push(line)}), e=new FlowEngine(a);
  try {
    const g=await e.build({file:'lib.ts',line:1,column:18},{depth:1});
    assert.equal(activations,1);
    assert.ok(g.analysis.counts.references>0);
    assert.ok(g.nodes.some(n=>n.name==='Page'));
    assert.ok(g.edges.some(edge=>edge.type==='calls'));
    assert.ok(logs.some(l=>l.startsWith('vscode.executeReferenceProvider:')));
    assert.equal(seen.get('vscode.executeReferenceProvider'),2);
  } finally {e.dispose();f.service.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('missing TS editor provider yields an actionable editor notice', async () => {
  const vscode={workspace:{workspaceFolders:[]},extensions:{getExtension:()=>undefined}};
  const a=new VSCodeAdapter(vscode);
  const notices=await a.ensureLanguage({languageId:'typescriptreact'});
  assert.match(notices[0],/not detected/);
  assert.match(notices[0],/Enable the built-in TypeScript and JavaScript Language Features extension/);
});

test('cold retry budget does not delay empty leaf callees', async () => {
  let count=0;
  const vscode={workspace:{workspaceFolders:[]},commands:{executeCommand:async()=>{count++;return [];}}};
  const a=new VSCodeAdapter(vscode);a.emptyRetryUntil=Date.now()+5000;
  await a.query('vscode.provideOutgoingCalls',[],'leaf');
  assert.equal(count,1);
});

test('cancelling discovery retry preserves cancellation and starts no further request', async () => {
  let count=0;
  const vscode={workspace:{workspaceFolders:[]},commands:{executeCommand:async()=>{count++;return [];}}};
  const a=new VSCodeAdapter(vscode);a.emptyRetryUntil=Date.now()+5000;
  const op=new AbortController();
  const pending=a.query('vscode.executeReferenceProvider',[],'refs',op.signal);
  setTimeout(()=>op.abort(),15);
  await assert.rejects(pending,{code:'CANCELLED'});
  assert.equal(count,1);
});

test('root-only result explicitly reports unavailable relationships instead of a silent ready graph', async () => {
  const a=new FakeAdapter();a.noHierarchy=true;a.references=async()=>({items:[],excluded:0});
  const e=new FlowEngine(a);
  try {const g=await e.build({symbol:'A'},{});
    assert.equal(g.nodes.length,1);assert.equal(g.edges.length,0);
    assert.equal(g.analysis.state,'partial');
    assert.ok(g.analysis.warnings.some(w=>w.stage==='relationships'&&w.message.includes('not proof')));
  }finally{e.dispose();}
});

test('reference-only symbol graph retains actual grouped relations without making duplicate definitions', async () => {
  const a=new FakeAdapter();a.noHierarchy=true;
  const e=new FlowEngine(a);
  try {const g=await e.build({symbol:'A'},{});
    assert.equal(g.nodes.filter(n=>n.type==='symbol').length,1);
    assert.equal(g.nodes.filter(n=>n.type==='referenceFile').length,2);
    assert.equal(g.edges.filter(e=>e.type==='referenced_in').length,2);
    assert.equal(g.analysis.counts.references,2);
  }finally{e.dispose();}
});
