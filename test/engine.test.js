'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FlowEngine } = require('../lib/flow-engine');
const { QueryCache } = require('../lib/query-cache');
const { classifyUsage } = require('../lib/vscode-adapter');
const { FakeAdapter } = require('./fake-adapter');
const options = { direction: 'outgoing', depth: 1, definitions: false, implementations: false, references: false };

test('root snapshot exists before semantic analysis starts', async () => {
  const a = new FakeAdapter(), e = new FlowEngine(a), g = await e.create({ symbol: 'A' }, options);
  assert.equal(g.nodes.length, 1); assert.equal(a.requests.length, 0); assert.equal(g.analysis.state, 'loading');
});
test('depth 1 is lazy; expansion adds another hop; cycles deduplicate', async () => {
  const a = new FakeAdapter(), e = new FlowEngine(a);
  let g = await e.build({ symbol: 'A' }, options);
  assert.deepEqual(g.nodes.map(n => n.name).sort(), ['A', 'B']);
  assert.ok(!a.requests.includes('outgoing:B'));
  const b = g.nodes.find(n => n.name === 'B'); g = await e.expand(g.graphId, b.id, { direction: 'outgoing' });
  assert.equal(g.nodes.length, 3); assert.ok(a.requests.includes('outgoing:B'));
  const c = g.nodes.find(n => n.name === 'C'); g = await e.expand(g.graphId, c.id, { direction: 'outgoing', levels: 8 });
  assert.equal(g.nodes.length, 3); assert.equal(g.edges.filter(edge => edge.type === 'calls').length, 3);
  assert.equal(new Set(g.nodes.map(n => n.id)).size, g.nodes.length);
});
test('incoming and outgoing edges retain caller -> callee orientation and call sites', async () => {
  const e = new FlowEngine(new FakeAdapter()), g = await e.build({ symbol: 'A' }, { ...options, direction: 'both' });
  const byId = new Map(g.nodes.map(n => [n.id, n.name]));
  assert.ok(g.edges.some(edge => byId.get(edge.from) === 'Page' && byId.get(edge.to) === 'A'));
  assert.ok(g.edges.some(edge => byId.get(edge.from) === 'A' && byId.get(edge.to) === 'B'));
  for (const edge of g.edges) assert.equal(edge.locations[0].file, byId.get(edge.from) + '.ts');
});
test('node budget is explicit, not silently complete; increasing it resumes expansion', async () => {
  const e = new FlowEngine(new FakeAdapter());
  let g = await e.build({ symbol: 'A' }, { ...options, depth: 8, maxNodes: 2 });
  assert.equal(g.nodes.length, 2); assert.ok(g.analysis.coverage.cutoffs.includes('maxNodes'));
  assert.equal(g.analysis.coverage.completeRepositoryAnalysis, false);
  g = await e.expand(g.graphId, g.rootId, { direction: 'outgoing', levels: 8, maxNodes: 20 });
  assert.equal(g.nodes.length, 3);
});
test('references are grouped and declaration excluded; pagination and snippet opt-in work', async () => {
  const e = new FlowEngine(new FakeAdapter()), g = await e.build({ symbol: 'A' }, { depth: 0 });
  assert.equal(g.analysis.counts.references, 2); assert.equal(g.analysis.counts.referenceFiles, 2);
  const page = await e.references({ symbol: 'A' }, { limit: 1 });
  assert.equal(page.nextOffset, 1); assert.equal(page.references.length, 1); assert.equal(page.references[0].source, undefined);
  const next = await e.references({ symbol: 'A' }, { offset: 1, limit: 1, includeSnippets: true });
  assert.equal(next.nextOffset, null); assert.ok(next.references[0].source.untrustedSourceText);
});

test('a concrete reference can be traced to lexical owners and the nearest owner references can be expanded', async () => {
  const engine = new FlowEngine(new FakeAdapter());
  let graph = await engine.build({ symbol: 'A' }, { depth: 0, maxNodes: 40, maxReferences: 20 });
  const refFile = graph.nodes.find(n => n.type === 'referenceFile' && n.location.file === 'Page.ts');
  assert.ok(refFile);
  const traced = await engine.traceReferenceOwner(graph.graphId, refFile.id, 0, { loadReferences: true });
  graph = traced.graph;
  assert.ok(traced.ownerIds.length >= 2);
  const nearest = graph.nodes.find(n => n.id === traced.ownerIds[0]);
  assert.equal(nearest.name, 'OptionsObject');
  assert.equal(nearest.referenceExpansion, 'loaded');
  assert.ok(graph.edges.some(e => e.type === 'inside_symbol'));
  assert.ok(graph.edges.some(e => e.type === 'referenced_at'));
  assert.ok(graph.nodes.some(n => n.type === 'referenceFile' && n.ownerSymbolId === nearest.id));
  assert.ok(engine.adapter.requests.some(item => item.startsWith('owners:Page.ts:')));
});

