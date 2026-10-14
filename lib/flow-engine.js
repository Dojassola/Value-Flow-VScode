'use strict';
const crypto = require('node:crypto');
const { fail, checkAbort, bounded, locKey, idFor, errorInfo, clone } = require('./util');

async function workers(items, count, task) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (index < items.length) { const i = index++; await task(items[i]); }
  }));
}
function bareName(name) { return String(name || '').split('(')[0].trim().split('.').pop(); }
function findPath(nodes, edges, from, isTarget, direction = 'outgoing', types) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const adjacent = new Map();
  function add(a, b, edge) { if (!adjacent.has(a)) adjacent.set(a, []); adjacent.get(a).push({ id: b, edge }); }
  for (const edge of edges) {
    if (types && !types.includes(edge.type)) continue;
    if (direction !== 'incoming') add(edge.from, edge.to, edge);
    if (direction !== 'outgoing') add(edge.to, edge.from, edge);
  }
  const queue = [from], parent = new Map([[from, null]]);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (isTarget(byId.get(id))) {
      const ids = [], pathEdges = []; let current = id;
      while (current !== null) { ids.push(current); const step = parent.get(current); if (step) pathEdges.push(step.edge); current = step ? step.previous : null; }
      return { nodes: ids.reverse().map(key => byId.get(key)), edges: pathEdges.reverse() };
    }
    for (const next of adjacent.get(id) || []) if (!parent.has(next.id)) { parent.set(next.id, { previous: id, edge: next.edge }); queue.push(next.id); }
  }
  return null;
}

/** Shared, UI-independent analysis engine. All source access is delegated to an
 * adapter. No webview, HTTP, chat client or VS Code imports live in this module.
 */
