'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { VSCodeAdapter } = require('../lib/vscode-adapter');
const { FlowEngine } = require('../lib/flow-engine');
let ts;
try { ts = require(process.env.TYPESCRIPT_PATH || '../vendor/typescript'); } catch { /* Optional integration fixture. */ }

const { fixture } = require('./ls-fixture');

test('real TypeScript language service: aliases, JSX references, call hierarchy, source locations and invalidation', { skip: !ts && 'Install typescript or set TYPESCRIPT_PATH to run this integration fixture.' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfl-typescript-'));
  const files = {
    'service.ts': 'export function normalize(x: number) { return x + 1; }\nexport function loadUser() { return normalize(1); }\n',
    'page.ts': 'import { loadUser as fetchPerson } from "./service";\nexport const actions = { fetch: fetchPerson };\nexport function Page() { return fetchPerson(); }\nexport function Toolbar() { return fetchPerson(); }\nexport function UseActions() { return actions.fetch(); }\n',
    'component.tsx': 'export function Card(props: { name: string }) { return props.name; }\n',
    'screen.tsx': 'import { Card as UserCard } from "./component";\nexport function Screen() { return <UserCard name="A"/>; }\n'
  };
  const f = fixture(root, files), adapter = new VSCodeAdapter(f.vscode), engine = new FlowEngine(adapter);
  try {
    let graph = await engine.build({ file: 'service.ts', line: 2, column: 18 }, { depth: 1 });
    assert.equal(graph.target.name, 'loadUser');
    const names = graph.nodes.filter(n => n.type === 'symbol').map(n => n.name);
    assert.ok(names.includes('Page')); assert.ok(names.includes('Toolbar')); assert.ok(names.includes('normalize'));
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const incoming = graph.edges.find(edge => edge.type === 'calls' && byId.get(edge.from).name === 'Page' && byId.get(edge.to).name === 'loadUser');
    assert.equal(incoming.locations[0].file, 'page.ts'); assert.equal(incoming.locations[0].line, 3);
    const outgoing = graph.edges.find(edge => edge.type === 'calls' && byId.get(edge.to).name === 'normalize');
    assert.equal(outgoing.locations[0].file, 'service.ts'); assert.equal(outgoing.locations[0].line, 2);
    const refs = await engine.references({ file: 'component.tsx', line: 1, column: 18 });
    assert.ok(refs.references.some(ref => ref.location.file === 'screen.tsx' && ref.usageKind === 'jsx'));
    const alias = await engine.build({ file: 'page.ts', line: 2, column: 34 }, { depth: 1 });
    assert.equal(alias.target.name, 'fetchPerson');
    assert.ok(alias.nodes.some(node => node.name === 'normalize'));
    const ownerRefFile = alias.nodes.find(node => node.type === 'referenceFile' && node.location.file === 'page.ts' && node.references.some(ref => ref.location.line === 2));
    assert.ok(ownerRefFile);
    const ownerIndex = ownerRefFile.references.findIndex(ref => ref.location.line === 2);
    const traced = await engine.traceReferenceOwner(alias.graphId, ownerRefFile.id, ownerIndex, { loadReferences: true });
    const ownerNames = traced.ownerIds.map(id => traced.graph.nodes.find(node => node.id === id)?.name);
    assert.ok(ownerNames.includes('actions'));
    const actionsNode = traced.graph.nodes.find(node => node.name === 'actions' && node.roles?.includes('owner'));
    assert.ok(actionsNode);
    const withActionRefs = await engine.expandReferences(alias.graphId, actionsNode.id);
    assert.ok(withActionRefs.nodes.some(node => node.type === 'referenceFile' && node.ownerSymbolId === actionsNode.id && node.location.file === 'page.ts'));
    const hitsBefore = adapter.cache.stats.cacheHits;
    await engine.build({ file: 'service.ts', line: 2, column: 18 }, { depth: 1 });
    assert.ok(adapter.cache.stats.cacheHits > hitsBefore);
    f.update('page.ts', files['page.ts'] + 'export function ExtraPage() { return fetchPerson(); }\n'); engine.invalidate();
    graph = await engine.build({ file: 'service.ts', line: 2, column: 18 }, { depth: 1 });
    assert.ok(graph.nodes.some(n => n.name === 'ExtraPage'));
    const context = await engine.context(graph.graphId, graph.rootId, { includeSnippets: true });
    assert.match(context.source.lines.map(l => l.text).join('\n'), /function loadUser/);
  } finally { engine.dispose(); f.service.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

module.exports = { fixture };