test('unsupported hierarchy and failed reference provider preserve a usable root', async () => {
  const a = new FakeAdapter(); a.noHierarchy = true; a.failReferences = true;
  const e = new FlowEngine(a), g = await e.build({ symbol: 'A' }, {});
  assert.ok(g.nodes.find(n => n.id === g.rootId));
  assert.equal(g.nodes.find(n => n.id === g.rootId).callHierarchy.incoming, 'unavailable');
  assert.ok(g.analysis.warnings.some(w => w.stage === 'references')); assert.equal(g.analysis.state, 'partial');
});
test('enclosing function is not misreported as the selected local variable', async () => {
  const a = new FakeAdapter(); a.prepare = async () => ({ items: [a.item('Page')], excluded: 0 });
  const e = new FlowEngine(a), g = await e.build({ symbol: 'localVariable' }, options);
  assert.equal(g.nodes.length, 1); assert.equal(g.nodes[0].callHierarchy.outgoing, 'unavailable');
});
test('cancellation keeps already obtained nodes and returns a visible cancelled state', async () => {
  const a = new FakeAdapter(); a.delay = 100;
  const e = new FlowEngine(a), start = await e.create({ symbol: 'A' }, options);
  const promise = e.analyze(start.graphId); setTimeout(() => e.cancel(start.graphId), 5);
  const g = await promise; assert.equal(g.analysis.state, 'cancelled'); assert.equal(g.nodes.length, 1);
});
test('source invalidation marks snapshots stale and blocks expansion', async () => {
  const e = new FlowEngine(new FakeAdapter()), g = await e.build({ symbol: 'A' }, options);
  e.invalidate(); assert.equal(e.snapshot(g.graphId).analysis.stale, true);
  await assert.rejects(e.expand(g.graphId, g.rootId), { code: 'STALE_GRAPH' });
});
test('impact and path queries preserve bounded semantics, including not-found', async () => {
  const e = new FlowEngine(new FakeAdapter());
  const impact = await e.impact({ symbol: 'A' }, { depth: 1 });
  assert.ok(impact.affectedFiles.includes('Page.ts'));
  const path = await e.dependencyPath({ symbol: 'A' }, { symbol: 'C' }, { depth: 2 });
  assert.equal(path.found, true); assert.deepEqual(path.path.nodes.map(n => n.name), ['A', 'B', 'C']);
  const missing = await e.dependencyPath({ symbol: 'A' }, { symbol: 'Toolbar' }, { depth: 3 });
  assert.equal(missing.found, false); assert.match(missing.note, /NOT prove/);
});
test('node context contains an observed root path and no source unless requested', async () => {
  const e = new FlowEngine(new FakeAdapter()), g = await e.build({ symbol: 'A' }, { ...options, depth: 2 });
  const c = g.nodes.find(n => n.name === 'C'); const ctx = await e.context(g.graphId, c.id);
  assert.equal(ctx.pathFromRoot.nodes.length, 3); assert.equal(ctx.source, undefined);
  const withSource = await e.context(g.graphId, c.id, { includeSnippets: true }); assert.ok(withSource.source);
});
test('query cache deduplicates, caches and invalidates without replaying errors', async () => {
  const c = new QueryCache({ timeoutMs: 100 }); let calls = 0;
  const task = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 2)); return 42; };
  assert.deepEqual(await Promise.all([c.run('a', task), c.run('a', task)]), [42, 42]);
  assert.equal(await c.run('a', task), 42); assert.equal(calls, 1);
  c.invalidate(); await c.run('a', task); assert.equal(calls, 2);
  await assert.rejects(c.run('err', () => { throw new Error('bad'); }));
  assert.equal(await c.run('err', () => 7), 7);
});
test('provider timeout does NOT free the real worker slot; stale results are not cached', async () => {
  const c = new QueryCache({ concurrency: 1, timeoutMs: 12 }); let release;
  const first = c.run('hung', () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(first, { code: 'PROVIDER_TIMEOUT' }); assert.equal(c.active, 1);
  let ran = false; const next = c.run('next', () => { ran = true; return 2; });
  await assert.rejects(next, { code: 'PROVIDER_TIMEOUT' }); assert.equal(ran, false);
  c.invalidate(); release(1); await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(c.active, 0); assert.equal(c.cache.has('hung'), false);
});
test('usage classifier does not misclassify equality or arrow tokens as assignment', () => {
  assert.equal(classifyUsage('value === other', 0, 5), 'read');
  assert.equal(classifyUsage('value => value + 1', 0, 5), 'read');
  assert.equal(classifyUsage('value += 1', 0, 5), 'write');
  assert.equal(classifyUsage('<Button value={value} />', 1, 7), 'jsx');
  assert.equal(classifyUsage('const x = fn()', 10, 12), 'call');
});


test('manual one-hop expansion can continue beyond the eight-hop initial request cap', async () => {
  const adapter = new FakeAdapter(); adapter.links = {};
  for (let i = 0; i < 12; i++) adapter.links['Step' + i] = ['Step' + (i + 1)];
  adapter.links.Step12 = [];
  const engine = new FlowEngine(adapter);
  let graph = await engine.build({ symbol: 'Step0' }, { ...options, depth: 1 });
  for (let i = 1; i < 12; i++) {
    const node = graph.nodes.find(n => n.name === 'Step' + i);
    graph = await engine.expand(graph.graphId, node.id, { direction: 'outgoing' });
  }
  assert.ok(graph.nodes.some(n => n.name === 'Step12'));
  assert.equal(graph.nodes.length, 13);
  assert.equal(graph.analysis.coverage.initialCallDepth, 1);
});