class FlowEngine {
  constructor(adapter, { maxSessions = 16, operationTimeoutMs = 30000, onChange = () => {} } = {}) {
    this.adapter = adapter; this.sessions = new Map(); this.pinned = new Set();
    this.maxSessions = maxSessions; this.operationTimeoutMs = operationTimeoutMs; this.onChange = onChange;
  }
  config(options = {}) {
    const direction = options.direction ?? 'both';
    if (!['incoming', 'outgoing', 'both'].includes(direction)) fail('INVALID_ARGUMENT', 'direction must be incoming, outgoing or both.');
    return {
      depth: bounded(options.depth, 1, 0, 8), maxNodes: bounded(options.maxNodes, 80, 2, 500),
      maxReferences: bounded(options.maxReferences, 150, 0, 1000), direction,
      references: options.references !== false, definitions: options.definitions !== false,
      implementations: options.implementations !== false
    };
  }
  session(id) {
    const s = this.sessions.get(id);
    if (!s) fail('GRAPH_NOT_FOUND', 'This graph has expired or VS Code was reloaded. Run get_symbol_flow again.');
    s.lastAccess = Date.now(); return s;
  }
  async create(spec, options = {}, signal) {
    const config = this.config(options), target = await this.adapter.target(spec, signal);
    checkAbort(signal);
    if (this.sessions.size >= this.maxSessions) {
      const victim = [...this.sessions.values()].filter(s => !s.busy && !this.pinned.has(s.id)).sort((a, b) => a.lastAccess - b.lastAccess)[0];
      if (!victim) fail('BUSY', 'Too many active graph sessions. Cancel another analysis.');
      this.sessions.delete(victim.id);
    }
    const id = crypto.randomUUID(), rootId = idFor('symbol', locKey(target.location));
    const root = { id: rootId, type: 'symbol', role: 'root', roles: ['root'], name: target.name, location: target.location,
      languageId: target.languageId, layer: 0, referenceExpansion: 'unloaded', callHierarchy: { incoming: 'unloaded', outgoing: 'unloaded' } };
    const s = { id, rootId, target, config, nodes: new Map([[rootId, root]]), edges: new Map(), items: new Map(),
      callIdByKey: new Map([[locKey(target.location), rootId]]), adjacency: new Map(), warnings: new Map(), cutoffs: new Set(), revision: 0,
      startedAt: Date.now(), lastAccess: Date.now(), state: 'loading', stale: false, busy: false, operation: null,
      stats: { excludedResults: 0, providerReferences: 0, inspectedReferences: 0 }, timings: {}, pending: [], definitionLocations: [] };
    this.sessions.set(id, s); this.touch(s); return this.snapshot(id);
  }
  touch(s) { s.revision++; s.updatedAt = Date.now(); this.onChange(s.id); }
  warn(s, stage, error) {
    const info = typeof error === 'string' ? { code: 'NOTICE', message: error } : errorInfo(error);
    s.warnings.set(stage + ':' + info.code, { stage, ...info });
  }
  observed(s, result) {
    s.stats.excludedResults += result?.excluded || 0;
    if (result?.excluded) s.cutoffs.add('workspace-scope-or-excluded-files');
    if (result?.coverage?.truncated) {
      s.cutoffs.add('query-candidate-budget');
      if (!s.warnings.has('coverage:QUERY_CANDIDATE_BUDGET')) this.warn(s, 'coverage', { code: 'QUERY_CANDIDATE_BUDGET', message: `The selected name appears in ${result.coverage.matchedFiles} files; ${result.coverage.candidateFiles} were checked semantically for this interactive graph. Expand/refine a narrower symbol if needed.` });
    }
    if (result?.coverage?.programBuildMs !== undefined) s.timings.semanticProgramBuildMs = Math.max(s.timings.semanticProgramBuildMs || 0, result.coverage.programBuildMs);
  }
  putNode(s, node) {
    if (s.nodes.has(node.id)) return s.nodes.get(node.id);
    if (s.nodes.size >= s.config.maxNodes) { s.cutoffs.add('maxNodes'); return null; }
    s.nodes.set(node.id, node); return node;
  }
  symbolNode(s, location, role, name, layer = 0) {
    const key = locKey(location), id = s.callIdByKey.get(key) || idFor('symbol', key);
    let node = s.nodes.get(id);
    if (!node) node = this.putNode(s, { id, type: 'symbol', role, roles: [role], name, location, layer,
      referenceExpansion: 'unloaded', callHierarchy: { incoming: 'unloaded', outgoing: 'unloaded' } });
    if (node) { s.callIdByKey.set(key, node.id); node.roles = [...new Set([...(node.roles || []), role])]; }
    return node;
  }
  edge(s, from, to, type, locations = [], totalSites = locations.length) {
    if (from === to && ['defined_at', 'implemented_by'].includes(type)) return;
    const id = idFor('edge', `${from}|${to}|${type}`);
    const previous = s.edges.get(id);
    if (previous) {
      previous.locations = [...new Map([...previous.locations, ...locations].map(loc => [locKey(loc), loc])).values()].slice(0, 10);
      previous.reportedSiteCount = Math.max(previous.reportedSiteCount, totalSites, previous.locations.length);
      previous.sitesTruncated = previous.reportedSiteCount > previous.locations.length;
      return;
    }
    if (s.edges.size >= 3000) { s.cutoffs.add('maxEdges'); return; }
    s.edges.set(id, { id, from, to, type, source: this.adapter.semanticSource || 'language-service', locations: locations.slice(0, 10), reportedSiteCount: totalSites, sitesTruncated: totalSites > 10 });
  }
  async operate(s, signal, operation) {
    if (s.busy) fail('BUSY', 'This graph is already being updated. Wait or cancel the current analysis.');
    if (s.stale) fail('STALE_GRAPH', 'Source files changed. Refresh the graph before expanding it.');
    checkAbort(signal);
    s.busy = true; s.state = 'loading'; const controller = new AbortController(); s.operation = controller;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { s.cutoffs.add('operationTimeout'); controller.abort(); }, this.operationTimeoutMs);
    const started = Date.now(); this.touch(s);
    try { await operation(controller.signal); s.state = s.warnings.size || s.cutoffs.size ? 'partial' : 'ready'; }
    catch (error) {
      if (controller.signal.aborted || error?.code === 'CANCELLED') {
        s.state = 'cancelled';
        this.warn(s, 'analysis', s.cutoffs.has('operationTimeout') ? 'Operation time budget reached. The partial graph is preserved.' : 'Analysis stopped. Existing nodes are preserved.');
      } else { s.state = 'error'; this.warn(s, 'analysis', error); }
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      s.busy = false; s.operation = null; s.pending = []; s.timings.lastOperationMs = Date.now() - started;
      s.timings.totalMs = Date.now() - s.startedAt; this.touch(s);
    }
    return this.snapshot(s.id);
  }
  async analyze(id, signal) {
    const s = this.session(id);
    return this.operate(s, signal, async currentSignal => {
      if (this.adapter.ensureLanguage) { const notices = await this.adapter.ensureLanguage(s.target, currentSignal); for (const notice of notices || []) this.warn(s, 'language', notice); }
      const timed = async (stage, fn) => {
        const start = Date.now(); s.pending.push(stage); this.touch(s);
        try { return await fn(); }
        catch (error) { checkAbort(currentSignal); this.warn(s, stage, error); return null; }
        finally { s.timings[stage + 'Ms'] = Date.now() - start; s.pending = s.pending.filter(p => p !== stage); this.touch(s); }
      };

      // Normal TS/JS relations share one persistent candidate index for the
      // selected symbol. Stages stay ordered so the UI receives progressive,
      // deterministic snapshots without competing workspace-sized LSP requests.
      const definitions = await timed('definitions', async () => {
        const result = await this.adapter.definitions(s.target, currentSignal); checkAbort(currentSignal); this.observed(s, result); s.definitionLocations = result.items;
        if (result.items.length === 1) {
          const root = s.nodes.get(s.rootId); root.selectedLocation = s.target.location;
          root.location = result.items[0]; root.canonicalLocations = result.items;
          s.callIdByKey.set(locKey(result.items[0]), s.rootId);
        }
        if (s.config.definitions) for (const loc of result.items) {
          const node = this.symbolNode(s, loc, 'definition', s.target.name, -1);
          if (node) this.edge(s, s.rootId, node.id, 'defined_at', [loc]);
        }
        return result;
      }) || { items: [], excluded: 0 };

      await timed('calls', async () => {
        const result = await this.adapter.prepare(s.target, currentSignal); checkAbort(currentSignal); this.observed(s, result);
        const defKeys = new Set(definitions.items.map(locKey));
        const matched = result.items.filter(item => bareName(item.name) === s.target.name || item.key === locKey(s.target.location) || defKeys.has(item.key));
        const root = s.nodes.get(s.rootId);
        if (!matched.length) {
          root.callHierarchy = { incoming: 'unavailable', outgoing: 'unavailable' };
          root.callHierarchyNote = 'No matching call hierarchy item. This can mean a non-callable symbol or a bounded semantic result; references remain useful.';
          return;
        }
        s.items.set(s.rootId, matched);
        root.canonicalLocations = matched.map(item => item.location);
        root.canonicalNames = [...new Set(matched.map(item => item.name))];
        for (const item of matched) s.callIdByKey.set(item.key, s.rootId);
        this.touch(s);
        await this.traverse(s, s.rootId, s.config.direction, s.config.depth, currentSignal);
      });


      if (s.config.references && s.config.maxReferences !== 0) await timed('references', async () => {
        const result = await this.adapter.references(s.target, currentSignal); checkAbort(currentSignal); this.observed(s, result);
        const definitionKeys = new Set(definitions.items.map(locKey));
        const refs = result.items.filter(loc => !definitionKeys.has(locKey(loc)));
        s.stats.providerReferences = refs.length;
        if (refs.length > s.config.maxReferences) s.cutoffs.add('maxReferences');
        const enriched = await this.adapter.enrichReferences(refs.slice(0, s.config.maxReferences), currentSignal);
        checkAbort(currentSignal); s.stats.inspectedReferences = enriched.length;
        const byFile = new Map();
        for (const ref of enriched) { const key = ref.location.uri; if (!byFile.has(key)) byFile.set(key, []); byFile.get(key).push(ref); }
        for (const [uri, entries] of byFile) {
          const first = entries[0].location;
          const counts = {}; for (const ref of entries) counts[ref.usageKind] = (counts[ref.usageKind] || 0) + 1;
          const node = this.putNode(s, { id: idFor('references', s.rootId + '|' + uri), type: 'referenceFile', role: 'references', name: first.file.split('/').pop(), location: first, references: entries, usageCounts: counts, layer: 2, ownerSymbolId: s.rootId, sourceSymbolName: s.target.name });
          if (node) this.edge(s, s.rootId, node.id, 'referenced_in', entries.slice(0, 10).map(ref => ref.location), entries.length);
        }
        s.nodes.get(s.rootId).referenceExpansion = refs.length > s.config.maxReferences ? 'partial' : 'loaded';
      });

      if (s.config.implementations) await timed('implementations', async () => {
        const result = await this.adapter.implementations(s.target, currentSignal); checkAbort(currentSignal); this.observed(s, result);
        for (const loc of result.items) {
          const node = this.symbolNode(s, loc, 'implementation', s.target.name, 1);
          if (node) this.edge(s, s.rootId, node.id, 'implemented_by', [loc]);
        }
      });

      if (!s.edges.size) this.warn(s, 'relationships',
        'No relationships were returned for this position. This is not proof of no uses. The embedded engine may have hit a focused-context or time budget; Refresh or inspect Diagnostics.');
    });
  }
  async build(spec, options, signal) { const graph = await this.create(spec, options, signal); return this.analyze(graph.graphId, signal); }
  async expand(id, nodeId, { direction = 'both', levels = 1, maxNodes } = {}, signal) {
    const s = this.session(id);
    if (!s.nodes.has(nodeId)) fail('NODE_NOT_FOUND', 'This node is not in the graph.');
    if (!['incoming', 'outgoing', 'both'].includes(direction)) fail('INVALID_ARGUMENT', 'Invalid expansion direction.');
    levels = bounded(levels, 1, 1, 8);
    if (maxNodes !== undefined) s.config.maxNodes = bounded(maxNodes, s.config.maxNodes, s.nodes.size, 500);
    if (s.nodes.size < s.config.maxNodes) s.cutoffs.delete('maxNodes');
    return this.operate(s, signal, async currentSignal => {
      s.pending = ['expand ' + direction]; this.touch(s);
      await this.traverse(s, nodeId, direction, levels, currentSignal);
    });
  }
  async expandReferences(id, nodeId, { maxReferences } = {}, signal) {
    const s = this.session(id), node = s.nodes.get(nodeId);
    if (!node || node.type !== 'symbol') fail('NODE_NOT_EXPANDABLE', 'References can be expanded from semantic symbol nodes.');
    if (maxReferences !== undefined) s.config.maxReferences = bounded(maxReferences, s.config.maxReferences, 0, 1000);
    return this.operate(s, signal, async currentSignal => {
      s.pending = ['references for ' + node.name]; this.touch(s);
      await this.loadReferencesForNode(s, nodeId, currentSignal);
    });
  }
  async loadReferencesForNode(s, nodeId, signal) {
    const node = s.nodes.get(nodeId);
    if (!node || node.type !== 'symbol') return [];
    if (node.referenceExpansion === 'loaded') return [...s.nodes.values()].filter(item => item.type === 'referenceFile' && item.ownerSymbolId === nodeId).map(item => item.id);
    if (s.config.maxReferences === 0) { node.referenceExpansion = 'unavailable'; this.touch(s); return []; }
    let result, definitions;
    try {
      [result, definitions] = await Promise.all([
        this.adapter.references({ name: node.name, location: node.location }, signal),
        this.adapter.definitions({ name: node.name, location: node.location }, signal)
      ]);
      checkAbort(signal); this.observed(s, result); this.observed(s, definitions);
    } catch (error) {
      checkAbort(signal); node.referenceExpansion = 'error'; this.warn(s, 'references:' + node.name, error); this.touch(s); return [];
    }
    const definitionKeys = new Set(definitions.items.map(locKey));
    const refs = result.items.filter(loc => !definitionKeys.has(locKey(loc)));
    if (refs.length > s.config.maxReferences) s.cutoffs.add('maxReferences');
    const enriched = await this.adapter.enrichReferences(refs.slice(0, s.config.maxReferences), signal);
    const byFile = new Map();
    for (const ref of enriched) { const key = ref.location.uri; if (!byFile.has(key)) byFile.set(key, []); byFile.get(key).push(ref); }
    const ids = [];
    for (const [uri, entries] of byFile) {
      const first = entries[0].location, counts = {};
      for (const ref of entries) counts[ref.usageKind] = (counts[ref.usageKind] || 0) + 1;
      const child = this.putNode(s, { id: idFor('references', nodeId + '|' + uri), type: 'referenceFile', role: 'references',
        name: first.file.split('/').pop(), location: first, references: entries, usageCounts: counts,
        layer: (node.layer || 0) + 2, ownerSymbolId: nodeId, sourceSymbolName: node.name });
      if (!child) continue;
      this.edge(s, nodeId, child.id, 'referenced_in', entries.slice(0, 10).map(ref => ref.location), entries.length); ids.push(child.id);
    }
    node.referenceExpansion = refs.length > s.config.maxReferences ? 'partial' : 'loaded';
    this.touch(s); return ids;
  }
  async traceReferenceOwner(id, referenceFileNodeId, referenceIndex, { loadReferences = true, maxReferences } = {}, signal) {
    const s = this.session(id), referenceFile = s.nodes.get(referenceFileNodeId);
    if (!referenceFile || referenceFile.type !== 'referenceFile') fail('NODE_NOT_REFERENCE_FILE', 'Choose a reference-file node and one of its reference locations.');
    if (!Number.isInteger(referenceIndex) || referenceIndex < 0 || referenceIndex >= (referenceFile.references?.length || 0)) fail('REFERENCE_NOT_FOUND', 'Reference index is outside the loaded reference list.');
    if (maxReferences !== undefined) s.config.maxReferences = bounded(maxReferences, s.config.maxReferences, 0, 1000);
    let result = { ownerIds: [], occurrenceId: null, focusNodeId: null };
    const graph = await this.operate(s, signal, async currentSignal => {
      const ref = referenceFile.references[referenceIndex];
      s.pending = ['finding lexical owner']; this.touch(s);
      const containers = await this.adapter.containingSymbols(ref.location, currentSignal); checkAbort(currentSignal);
      const sourceId = referenceFile.ownerSymbolId || s.rootId;
      const source = s.nodes.get(sourceId);
      const occurrenceId = idFor('referenceOccurrence', sourceId + '|' + locKey(ref.location));
      const occurrence = this.putNode(s, { id: occurrenceId, type: 'referenceOccurrence', role: 'reference',
        name: `${source?.name || referenceFile.sourceSymbolName || 'symbol'} reference`, location: ref.location,
        usageKind: ref.usageKind, classificationSource: ref.classificationSource, layer: (referenceFile.layer || 0) + 1 });
      if (occurrence) {
        this.edge(s, sourceId, occurrence.id, 'referenced_at', [ref.location], 1);
        this.edge(s, referenceFile.id, occurrence.id, 'contains_reference', [ref.location], 1);
      }
      const owners = containers.items.filter(item => locKey(item.location) !== locKey(ref.location));
      if (!owners.length) {
        this.warn(s, 'reference-owner', 'No containing document symbol was reported for this reference. The language provider may not expose lexical object/function ownership here.');
        result = { ownerIds: [], occurrenceId, focusNodeId: occurrenceId }; return;
      }
      const ownerIds = []; let previous = occurrenceId;
      for (let i = 0; i < owners.length; i++) {
        const owner = owners[i], key = locKey(owner.location); let ownerId = s.callIdByKey.get(key) || idFor('symbol', key);
        let ownerNode = s.nodes.get(ownerId);
        if (!ownerNode) {
          ownerNode = this.putNode(s, { id: ownerId, type: 'symbol', role: 'owner', roles: ['owner'], name: owner.name,
            location: owner.location, symbolKind: owner.kind, detail: owner.detail || `Contains reference to ${source?.name || referenceFile.sourceSymbolName || 'symbol'}`,
            layer: (referenceFile.layer || 0) + 2 + i, canonicalLocations: [owner.location], referenceExpansion: 'unloaded',
            callHierarchy: { incoming: 'unloaded', outgoing: 'unloaded' } });
          if (!ownerNode) break;
          s.callIdByKey.set(key, ownerId);
        } else if (!ownerNode.roles?.includes('owner')) {
          ownerNode.roles = [...(ownerNode.roles || []), 'owner'];
        }
        ownerIds.push(ownerId);
        if (previous && ownerId !== previous) this.edge(s, previous, ownerId, 'inside_symbol', [ref.location], 1);
        previous = ownerId;
      }
      const nearest = ownerIds[0];
      if (loadReferences && nearest) {
        s.pending = ['references for ' + s.nodes.get(nearest).name]; this.touch(s);
        await this.loadReferencesForNode(s, nearest, currentSignal);
      }
      result = { ownerIds, occurrenceId, focusNodeId: nearest || occurrenceId, containersTruncated: containers.truncated };
    });
    return { graph, ...result };
  }
  async traverse(s, startId, direction, depth, signal) {
    const directions = direction === 'both' ? ['incoming', 'outgoing'] : [direction];
    await Promise.all(directions.map(async dir => {
      let frontier = [startId]; const visited = new Set();
      for (let level = 0; level < depth && frontier.length; level++) {
        checkAbort(signal); const next = new Set();
        await workers(frontier, 3, async id => {
          if (visited.has(id)) return; visited.add(id); checkAbort(signal);
          const children = await this.expandOne(s, id, dir, signal);
          for (const child of children) if (!visited.has(child)) next.add(child);
        });
        frontier = [...next];
      }
    }));
  }
  async expandOne(s, id, direction, signal) {
    const node = s.nodes.get(id), adjacencyKey = id + '|' + direction;
    if (!node?.callHierarchy || node.callHierarchy[direction] === 'unavailable') return [];
    if (node.callHierarchy[direction] === 'loaded') return s.adjacency.get(adjacencyKey) || [];
    if (s.nodes.size >= s.config.maxNodes) { s.cutoffs.add('maxNodes'); node.callHierarchy[direction] = 'partial'; return []; }
    let items = s.items.get(id);
    if (!items?.length) {
      try {
        const prepared = await this.adapter.prepare({ name: node.name, location: node.location }, signal);
        items = prepared.items.filter(item => bareName(item.name) === bareName(node.name) || item.key === locKey(node.location));
        if (!items.length) { node.callHierarchy[direction] = 'unavailable'; return []; }
        s.items.set(id, items);
      } catch (error) { checkAbort(signal); node.callHierarchy[direction] = 'error'; this.warn(s, direction, error); this.touch(s); return []; }
    }
    const next = new Set(s.adjacency.get(adjacencyKey) || []); let limited = false, failed = false;
    for (const item of items) {
      let result;
      try { result = await this.adapter.calls(item, direction, signal); checkAbort(signal); }
      catch (error) { checkAbort(signal); failed = true; this.warn(s, direction, error); continue; }
      this.observed(s, result);
      for (const call of result.items) {
        const reserveForRelations = id === s.rootId && s.config.references && s.config.maxReferences !== 0 && s.nodes.get(s.rootId)?.referenceExpansion === 'unloaded'
          ? Math.min(20, Math.max(5, Math.floor(s.config.maxNodes * 0.25))) : 0;
        if (reserveForRelations && s.nodes.size >= s.config.maxNodes - reserveForRelations) { s.cutoffs.add('initial-call-node-budget'); limited = true; break; }
        const key = call.item.key;
        let neighborId = s.callIdByKey.get(key);
        if (!neighborId) {
          neighborId = idFor('symbol', key);
          const neighbor = this.putNode(s, { id: neighborId, type: 'symbol', role: direction === 'incoming' ? 'caller' : 'callee',
            roles: [direction === 'incoming' ? 'caller' : 'callee'], name: call.item.name, location: call.item.location,
            symbolKind: call.item.kind, detail: call.item.detail, layer: node.layer + (direction === 'incoming' ? -1 : 1),
            canonicalLocations: [call.item.location], referenceExpansion: 'unloaded', callHierarchy: { incoming: 'unloaded', outgoing: 'unloaded' } });
          if (!neighbor) { limited = true; continue; }
          s.callIdByKey.set(key, neighborId); s.items.set(neighborId, [call.item]);
        }
        const neighbor = s.nodes.get(neighborId), role = direction === 'incoming' ? 'caller' : 'callee';
        if (!neighbor.roles.includes(role)) neighbor.roles.push(role);
        this.edge(s, direction === 'incoming' ? neighborId : id, direction === 'incoming' ? id : neighborId, 'calls', call.sites, call.totalSites);
        next.add(neighborId);
      }
    }
    node.callHierarchy[direction] = failed ? 'error' : limited ? 'partial' : 'loaded';
    s.adjacency.set(adjacencyKey, [...next]); this.touch(s); return [...next];
  }
  snapshot(id) {
    const s = this.session(id), nodes = [...s.nodes.values()], edges = [...s.edges.values()];
    const frontier = nodes.filter(node => (node.callHierarchy && Object.values(node.callHierarchy).some(status => ['unloaded', 'partial', 'error'].includes(status))) || ['unloaded', 'partial', 'error'].includes(node.referenceExpansion)).map(node => node.id);
    return clone({ schemaVersion: '1.1', graphId: s.id, revision: s.revision, rootId: s.rootId,
      target: s.target, workspaces: this.adapter.workspaces(), createdAt: new Date(s.startedAt).toISOString(), updatedAt: new Date(s.updatedAt).toISOString(),
      positionEncoding: '1-based lines and UTF-16 columns', nodes, edges,
      analysis: { state: s.state, busy: s.busy, stale: s.stale, pending: s.pending, timings: s.timings, warnings: [...s.warnings.values()],
        coverage: { kind: this.adapter.semanticSource === 'code-flow-lens-local-engine' ? 'bounded-static-local-semantic-graph' : 'bounded-static-language-service-graph', initialCallDepth: s.config.depth, maxNodes: s.config.maxNodes,
          maxReferences: s.config.maxReferences, direction: s.config.direction, cutoffs: [...s.cutoffs], frontierNodeIds: frontier,
          completeRepositoryAnalysis: false, ...s.stats },
        counts: { nodes: nodes.length, edges: edges.length, callers: nodes.filter(n => n.roles?.includes('caller') && n.id !== s.rootId).length,
          callees: nodes.filter(n => n.roles?.includes('callee') && n.id !== s.rootId).length,
          references: nodes.reduce((sum, n) => sum + (n.references?.length || 0), 0), referenceFiles: nodes.filter(n => n.type === 'referenceFile').length } },
      limitations: ['Static semantic relationships from the selected Code Flow Lens backend; not runtime execution or complete interprocedural value-flow tracing.',
        'Reference read/write/call/JSX labels are line-based heuristics, not AST guarantees.',
        'Only allowed workspace files are included. No edge means not observed, not necessarily absent.',
        'Lexical owner tracing uses document-symbol ranges. It can reveal a containing object/function/class but is not runtime value flow.',
        'Call paths do not infer routes, JSX render trees, dependency injection, Context propagation or event dispatch.'] });
  }
  cancel(id) { this.session(id).operation?.abort(); }
  invalidate(reason = 'Source files changed', options = {}) {
    this.adapter.invalidate(options); this.explorer?.invalidate();
    for (const s of this.sessions.values()) { s.stale = true; s.operation?.abort(); this.warn(s, 'source', reason + '. Refresh to analyze current positions.'); this.touch(s); }
  }
  dispose() { for (const s of this.sessions.values()) s.operation?.abort(); this.sessions.clear(); }
  async references(spec, { offset = 0, limit = 100, includeSnippets = false } = {}, signal) {
    offset = bounded(offset, 0, 0, 1000000); limit = bounded(limit, 100, 1, 200);
    const target = await this.adapter.target(spec, signal);
    const [result, defs] = await Promise.all([this.adapter.references(target, signal), this.adapter.definitions(target, signal)]);
    const definitionKeys = new Set(defs.items.map(locKey));
    const locations = result.items.filter(loc => !definitionKeys.has(locKey(loc)));
    const items = await this.adapter.enrichReferences(locations.slice(offset, offset + limit), signal);
    if (includeSnippets) await workers(items, 4, async item => { item.source = await this.adapter.snippet(item.location, 0, signal); });
    return { target, references: items, totalReturnedByProvider: locations.length, offset,
      nextOffset: offset + items.length < locations.length ? offset + items.length : null,
      excluded: result.excluded, classificationSource: 'line-heuristic', scope: 'allowed workspace files', completeRepositoryAnalysis: false };
  }
  async implementations(spec, { limit = 100 } = {}, signal) {
    limit = bounded(limit, 100, 1, 200); const target = await this.adapter.target(spec, signal), result = await this.adapter.implementations(target, signal);
    return { target, implementations: result.items.slice(0, limit), truncated: result.items.length > limit, totalReturnedByProvider: result.items.length, excluded: result.excluded };
  }
  async context(id, nodeId, { includeSnippets = false, contextLines = 2 } = {}, signal) {
    const graph = this.snapshot(id);
    if (graph.analysis.stale) fail('STALE_GRAPH', 'Refresh the graph before requesting current source context.');
    const node = graph.nodes.find(item => item.id === nodeId);
    if (!node) fail('NODE_NOT_FOUND', 'Node not found in this graph.');
    const edges = graph.edges.filter(edge => edge.from === nodeId || edge.to === nodeId);
    const neighborIds = new Set(edges.flatMap(edge => [edge.from, edge.to])); neighborIds.delete(nodeId);
    const neighbors = graph.nodes.filter(item => neighborIds.has(item.id)).slice(0, 30);
    const result = { graphId: id, node, neighbors, neighborsTruncated: neighborIds.size > 30, edges: edges.slice(0, 60), edgesTruncated: edges.length > 60,
      pathFromRoot: findPath(graph.nodes, graph.edges, graph.rootId, item => item?.id === nodeId, 'both'),
      analysis: graph.analysis, limitations: graph.limitations };
    if (includeSnippets && node.location) result.source = await this.adapter.snippet(node.location, contextLines, signal);
    return result;
  }
  async impact(spec, options, signal) {
    const graph = await this.build(spec, { ...options, direction: 'incoming', references: true }, signal);
    return { impactKind: 'candidate-impact-from-static-callers-and-direct-references',
      affectedFiles: [...new Set(graph.nodes.filter(n => n.id !== graph.rootId && (n.roles?.includes('caller') || n.type === 'referenceFile')).map(n => n.location.file))],
      interpretation: 'Candidate affected files, not proof of behavioral impact. JSX routes/render trees and transitive reference ownership are not inferred.', graph };
  }
  async dependencyPath(source, targetSpec, options = {}, signal) {
    const target = await this.adapter.target(targetSpec, signal), definitions = await this.adapter.definitions(target, signal);
    const targetKeys = new Set([locKey(target.location), ...definitions.items.map(locKey)]);
    const graph = await this.build(source, { ...options, references: false, definitions: false, implementations: false, direction: options.direction || 'outgoing' }, signal);
    const path = findPath(graph.nodes, graph.edges, graph.rootId,
      node => node && [node.location, ...(node.canonicalLocations || [])].some(loc => targetKeys.has(locKey(loc))), options.direction || 'outgoing', ['calls']);
    return { graphId: graph.graphId, source: graph.target, target, found: !!path, path,
      relationType: 'calls', traversalDirection: options.direction || 'outgoing', coverage: graph.analysis.coverage,
      state: graph.analysis.state, warnings: graph.analysis.warnings,
      note: path ? 'Edges retain their actual caller -> callee orientation, even in reverse searches.' : 'No call path found within this bounded search. This does NOT prove the symbols are unrelated.' };
  }
}
module.exports = { FlowEngine, findPath, bareName };
