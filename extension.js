'use strict';
const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const { HybridAdapter } = require('./lib/hybrid-adapter');
const { FlowEngine } = require('./lib/flow-engine');
const { CodeExplorer } = require('./lib/code-explorer');
const { ClassDiagramEngine } = require('./lib/class-diagram');
const { inferReactProps } = require('./lib/react-props');
const { bundleInWorker, PreviewServer, validateLocalUrl } = require('./lib/react-preview');
const { previewHtml } = require('./lib/preview-html');
const { webviewHtml } = require('./lib/webview-html');
const { blockedFile } = require('./lib/scope');
const { fail } = require('./lib/util');
let controller;

class Controller {
  constructor(context) {
    this.context = context; this.output = vscode.window.createOutputChannel('Code Flow Lens');
    this.panel = null; this.ready = false; this.epoch = 0; this.activeGraphId = null; this.selectedNodeId = null;
    this.lastTarget = null; this.error = null; this.loading = null; this.updateTimer = null; this.readyTimer = null;
    this.analysisController = null; this.watcher = null; this.disposed = false; this.initToken = ''; this.retriedPanels = new WeakSet();
    const config = vscode.workspace.getConfiguration('codeFlowLens');
    this.adapter = new HybridAdapter(vscode, { log: text => this.log(text), mode: config.get('semanticEngine', 'local'), providerTimeoutMs: config.get('providerTimeoutMs', 4000), localEngineTimeoutMs: config.get('localEngineTimeoutMs', 3000), valueEngineTimeoutMs: config.get('valueEngineTimeoutMs', 6000), localEngineStartupMs: config.get('localEngineStartupMs', 6000), localEngineMaxFiles: config.get('localEngineMaxFiles', 8000), cacheDir: context.globalStorageUri.fsPath });
    this.engine = new FlowEngine(this.adapter, { onChange: id => { if (id === this.activeGraphId) this.scheduleState(); } });
    this.explorer = new CodeExplorer(this.adapter, { javaCommand: () => vscode.workspace.getConfiguration('codeFlowLens').get('javaCommand', 'java') });
    this.classDiagram = new ClassDiagramEngine(this.adapter);
    this.engine.explorer = this.explorer; this.extraGraph = null; this.sourceCards = {}; this.cardPending = new Set(); this.previewSession = null;
    this.correlationTargets = []; this.lastAdvanced = null; this.correlationStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90); this.correlationStatus.command = 'codeFlowLens.showCorrelation'; this.correlationStatus.tooltip = 'Code Flow Lens correlation set'; this.updateCorrelationStatus();
    context.subscriptions.push(this.output, this.correlationStatus,
      vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length && this.isSource(event.document.uri)) this.invalidateGraphs('An open document changed', { structure: false }); }),
      vscode.window.onDidChangeActiveTextEditor(editor => { if(editor) this.prewarmEditor(editor); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('codeFlowLens')) {
          { const c = vscode.workspace.getConfiguration('codeFlowLens'); this.adapter.updateSettings({ mode:c.get('semanticEngine','local'), providerTimeoutMs:c.get('providerTimeoutMs',4000), localEngineTimeoutMs:c.get('localEngineTimeoutMs',3000), valueEngineTimeoutMs:c.get('valueEngineTimeoutMs',6000), localEngineStartupMs:c.get('localEngineStartupMs',6000), localEngineMaxFiles:c.get('localEngineMaxFiles',8000) }); }
          this.invalidateGraphs('Code Flow Lens settings changed');
        }
      }));
    if (vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.adapter.scope.roots = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => ({ name: folder.name, path: folder.uri.fsPath, uri: folder.uri.toString() }));
      this.invalidateGraphs('Workspace folders changed');
    }));
    this.prewarmTimer = setTimeout(() => this.prewarmEditor(vscode.window.activeTextEditor), 200);
  }
  prewarmEditor(editor) {
    if (this.disposed || !editor || !this.isSource(editor.document.uri) || !/^(?:typescript|typescriptreact|javascript|javascriptreact|java)$/.test(editor.document.languageId || '')) return;
    // Fire-and-forget: startup activation keeps one lightweight worker warm for
    // the active workspace. No package crawl or semantic query runs here.
    this.adapter.local.warm({ file: editor.document.uri.fsPath }).catch(() => {});
  }
  invalidateGraphs(reason, options = {}) {
    this.analysisController?.abort(); this.engine.invalidate(reason, options); this.sourceCards = {};
    if (this.extraGraph && !this.extraGraph.readOnlySnapshot && this.extraGraph.kind !== 'runtime-timeline') {
      this.extraGraph.analysis.stale = true;
      const warnings = this.extraGraph.analysis.warnings ||= [];
      if (!warnings.some(w => w.code === 'STALE_GRAPH')) warnings.push({stage:'source',code:'STALE_GRAPH',message:reason + '. Refresh to analyze current positions.'});
    }
    this.scheduleState();
  }
  log(text) { this.output.appendLine(`[${new Date().toISOString()}] ${text}`); }
  ensureWatcher() {
    if (this.watcher || this.disposed) return;
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const changed = uri => { if (this.isSource(uri)) this.invalidateGraphs('A workspace file changed on disk', { structure: false }); };
    const structural = uri => { if (this.isSource(uri)) this.invalidateGraphs('Workspace source files changed', { structure: true }); };
    this.watcher = watcher;
    this.context.subscriptions.push(watcher, watcher.onDidCreate(structural), watcher.onDidChange(changed), watcher.onDidDelete(structural));
  }
  isSource(uri) {
    if (uri.scheme !== 'file') return false;
    const root = vscode.workspace.getWorkspaceFolder(uri);
    return !!root && !blockedFile(path.relative(root.uri.fsPath, uri.fsPath));
  }
  handleError(error) {
    if (this.disposed || error?.code === 'CANCELLED') return;
    this.error = (error?.code ? error.code + ': ' : '') + (error?.message || String(error));
    this.log(error?.stack || this.error); this.scheduleState();
    vscode.window.showErrorMessage('Code Flow Lens: ' + this.error);
  }
  ensurePanel() {
    if (this.disposed) return null;
    const column = vscode.workspace.getConfiguration('codeFlowLens').get('openMode', 'tab') === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    if (this.panel) {
      this.panel.reveal(column, false);
      if (!this.ready) this.armReadyWatchdog(this.panel);
      return this.panel;
    }
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('codeFlowLens.graph', 'Code Flow Lens', column,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true, localResourceRoots: [mediaUri] });
    this.attachPanel(panel);
    return panel;
  }
  attachPanel(panel) {
    this.panel = panel; this.ready = false;
    panel.webview.onDidReceiveMessage(message => { if (this.panel === panel) this.receive(message).catch(error => this.handleError(error)); });
    panel.onDidChangeViewState(event => {
      if (this.panel !== panel) return;
      if (event.webviewPanel.visible) { if (!this.ready) this.armReadyWatchdog(panel); this.sendState(); }
    });
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = null; this.ready = false; clearTimeout(this.readyTimer); this.readyTimer = null;
      this.loading = null; this.error = null;
      this.analysisController?.abort();
      if (this.activeGraphId) {
        this.engine.pinned.delete(this.activeGraphId);
        try { this.engine.cancel(this.activeGraphId); } catch { /* Session already expired. */ }
      }
      this.activeGraphId = null; this.extraGraph = null; this.selectedNodeId = null; this.epoch++;
    });
    this.assignWebviewHtml(panel);
    this.armReadyWatchdog(panel);
  }
  assignWebviewHtml(panel) {
    // A fresh token lets this host ignore ready/error messages coming from the
    // page load it just replaced (stale HTML restored after an extension update).
    this.initToken = crypto.randomBytes(12).toString('hex');
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.html = webviewHtml({
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'graph.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'graph.css')).toString(),
      cspSource: panel.webview.cspSource, initToken: this.initToken
    });
  }
  armReadyWatchdog(panel) {
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.panel === panel && !this.ready) this.recoverWebview(panel, 'The webview did not initialize within 10 seconds.');
    }, 10000);
  }
  recoverWebview(panel, reason) {
    if (this.panel !== panel) return;
    if (!this.retriedPanels.has(panel)) {
      this.retriedPanels.add(panel);
      this.log(reason + ' Reloading the webview interface once.');
      this.ready = false;
      this.assignWebviewHtml(panel);
      this.armReadyWatchdog(panel);
      return;
    }
    this.handleError(new Error(reason + ' Run Developer: Open Webview Developer Tools and check Output > Code Flow Lens.'));
  }
  scheduleState() {
    if (this.updateTimer || this.disposed) return;
    this.updateTimer = setTimeout(() => { this.updateTimer = null; this.sendState(); }, 30);
  }
  getOpenGraph() {
    if (!this.panel || (!this.activeGraphId && !this.extraGraph)) return null;
    return { ...(this.extraGraph ? this.explorer.withoutCode(this.extraGraph) : this.engine.snapshot(this.activeGraphId)), selectedNodeId: this.selectedNodeId };
  }
  sendState() {
    if (!this.panel || !this.ready || this.disposed) return;
    let graph = this.extraGraph;
    try { if (!graph && this.activeGraphId) graph = this.engine.snapshot(this.activeGraphId); } catch { /* A new graph is starting. */ }
    if (graph && !graph.kind && !graph.readOnlySnapshot) this.hydrateCards(graph);
    const visible = graph && this.loading ? { ...graph, analysis: { ...graph.analysis, busy: true, pending: [this.loading] } } : graph;
    this.panel.webview.postMessage({ type: 'flow:state', epoch: this.epoch, graph: visible, cards: this.sourceCards, loading: this.loading, error: this.error });
  }
  hydrateCards(graph) {
    const epoch = this.epoch, maxLines = vscode.workspace.getConfiguration('codeFlowLens').get('codeBlockLines', 12);
    for (const node of graph.nodes.filter(n => n.location && !['referenceFile','referenceOccurrence'].includes(n.type))) {
      const sourceKey = JSON.stringify(node.location); const pendingKey = node.id + sourceKey;
      if (this.sourceCards[node.id]?.sourceKey === sourceKey || this.cardPending.has(pendingKey)) continue;
      this.cardPending.add(pendingKey);
      this.adapter.sourceCard(node.location, maxLines).then(source => {
        if (this.epoch === epoch) { this.sourceCards[node.id] = { ...source, sourceKey }; this.scheduleState(); }
      }, error => { if (this.epoch === epoch) this.sourceCards[node.id] = { lines: [], warning: error.message, sourceKey }; })
        .finally(() => { this.cardPending.delete(pendingKey); });
    }
  }
  async showSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showInformationMessage('Code Flow Lens: open a source file and put the cursor on a symbol.');
    const pos = editor.selection.isEmpty ? editor.selection.active : editor.selection.start;
    return this.analyze({ file: editor.document.uri.toString(), line: pos.line + 1, column: pos.character + 1 });
  }
  updateCorrelationStatus() {
    const n = this.correlationTargets.length;
    if (!n) { this.correlationStatus.hide(); return; }
    this.correlationStatus.text = `$(git-compare) CFL: ${n} correlation symbol${n === 1 ? '' : 's'}`;
    this.correlationStatus.show();
  }
  async preciseTarget(spec, signal) {
    const target = await this.adapter.target(spec, signal);
    try {
      const defs = await this.adapter.definitions(target, signal);
      if (defs.items.length === 1) return { ...target, location: defs.items[0] };
    } catch { /* Current position is still a valid semantic target. */ }
    return target;
  }
  selectionSpecs() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];
    return editor.selections.map(selection => {
      const pos = selection.isEmpty ? selection.active : selection.start;
      return { file: editor.document.uri.toString(), line: pos.line + 1, column: pos.character + 1 };
    });
  }
  async addCorrelationSymbol(specOverride) {
    const spec = specOverride || this.selectionSpecs()[0];
    if (!spec) return vscode.window.showInformationMessage('Code Flow Lens: place the cursor on a symbol first.');
    const target = await this.preciseTarget(spec);
    if (!/^(?:typescript|typescriptreact|javascript|javascriptreact)$/.test(target.languageId || '')) fail('CORRELATION_UNSUPPORTED', 'Value correlation currently supports TypeScript/JavaScript/JSX/TSX symbols.');
    const key = `${target.location.uri}:${target.location.line}:${target.location.column}`;
    if (!this.correlationTargets.some(item => `${item.location.uri}:${item.location.line}:${item.location.column}` === key)) this.correlationTargets.push(target);
    this.correlationTargets = this.correlationTargets.slice(-8); this.updateCorrelationStatus();
    vscode.window.showInformationMessage(`Code Flow Lens: added ${target.name}. Correlation set: ${this.correlationTargets.length}.`);
  }
  async clearCorrelation() { this.correlationTargets = []; this.updateCorrelationStatus(); vscode.window.showInformationMessage('Code Flow Lens: correlation set cleared.'); }
  async showCorrelation() {
    this.ensureWatcher();
    const selections = this.selectionSpecs(); let targets = [];
    if (selections.length >= 2) targets = await Promise.all(selections.slice(0, 8).map(spec => this.preciseTarget(spec)));
    else targets = [...this.correlationTargets];
    const unique = new Map(targets.map(t => [`${t.location.uri}:${t.location.line}:${t.location.column}`, t])); targets = [...unique.values()];
    if (targets.length < 2) fail('CORRELATION_NEEDS_SYMBOLS', 'Create two or more cursors on symbols, or use “Add Symbol to Correlation” on each symbol first.');
    const roots = new Set(targets.map(t => vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(t.location.uri))?.uri.fsPath || ''));
    if (roots.size > 1) fail('CORRELATION_MULTI_ROOT', 'Correlation currently requires the selected symbols to be inside the same workspace folder.');
    this.analysisController?.abort(); if(this.activeGraphId){this.engine.cancel(this.activeGraphId);this.engine.pinned.delete(this.activeGraphId);} const op = new AbortController(); this.analysisController = op; const epoch = ++this.epoch;
    this.activeGraphId = null; this.extraGraph = null; this.sourceCards = {}; this.cardPending.clear(); this.error = null; this.loading = `Correlating ${targets.length} symbols`; this.ensurePanel(); this.sendState();
    const c = vscode.workspace.getConfiguration('codeFlowLens'); const started = Date.now();
    try {
      const graph = await this.adapter.correlate(targets, { depth: c.get('valueTraceDepth',4), maxNodes: c.get('valueTraceMaxNodes',140) }, op.signal);
      if (epoch !== this.epoch || op.signal.aborted) return;
      graph.analysis.timings.lastOperationMs = Date.now() - started; this.extraGraph = graph; this.selectedNodeId = graph.rootId; this.lastTarget = targets[0]; this.lastAdvanced = { kind:'correlation', targets };
      this.panel.title = 'Correlation: ' + targets.map(t => t.name).join(' × '); this.log(`Correlation: ${graph.analysis.counts.correlations || 0} intersections; ${graph.analysis.counts.nodes} nodes; ${graph.analysis.timings.lastOperationMs} ms`);
    } finally { if (epoch === this.epoch) { this.loading = null; this.sendState(); } }
  }
  async showValueTrace(graphId, nodeId, direction='both', targetOverride) {
    this.ensureWatcher();
    const target = targetOverride || this.targetFor(graphId, nodeId); this.analysisController?.abort(); if(this.activeGraphId){this.engine.cancel(this.activeGraphId);this.engine.pinned.delete(this.activeGraphId);} const op = new AbortController(); this.analysisController = op; const epoch = ++this.epoch;
    this.activeGraphId = null; this.extraGraph = null; this.sourceCards = {}; this.cardPending.clear(); this.error = null; this.loading = 'Tracing value provenance'; this.ensurePanel(); this.sendState();
    try {
      const started=Date.now(); const resolved = await this.adapter.target(target, op.signal); const c = vscode.workspace.getConfiguration('codeFlowLens');
      const graph = await this.adapter.valueTrace(resolved,{direction,depth:c.get('valueTraceDepth',4),maxNodes:c.get('valueTraceMaxNodes',140)},op.signal);
      if(epoch!==this.epoch||op.signal.aborted)return;graph.analysis.timings.lastOperationMs=Date.now()-started;this.extraGraph=graph;this.selectedNodeId=graph.rootId;this.lastTarget=target;this.lastAdvanced={kind:'value',target,direction};this.panel.title='Value: '+resolved.name;
    } finally { if(epoch===this.epoch){this.loading=null;this.sendState();} }
  }
  parseSimulationInput(text) {
    const value = String(text ?? '').trim(); if (value === 'undefined') return undefined; if (value === 'NaN') return NaN; if (value === 'Infinity') return Infinity; if (value === '-Infinity') return -Infinity;
    try { return JSON.parse(value); } catch { return value; }
  }
  async simulateValue(graphId, nodeId, targetOverride, valueOverride = Symbol.for('cfl.no-value')) {
    this.ensureWatcher();
    const target = targetOverride || this.targetFor(graphId,nodeId); const raw = valueOverride === Symbol.for('cfl.no-value') ? await vscode.window.showInputBox({ title:'Code Flow Lens: simulate selected value', prompt:'Enter a JSON value or primitive. Examples: 42, true, "abc", {"id":7}, undefined', value:'42' }) : valueOverride;
    if (raw === undefined && valueOverride === Symbol.for('cfl.no-value')) return; const injected = valueOverride === Symbol.for('cfl.no-value') ? this.parseSimulationInput(raw) : raw; this.analysisController?.abort(); if(this.activeGraphId){this.engine.cancel(this.activeGraphId);this.engine.pinned.delete(this.activeGraphId);} const op=new AbortController();this.analysisController=op;const epoch=++this.epoch;
    this.activeGraphId=null;this.extraGraph=null;this.sourceCards={};this.cardPending.clear();this.error=null;this.loading='Simulating value flow (no workspace code is executed)';this.ensurePanel();this.sendState();
    try{const resolved=await this.adapter.target(target,op.signal),c=vscode.workspace.getConfiguration('codeFlowLens'),started=Date.now();const graph=await this.adapter.simulateValue(resolved,{value:injected,maxSteps:c.get('simulationMaxSteps',180),maxDepth:c.get('simulationMaxDepth',4),timeBudgetMs:c.get('simulationTimeBudgetMs',900)},op.signal);if(epoch!==this.epoch||op.signal.aborted)return;graph.analysis.timings.lastOperationMs=Date.now()-started;this.extraGraph=graph;this.selectedNodeId=graph.selectedNodeId||graph.rootId;this.lastTarget=target;this.lastAdvanced={kind:'simulation',target,value:injected};this.panel.title='Simulation: '+resolved.name;}
    finally{if(epoch===this.epoch){this.loading=null;this.sendState();}}
  }
  async analyze(target) {
    this.ensureWatcher();
    this.extraGraph = null; this.sourceCards = {}; this.cardPending.clear();
    this.analysisController?.abort();
    if (this.activeGraphId) { this.engine.cancel(this.activeGraphId); this.engine.pinned.delete(this.activeGraphId); }
    const operation = new AbortController(); this.analysisController = operation;
    const epoch = ++this.epoch; this.activeGraphId = null; this.selectedNodeId = null;
    // Keep the embedded semantic worker warm between graph opens. Real editor/disk
    // changes invalidate it through the document/file watchers above.
    this.lastTarget = target; this.lastAdvanced = null; this.error = null; this.loading = target.symbol || 'selected symbol'; this.ensurePanel(); this.sendState();
    const settings = vscode.workspace.getConfiguration('codeFlowLens');
    try {
      const initial = await this.engine.create(target, {
        depth: settings.get('lazyExpansion', true) ? 1 : settings.get('callDepth', 2),
        maxNodes: settings.get('maxCallNodes', 80), maxReferences: settings.get('maxReferences', 150)
      }, operation.signal);
      if (epoch !== this.epoch || !this.panel) return;
      this.lastTarget = { ...target, symbol: initial.target.name };
      this.activeGraphId = initial.graphId; this.selectedNodeId = initial.rootId; this.engine.pinned.add(initial.graphId);
      this.loading = null; this.panel.title = 'Flow: ' + initial.target.name; this.sendState();
      const completed = await this.engine.analyze(initial.graphId, operation.signal);
      this.log(`Analysis finished: ${completed.analysis.state}; ${completed.analysis.counts.nodes} nodes; ${completed.analysis.counts.edges} edges; ${completed.analysis.counts.references} refs; ${completed.analysis.timings.lastOperationMs} ms`);
      for (const warning of completed.analysis.warnings) this.log(`${warning.stage}: ${warning.code}: ${warning.message}`);
    } catch (error) { if (epoch === this.epoch && !operation.signal.aborted) this.handleError(error); }
    finally { if (epoch === this.epoch) { this.loading = null; this.sendState(); } }
  }
  activeNode(graphId, nodeId) {
    const graph = this.extraGraph?.graphId === graphId ? this.extraGraph : graphId === this.activeGraphId ? this.engine.snapshot(graphId) : null;
    if (!graph) fail('STALE_VIEW', 'This message belongs to a different graph.');
    const node = graph.nodes.find(item => item.id === nodeId);
    if (!node) fail('NODE_NOT_FOUND', 'Node not found in the displayed graph.');
    return { graph, node };
  }
  targetFor(graphId, nodeId) {
    if (graphId && nodeId) {
      const { graph, node } = this.activeNode(graphId, nodeId);
      if (graph.readOnlySnapshot) fail('SNAPSHOT_READ_ONLY', 'Use Analyze in editor to start a fresh analysis from this snapshot.');
      if (graph.analysis.stale) fail('STALE_GRAPH', 'Source changed. Refresh before following positions.');
      return { file: node.location.uri, line: node.location.line, column: node.location.column };
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) { const pos = editor.selection.active; return { file: editor.document.uri.toString(), line: pos.line + 1, column: pos.character + 1 }; }
    if (this.lastTarget) return this.lastTarget;
    fail('NO_SYMBOL', 'Open a source file and select a symbol first.');
  }
  async showAdvanced(kind, graphId, nodeId, targetOverride) {
    const target = targetOverride || this.targetFor(graphId, nodeId), previous = this.extraGraph;
    if (kind === 'code' && /\.java$/i.test(target.file || '') && !vscode.workspace.isTrusted) fail('UNTRUSTED_WORKSPACE','Trust this workspace before starting the external JDK parser.');
    this.analysisController?.abort(); const op = new AbortController(); this.analysisController = op;
    const epoch = ++this.epoch;
    this.loading = kind === 'react' ? 'Parsing JSX hierarchy' : 'Parsing local control/data flow'; this.error = null;
    this.ensureWatcher(); this.ensurePanel(); this.sendState();
    try {
      let graph = kind === 'react' ? await this.explorer.componentHierarchy(target, { depth: 1, includeCode: true }, op.signal) : await this.explorer.codeFlow(target, { includeCode: true }, op.signal);
      if (kind === 'react' && (!graph.edges?.length || graph.nodes?.length <= 1)) {
        try {
          const uml = await this.classDiagram.analyze(target, op.signal), renderEdges = uml.edges.filter(e => e.type === 'renders');
          if (renderEdges.length) {
            const ids = new Set(renderEdges.flatMap(e => [e.from, e.to]));
            const nodes = uml.nodes.filter(n => ids.has(n.id)).map(n => ({...n,type:'component',role:n.id===uml.rootId?'root':'component',reactExpand:!n.external,code:n.code||undefined}));
            graph = {...uml,kind:'react-hierarchy',nodes,edges:renderEdges,rootId:ids.has(uml.rootId)?uml.rootId:nodes[0]?.id,selectedNodeId:ids.has(uml.rootId)?uml.rootId:nodes[0]?.id,analysis:{...uml.analysis,warnings:[...(uml.analysis.warnings||[]),{stage:'React',code:'LOCAL_AST_FALLBACK',message:'React Tree used the local JSX/import dependency fallback because no provider-style hierarchy edges were resolved.'}],coverage:{...uml.analysis.coverage,kind:'local-jsx-import-hierarchy'}}};
          }
        } catch (fallbackError) { this.log('React local fallback: ' + fallbackError.message); }
      }
      if (epoch !== this.epoch || op.signal.aborted) return;
      if (kind === 'react' && previous?.kind === 'react-hierarchy' && graphId === previous.graphId) {
        const anchor = previous.nodes.find(n => n.id === nodeId), nodes = new Map(previous.nodes.map(n => [n.id, n]));
        for (const n of graph.nodes) if (!nodes.has(n.id) && nodes.size < 150) nodes.set(n.id, { ...n, layer: n.layer + (anchor?.layer || 0) });
        const edges = [...new Map([...previous.edges, ...graph.edges].map(e => [e.id, e])).values()].filter(e => nodes.has(e.from) && nodes.has(e.to));
        graph = { ...previous, nodes: [...nodes.values()], edges, analysis: { ...graph.analysis, counts: { nodes: nodes.size, edges: edges.length } } };
        if (nodes.size >= 150) graph.analysis.coverage.cutoffs.push('reactMergedNodeBudget');
        this.explorer.graphs.set(graph.graphId, graph);
      }
      this.extraGraph = graph; this.lastTarget = target; this.lastAdvanced = { kind, target }; this.selectedNodeId = graph.selectedNodeId || graph.rootId;
      this.panel.title = (kind === 'react' ? 'React: ' : 'Code: ') + graph.target.name;
    } finally { if (epoch === this.epoch && this.analysisController === op) { this.loading = null; this.sendState(); } }
  }
  async showClassDiagram(graphId, nodeId, targetOverride) {
    const target = targetOverride || this.targetFor(graphId, nodeId);
    this.analysisController?.abort(); const op = new AbortController(); this.analysisController = op;
    const epoch = ++this.epoch;
    this.loading = 'Building local UML / dependency diagram'; this.error = null; this.ensureWatcher(); this.ensurePanel(); this.sendState();
    try {
      const graph = await this.classDiagram.analyze(target, op.signal);
      if (epoch !== this.epoch || op.signal.aborted) return;
      if (this.activeGraphId) { this.engine.cancel(this.activeGraphId); this.engine.pinned.delete(this.activeGraphId); }
      this.extraGraph = graph; this.activeGraphId = null; this.lastTarget = target; this.lastAdvanced = { kind: 'class', target };
      this.selectedNodeId = graph.selectedNodeId || graph.rootId; this.panel.title = 'UML: ' + graph.target.name;
    } finally { if (epoch === this.epoch && this.analysisController === op) { this.loading = null; this.sendState(); } }
  }
  async analyzeSmart(graphId, nodeId) {
    const target = this.targetFor(graphId, nodeId), resolved = await this.preciseTarget(target);
    const name = resolved.name || '';
    // Uppercase declarations/components are generally structural entities; lowercase
    // values are more useful as provenance traces. Functions fall back to code flow.
    if (/^[A-Z]/.test(name)) {
      try { return await this.showClassDiagram(graphId, nodeId, target); } catch (error) { this.log('Smart UML fallback: ' + error.message); }
    }
    try { return await this.showValueTrace(graphId, nodeId, 'both', target); }
    catch (error) {
      if (!/^VALUE_|SIMULATION_/.test(error.code || '')) throw error;
      this.log('Smart value fallback to code flow: ' + error.message);
      return this.showAdvanced('code', graphId, nodeId, target);
    }
  }
  diagnoseRelations() {
    const graph = this.extraGraph || (this.activeGraphId ? this.engine.snapshot(this.activeGraphId) : null);
    this.log('--- Relations diagnostics (Code Flow Lens semantic engine) ---');
    this.log('Extension version: ' + this.context.extension?.packageJSON?.version);
    this.log('Workspaces: ' + this.adapter.workspaces().map(w=>w.file).join(', '));
    const c=vscode.workspace.getConfiguration('codeFlowLens');
    this.log('Semantic engine mode: '+c.get('semanticEngine','local'));
    const base=c.get('localEngineTimeoutMs',3000);
    this.log('Local relation engine: Persistent Bloom + AST index; fallback lexical scan budget ~180 ms; catastrophic worker watchdog: '+this.adapter.local.budgetFor('references')+' ms; value engine: '+c.get('valueEngineTimeoutMs',6000)+' ms; max files: '+c.get('localEngineMaxFiles',8000));
    this.log('Built-in VS Code providers are not used for TS/JS/React/Java when semanticEngine=local.');
    if(graph) {
      this.log('Target: ' + JSON.stringify(graph.target));
      this.log('Analysis: ' + JSON.stringify(graph.analysis));
    }
    this.log('Normal TS/JS relationship graphs use the persistent Bloom + AST index: no TypeScript Program or Language Service is built. Candidate lookup reuses an on-disk compact index across reloads; ASTs and module resolutions remain worker-local and incremental.');
    this.output.show(true);
  }
  async diagnoseJava() {
    const config = vscode.workspace.getConfiguration('codeFlowLens');
    const mode = config.get('semanticEngine', 'local');
    const java = config.get('javaCommand', 'java');
    const message = `Java relationships: ${mode === 'vscode' ? 'VS Code provider mode' : 'Code Flow Lens local index'}. Local AST executable: ${java}.`;
    const detail = mode === 'vscode'
      ? 'VS Code provider mode is legacy/troubleshooting mode. Switch codeFlowLens.semanticEngine to local to avoid Java language-server waits.'
      : 'Definitions, workspace references and call relationships are indexed by Code Flow Lens without redhat.java. The lightweight Java index is intentionally conservative around overloads, inheritance and reflection. Method control/data flow uses the JDK parser for higher local precision.';
    const pick = await vscode.window.showInformationMessage(message, { modal: true, detail }, 'Code Flow Lens settings', 'Code Flow logs');
    if (pick === 'Code Flow Lens settings') return vscode.commands.executeCommand('workbench.action.openSettings', 'codeFlowLens.semanticEngine');
    if (pick === 'Code Flow logs') this.output.show(true);
  }
  async previewReact(graphId, nodeId) {
    if (this.disposed) return;
    if (!vscode.workspace.isTrusted) fail('UNTRUSTED_WORKSPACE', 'Trust this workspace before rendering project code.');
    const target = this.targetFor(graphId, nodeId);
    const mode = await vscode.window.showQuickPick([
      { label: 'Isolated component - real React, network blocked', value: 'isolated', description: 'Uses installed project React; supports TS/JS, TS path aliases, plain CSS. No Node execution of project imports.' },
      { label: 'Existing local app / Storybook URL', value: 'url', description: 'Full app bundler, CSS, routing and providers. The app may make requests and perform actions.' }
    ], { title: 'Render project code in a browser (trusted code only)' });
    if (!mode) return;
    let session;
    if (mode.value === 'url') {
      const value = await vscode.window.showInputBox({ title: 'Local app or Storybook URL', value: 'http://localhost:5173', validateInput: value => { try { validateLocalUrl(value); return null; } catch (e) { return e.message; } } });
      if (!value) return;
      session = { isolated: false, url: validateLocalUrl(value), name: 'Running app', props: {} };
    } else {
      const resolved = await this.adapter.target(target), loc = resolved.location; let data = await this.explorer.componentAt(loc);
      let fileLoc = loc;
      if (!data.component || data.component.children.some(c => c.start <= data.offset && data.offset < c.end)) { const defs = await this.adapter.definitions({ name: resolved.name, location: loc }); if (defs.items.length === 1) { fileLoc = defs.items[0]; data = await this.explorer.componentAt(fileLoc); } }
      if (!data.component?.exports.length) fail('PREVIEW_EXPORT_REQUIRED', 'Isolated preview requires a named JSX component exported by its source module. Open its definition, or use the existing app URL.');
      const exportName = data.component.exports.length === 1 ? data.component.exports[0] : await vscode.window.showQuickPick(data.component.exports, { title: 'Component export to render' });
      if (!exportName) return;
      const inferred = inferReactProps(data.text, vscode.Uri.parse(fileLoc.uri).fsPath, data.component.name);
      const defaultProps = JSON.stringify(inferred.props, null, 2);
      const json = await vscode.window.showInputBox({ title: 'Component props (auto-inferred; edit if needed)', prompt: inferred.notes.length ? inferred.notes.join(' | ') : 'Values were inferred from prop types, destructuring defaults and usage. Null means the analyzer could not infer a safe concrete value.', value: defaultProps, validateInput: value => { try { const p = JSON.parse(value); return p && typeof p === 'object' && !Array.isArray(p) ? null : 'Use a JSON object'; } catch (e) { return e.message; } } });
      if (json === undefined) return;
      const consent = await vscode.window.showWarningMessage('Render this component with its installed project dependencies?', { modal: true, detail: 'The component and imported modules execute in an isolated browser, not the extension host. Network requests and form submissions are blocked in isolated mode. No packages are installed and no project files are modified. Providers can be supplied with an optional wrapper. The preview uses saved source files; save edits first.' }, 'Render component');
      if (consent !== 'Render component') return;
      session = { isolated: true, name: data.component.name, file: vscode.Uri.parse(fileLoc.uri).fsPath, exportName, props: JSON.parse(json), roots: this.adapter.scope.roots.map(r => r.path) };
    }
    await this.closePreview(); this.previewSession = session;
    await this.updatePreview(session);
  }
  async updatePreview(session) {
    if (this.disposed || session !== this.previewSession) return;
    if (session.isolated) {
      if (Buffer.byteLength(JSON.stringify(session.props)) > 200000) fail('PROPS_TOO_LARGE', 'Props JSON limit is 200 KB.');
      if (session.wrapper) { session.wrapper = this.adapter.scope.resolve(session.wrapper); await this.adapter.scope.assert(session.wrapper); }
      if (this.disposed || session !== this.previewSession) return;
      session.abort?.abort(); const operation=new AbortController(); session.abort=operation;
      let result;
      try {
        result=await vscode.window.withProgress({ location:vscode.ProgressLocation.Notification,title:'Bundling isolated React preview',cancellable:true },async(_,token)=>{
          const cancel=token.onCancellationRequested(()=>operation.abort());
          try{return await bundleInWorker({file:session.file,exportName:session.exportName,props:session.props,wrapper:session.wrapper||undefined,roots:session.roots},operation.signal);}finally{cancel.dispose();}
        });
      }catch(error){if(operation.signal.aborted)return;throw error;}
      if(this.disposed||session!==this.previewSession||session.abort!==operation||operation.signal.aborted)return;
      const previous=session.server,server=new PreviewServer();let url;
      try{url=await server.start(result);}catch(error){await server.stop();throw error;}
      if(this.disposed||session!==this.previewSession||session.abort!==operation||operation.signal.aborted){await server.stop();return;}
      session.server=server;session.url=url;await previous?.stop();
      if(this.disposed||session!==this.previewSession||session.abort!==operation||operation.signal.aborted)return;
      this.log(`React isolated preview: ${result.moduleCount} modules; ${result.bytes} source bytes; network blocked.`);
    }
    if (!session.panel) {
      const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
      session.panel = vscode.window.createWebviewPanel('codeFlowLens.preview', 'React preview: ' + session.name, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
      session.panel.webview.onDidReceiveMessage(async m => {
        try {
          if (m.command === 'external') await vscode.env.openExternal(vscode.Uri.parse(session.url));
          else if (m.command === 'stop') await this.closePreview();
          else if (m.command === 'uiError') this.log('Preview webview error: ' + String(m.message).slice(0, 500));
          else if (m.command === 'props' && session.isolated) { if (!m.props || typeof m.props !== 'object' || Array.isArray(m.props)) fail('INVALID_PROPS','Use a JSON object'); session.props = m.props; session.wrapper = typeof m.wrapper === 'string' ? m.wrapper : ''; await this.updatePreview(session); }
        } catch (error) { session.panel?.webview.postMessage({ type: 'preview:error', message: error.message }); this.log('Preview: ' + error.stack); }
      }, null, this.context.subscriptions);
      session.panel.onDidDispose(() => { session.abort?.abort(); session.server?.stop().catch(e => this.log(e.message)); session.panel = null; if (this.previewSession === session) this.previewSession = null; }, null, this.context.subscriptions);
    }
    const script = session.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.js'));
    session.panel.webview.html = previewHtml({ ...session, scriptUri: script.toString(), cspSource: session.panel.webview.cspSource });
  }
  async closePreview() { const session = this.previewSession; this.previewSession = null; if (!session) return; session.abort?.abort(); session.panel?.dispose(); await session.server?.stop(); }
  async openLocation(location) {
    if (!location) return;
    const doc = await this.adapter.document(vscode.Uri.parse(location.uri));
    const position = doc.validatePosition(new vscode.Position(location.line - 1, location.column - 1));
    const range = new vscode.Range(position, position);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: this.panel?.viewColumn || vscode.ViewColumn.Active, preview: true, selection: range });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  async receive(message) {
    if (!message || typeof message.command !== 'string') return;
    if (message.command === 'ready') {
      if (message.init !== undefined && message.init !== this.initToken) { this.log('Ignored ready from a replaced webview load.'); return; }
      this.ready = true; clearTimeout(this.readyTimer); this.readyTimer = null; this.log('Webview ready.'); this.sendState(); return;
    }
    if (message.command === 'uiError') {
      if (message.init !== undefined && message.init !== this.initToken) { this.log('Ignored error from a replaced webview load: ' + String(message.message).slice(0, 300)); return; }
      const detail = String(message.message || 'Unknown webview error').slice(0, 2000);
      this.log('Webview error: ' + detail + (message.line ? ' (graph.js:' + message.line + ')' : '') + (message.stack ? '\n' + String(message.stack).slice(0, 3000) : ''));
      if (this.panel && (!this.ready || (Array.isArray(message.missing) && message.missing.length))) this.recoverWebview(this.panel, 'The webview script reported an interface error: ' + detail);
      return;
    }
    if (message.epoch !== this.epoch) return;
    if (this.extraGraph?.readOnlySnapshot && ['expand','expandReferences','traceReferenceOwner','analyzeSmart','classDiagram','codeFlow','reactTree','previewReact','exploreOffset','valueTrace','valueOrigin','valueDestination','simulateValue','addCorrelation'].includes(message.command)) fail('SNAPSHOT_READ_ONLY','This is a frozen imported graph. Analyze the source again before following new relations.');
    switch (message.command) {
      case 'rendered': this.log(`Webview rendered ${message.nodeCount} nodes.`); return;
      case 'diagnostics': return this.diagnoseRelations();
      case 'relations': this.extraGraph = null; if (!this.activeGraphId && this.lastTarget) return this.analyze(this.lastTarget); this.sendState(); return;
      case 'valueTrace': return this.showValueTrace(message.graphId,message.nodeId,'both');
      case 'valueOrigin': return this.showValueTrace(message.graphId,message.nodeId,'incoming');
      case 'valueDestination': return this.showValueTrace(message.graphId,message.nodeId,'outgoing');
      case 'simulateValue': return this.simulateValue(message.graphId,message.nodeId);
      case 'addCorrelation': { const target=this.targetFor(message.graphId,message.nodeId); return this.addCorrelationSymbol(target); }
      case 'showCorrelation': return this.showCorrelation();
      case 'clearCorrelation': return this.clearCorrelation();
      case 'analyzeSmart': return this.analyzeSmart(message.graphId, message.nodeId);
      case 'classDiagram': return this.showClassDiagram(message.graphId, message.nodeId);
      case 'codeFlow': return this.showAdvanced('code', message.graphId, message.nodeId);
      case 'reactTree': return this.showAdvanced('react', message.graphId, message.nodeId);
      case 'previewReact': return this.previewReact(message.graphId, message.nodeId);
      case 'javaHelp': return this.diagnoseJava();
      case 'openCodeLine': { const n = this.activeNode(message.graphId, message.nodeId).node; if (Number.isInteger(message.line) && message.line > 0) return this.openLocation({ ...n.location, line: message.line, column: 1 }); return; }
      case 'exploreOffset': { const n = this.activeNode(message.graphId, message.nodeId).node; if (![...(n.reads || []), ...(n.calls || [])].some(r => r.start === message.offset)) return; const doc = await this.adapter.document(vscode.Uri.parse(n.location.uri)); const pos = doc.positionAt(message.offset); return this.analyze({ file: n.location.uri, line: pos.line + 1, column: pos.character + 1 }); }
      case 'runtime': return this.openRuntime();
      case 'refresh':
        if (this.extraGraph && this.lastAdvanced) {
          this.adapter.invalidate(); this.explorer.invalidate();
          if (this.lastAdvanced.kind === 'react' || this.lastAdvanced.kind === 'code') return this.showAdvanced(this.lastAdvanced.kind, null, null, this.lastAdvanced.target);
          if (this.lastAdvanced.kind === 'class') return this.showClassDiagram(null, null, this.lastAdvanced.target);
          if (this.lastAdvanced.kind === 'value') return this.showValueTrace(null, null, this.lastAdvanced.direction, this.lastAdvanced.target);
          if (this.lastAdvanced.kind === 'correlation') { this.correlationTargets = [...this.lastAdvanced.targets]; this.updateCorrelationStatus(); return this.showCorrelation(); }
          if (this.lastAdvanced.kind === 'simulation') return this.simulateValue(null, null, this.lastAdvanced.target, this.lastAdvanced.value);
        }
        if (this.lastTarget) { this.adapter.invalidate(); return this.analyze(this.lastTarget); } return;
      case 'cancel': this.analysisController?.abort(); if (message.graphId === this.activeGraphId && this.activeGraphId) this.engine.cancel(this.activeGraphId); return;
      case 'selected': this.activeNode(message.graphId, message.nodeId); this.selectedNodeId = message.nodeId; return;
      case 'expand': {
        this.activeNode(message.graphId, message.nodeId); this.error = null;
        return this.engine.expand(message.graphId, message.nodeId, { direction: message.direction, levels: 1 });
      }
      case 'expandReferences': {
        this.activeNode(message.graphId, message.nodeId); this.error = null;
        return this.engine.expandReferences(message.graphId, message.nodeId, {});
      }
      case 'traceReferenceOwner': {
        this.activeNode(message.graphId, message.nodeId); this.error = null;
        const result = await this.engine.traceReferenceOwner(message.graphId, message.nodeId, message.index, { loadReferences: true });
        if (result.focusNodeId) {
          this.selectedNodeId = result.focusNodeId; this.sendState();
          this.panel?.webview.postMessage({ type: 'flow:focusNode', epoch: this.epoch, graphId: message.graphId, nodeId: result.focusNodeId });
        }
        return;
      }
      case 'openNode': return this.openLocation(this.activeNode(message.graphId, message.nodeId).node.location);
      case 'openReference': {
        const node = this.activeNode(message.graphId, message.nodeId).node;
        if (Number.isInteger(message.index) && message.index >= 0) return this.openLocation(node.references?.[message.index]?.location);
        return;
      }
      case 'copyNode': {
        const node = this.activeNode(message.graphId, message.nodeId).node;
        await vscode.env.clipboard.writeText(JSON.stringify(node, null, 2));
        return vscode.window.showInformationMessage('Code Flow Lens: node JSON copied.');
      }
      case 'export': return this.exportGraph();
      case 'shortcut': return this.configureShortcut();
      default: return;
    }
  }
  async exportGraph() {
    if (!this.activeGraphId && !this.extraGraph) return vscode.window.showInformationMessage('Code Flow Lens: open a graph first.');
    const graph = this.extraGraph || this.engine.snapshot(this.activeGraphId);
    const name = graph.target.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.flow.json';
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const destination = await vscode.window.showSaveDialog({ title: 'Export loaded Code Flow Lens graph', filters: { 'Flow JSON': ['json'] }, defaultUri: root ? vscode.Uri.joinPath(root, name) : undefined });
    if (!destination) return;
    await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(graph, null, 2), 'utf8'));
    vscode.window.showInformationMessage('Code Flow Lens: exported the loaded graph and limits. Code-flow/React exports include source code.');
  }
  async copyGraph() {
    if (!this.activeGraphId && !this.extraGraph) return vscode.window.showInformationMessage('Code Flow Lens: open a graph first.');
    await vscode.env.clipboard.writeText(JSON.stringify(this.extraGraph || this.engine.snapshot(this.activeGraphId), null, 2));
    vscode.window.showInformationMessage('Code Flow Lens: graph JSON copied.');
  }
  async configureShortcut() {
    try {
      await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', '@command:codeFlowLens.showSymbolFlow');
    } catch {
      await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
      await vscode.env.clipboard.writeText('@command:codeFlowLens.showSymbolFlow');
      vscode.window.showInformationMessage('Code Flow Lens: Keyboard Shortcuts opened. Search for "Code Flow Lens: Show Symbol Flow"; the command filter was copied to the clipboard.');
    }
  }
  async chooseWorkspaceRoot() {
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    if (!folders.length) fail('NO_WORKSPACE', 'Open a local filesystem workspace first.');
    if (folders.length === 1) return folders[0].uri.fsPath;
    const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    const picked = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), {
      title: 'Code Flow Lens: choose workspace folder',
      placeHolder: active ? `Current editor is in ${active.name}` : 'Choose which workspace the runtime observer should use.'
    });
    return picked?.folder.uri.fsPath || null;
  }
  async openRuntime() {
    if (this.disposed) return;
    if (!vscode.workspace.isTrusted) fail('UNTRUSTED_WORKSPACE','Trust the workspace before executing an application in a browser.');
    if (this.runtimePanel) { this.runtimePanel.reveal(vscode.ViewColumn.Active); return; }
    const workspace = await this.chooseWorkspaceRoot(); if (!workspace) return;
    if (this.disposed || this.runtimePanel) return;
    const { RuntimeManager } = require('./runtime/manager');
    const { runtimeHtml } = require('./runtime/view');
    const config = vscode.workspace.getConfiguration('codeFlowLens');
    const remoteOrigins = config.get('runtimeOrigins', []);
    const observer = new RuntimeManager({ enabled:true, chrome:config.get('runtimeChrome','')||undefined, remoteOrigins });
    const mediaUri=vscode.Uri.joinPath(this.context.extensionUri,'media');
    const panel=vscode.window.createWebviewPanel('codeFlowLens.runtime','Code Flow Lens: Runtime',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[mediaUri]});
    this.runtimePanel=panel;this.runtimeObserver=observer;let sessionId=null,snapshots=[],busy=false;
    panel.onDidDispose(()=>{if(this.runtimePanel===panel){this.runtimePanel=null;this.runtimeObserver=null;}observer.dispose().catch(error=>this.log(error.message));});
    panel.webview.onDidReceiveMessage(async message=>{
      if (message?.command === 'uiError') { this.log('Runtime webview error: ' + String(message.message || '').slice(0, 500) + (message.stack ? '\n' + String(message.stack).slice(0, 1500) : '')); return; }
      if (busy || !['start','snapshot','events','compare','screenshot','timeline','stop'].includes(message?.command)) return;
      busy=true;
      try {
        let result,image;
        if(message.command==='start'){
          if(!vscode.workspace.isTrusted)throw Error('Workspace trust was revoked.');
          const o=message.options||{};
          const args={projectId:'editor-runtime',url:String(o.url||''),allowedOrigins:remoteOrigins,headless:false,allowActions:false};
          for(const key of ['captureState','captureBodies','captureText','captureVisual'])args[key]=o[key]===true;
          result=await observer.start(args,workspace);sessionId=result.sessionId;snapshots=[];
        } else if(!sessionId)throw Error('Start observation first.');
        else if(message.command==='snapshot'){result=await observer.snapshot(sessionId);snapshots.push(result.snapshotId);snapshots=snapshots.slice(-2);}
        else if(message.command==='events')result=await observer.events(sessionId,0,100);
        else if(message.command==='compare'){if(snapshots.length!==2)throw Error('Take two snapshots first, one before and one after the action.');result=observer.compare(sessionId,snapshots[0],snapshots[1]);}
        else if(message.command==='screenshot'){result=await observer.screenshot(sessionId);image=result._imageBase64;delete result._imageBase64;}
        else if(message.command==='timeline'){
          const exported=await observer.export(sessionId,100),runtimeGraph=exported.graph;
          this.analysisController?.abort();if(this.activeGraphId){this.engine.cancel(this.activeGraphId);this.engine.pinned.delete(this.activeGraphId);}
          this.activeGraphId=null;this.extraGraph=runtimeGraph;this.sourceCards={};this.selectedNodeId=runtimeGraph.rootId;this.lastTarget=null;this.lastAdvanced=null;this.error=null;this.loading=null;this.epoch++;this.ensurePanel();if(this.panel)this.panel.title='Observed runtime';this.sendState();
          result={shown:true,note:'Timeline is frozen evidence. Arrows mean chronological order, NOT source-level causality.'};
        }else if(message.command==='stop'){result=await observer.stop(sessionId);sessionId=null;snapshots=[];}
        panel.webview.postMessage({type:'runtime:result',result,image,sessionId});
      }catch(error){panel.webview.postMessage({type:'runtime:result',error:error.message,sessionId});this.log('Runtime: '+error.message);}
      finally{busy=false;}
    });
    panel.webview.html=runtimeHtml({scriptUri:panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri,'runtime.js')).toString(),cspSource:panel.webview.cspSource});
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true; this.epoch++; this.analysisController?.abort(); clearTimeout(this.readyTimer); clearTimeout(this.updateTimer); clearTimeout(this.prewarmTimer);
    this.engine.dispose(); this.adapter.dispose?.(); await this.runtimeObserver?.dispose();this.runtimePanel?.dispose(); await this.closePreview(); this.panel?.dispose();
  }
}
function activate(context) {
  controller = new Controller(context);
  // Restored panels are adopted with a fresh HTML shell so an interface saved by
  // an older build never keeps running against the current media bundle.
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('codeFlowLens.graph', {
    deserializeWebviewPanel: panel => {
      if (controller && !controller.disposed && !controller.panel) controller.attachPanel(panel);
      else panel.dispose();
      return Promise.resolve();
    }
  }));
  const commands = {
    showSymbolFlow: () => controller.showSelection(),
    analyzeSmart: () => controller.analyzeSmart(),
    showClassDiagram: () => controller.showClassDiagram(),
    showCodeFlow: () => controller.showAdvanced('code'),
    showReactHierarchy: () => controller.showAdvanced('react'),
    previewReact: () => controller.previewReact(),
    diagnoseJava: () => controller.diagnoseJava(),
    exportGraph: () => controller.exportGraph(),
    copyGraphJson: () => controller.copyGraph(),
    configureShortcut: () => controller.configureShortcut(),
    openRuntime: () => controller.openRuntime(),
    showLogs: () => controller.output.show(true),
    diagnoseRelations: () => controller.diagnoseRelations(),
    traceValue: () => controller.showValueTrace(null,null,'both'),
    simulateValue: () => controller.simulateValue(),
    addCorrelationSymbol: () => controller.addCorrelationSymbol(),
    showCorrelation: () => controller.showCorrelation(),
    clearCorrelation: () => controller.clearCorrelation()
  };
  for (const [name, action] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand('codeFlowLens.' + name, () => Promise.resolve().then(action).catch(error => controller.handleError(error))));
  return { version: require('./package.json').version };
}
async function deactivate() { await controller?.dispose(); controller = undefined; }
module.exports = { activate, deactivate, Controller };
