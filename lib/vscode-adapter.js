'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { QueryCache } = require('./query-cache');
const { WorkspaceScope } = require('./scope');
const { fail, checkAbort, locKey, bounded, abortable } = require('./util');

async function mapLimited(items, concurrency, worker) {
  const result = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) { const i = index++; result[i] = await worker(items[i], i); }
  }));
  return result;
}
function classifyUsage(line, start, end) {
  const before = line.slice(0, start), after = line.slice(end);
  if (/<\/?\s*$/.test(before)) return 'jsx';
  if (/^\s*import\b/.test(line) || /^\s*export\s*(?:type\s*)?[{*]/.test(line)) return 'import/export';
  if (/^\s*(?:\?\.)?\s*\(/.test(after)) return 'call';
  if (/^\s*(?:\+\+|--|(?:\*\*|>>>|>>|<<|&&|\|\||\?\?|[+\-*/%&|^])?=(?!=|>))/.test(after) || /(?:\+\+|--)\s*$/.test(before)) return 'write';
  if (/\b(const|let|var)\s*$/.test(before)) return 'declaration';
  return 'read';
}
class VSCodeAdapter {
  constructor(vscode, { log = () => {}, timeoutMs = 8000 } = {}) {
    this.vscode = vscode; this.log = log;
    this.scope = new WorkspaceScope((vscode.workspace.workspaceFolders || [])
      .filter(folder => folder.uri.scheme === 'file').map(folder => ({ name: folder.name, path: folder.uri.fsPath, uri: folder.uri.toString() })));
    this.cache = new QueryCache({ log, timeoutMs });
    this.emptyRetryUntil = 0;
  }
  invalidate() { this.cache.invalidate(); this.scope.invalidate(); }
  workspaces() { return this.scope.roots.map(({ name, path: file, uri }) => ({ name, file, uri })); }
  async ensureLanguage(target, signal) {
    if (['typescript','typescriptreact','javascript','javascriptreact'].includes(target.languageId) && this.vscode.extensions) {
      const ext = this.vscode.extensions.getExtension('vscode.typescript-language-features');
      if (!ext) return ['JS/TS language provider not detected. Enable the built-in TypeScript and JavaScript Language Features extension, then Refresh.'];
      const wasActive = ext.isActive;
      let timer;
      try {
        await abortable(Promise.race([ext.activate(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('JS/TS provider activation timed out; wait for indexing, then Refresh.')), 8000);
        })]), signal);
        if (!wasActive) this.emptyRetryUntil = Date.now() + 5000;
        return [];
      } catch (e) { checkAbort(signal); return ['JS/TS provider: ' + e.message]; }
      finally { clearTimeout(timer); }
    }
    if (target.languageId !== 'java' || !this.vscode.extensions) return [];
    const ext = this.vscode.extensions.getExtension('redhat.java');
    if (!ext) return ['Java: no redhat.java extension detected. Install Language Support for Java and import the project for semantic references/calls. Local Code flow uses a JDK independently.'];
    let timer;
    try {
      const api = await abortable(Promise.race([ext.activate(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Java extension activation timeout')), 12000); })]), signal);
      clearTimeout(timer);
      if (api?.serverMode === 'LightWeight') return ['Java is in LightWeight mode. Switch java.server.launchMode to Standard, wait for project import, then Refresh.'];
      if (typeof api?.serverReady === 'function') {
        const ready = await abortable(Promise.race([api.serverReady(), new Promise(resolve => { timer = setTimeout(() => resolve(false), 12000); })]), signal);
        if (!ready) return ['Java standard server is not ready yet. Wait for project import/build and Refresh. The root and partial results are kept.'];
      }
      return [];
    } catch (e) { checkAbort(signal); return ['Java language service: ' + e.message]; }
    finally { clearTimeout(timer); }
  }
  async sourceCard(location, maxLines = 12, signal) {
    const doc = await this.document(this.vscode.Uri.parse(location.uri), signal);
    const start = Math.max(1, location.fullRange?.line || location.line);
    const stop = Math.min(doc.lineCount, start + maxLines - 1, location.fullRange?.endLine || doc.lineCount);
    const lines = []; for (let line = start; line <= stop; line++) lines.push({ line, text: doc.lineAt(line - 1).text.slice(0, 1000) });
    return { lines, documentVersion: doc.version, untrustedSourceText: true, dirty: doc.isDirty };
  }
  async document(uri, signal) {
    if (uri.scheme === 'file') await this.scope.assert(uri.fsPath);
    else { const open=(this.vscode.workspace.textDocuments||[]).find(d=>d.uri.toString()===uri.toString()); if(!open) fail('DOCUMENT_NOT_OPEN','Virtual/non-file documents are supported only while they are open in the editor. Save the file for cross-file relationship analysis.'); }
    checkAbort(signal); return this.cache.run('document|' + uri.toString(), () => this.vscode.workspace.openTextDocument(uri), signal);
  }
  async query(command, args, key, signal) {
    checkAbort(signal);
    const started = Date.now(), cacheKey = command + '|' + key;
    const run = () => this.cache.run(cacheKey, () => this.vscode.commands.executeCommand(command, ...args), signal);
    try {
      let result = await run();
      // Retry only first-hop discovery during initial JS/TS activation. Empty
      // outgoing leaf queries do not add a delay to every expanded graph node.
      const discovery = ['vscode.executeDefinitionProvider','vscode.executeReferenceProvider','vscode.prepareCallHierarchy'].includes(command);
      if (discovery && Date.now() < this.emptyRetryUntil) {
        for (const ms of [250, 750]) {
          if (result != null && !(Array.isArray(result) && result.length === 0)) break;
          let timer;
          try { await abortable(new Promise(resolve => { timer=setTimeout(resolve,ms); }), signal); }
          finally { clearTimeout(timer); }
          result = await run();
        }
      }
      this.log(command + ': ' + (Array.isArray(result) ? result.length : result == null ? 0 : 1) + ' result(s), ' + (Date.now()-started) + ' ms');
      return result;
    } catch (error) {
      this.log(command + ': ' + (error.code || 'ERROR') + ' - ' + error.message);
      throw error;
    }
  }
  position(target) { return new this.vscode.Position(target.location.line - 1, target.location.column - 1); }
  uri(target) { return this.vscode.Uri.parse(target.location.uri); }
  location(uri, range) {
    const root = this.scope.roots.find(folder => this.vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri);
    return {
      uri: uri.toString(), file: root ? path.relative(root.path, uri.fsPath).replace(/\\/g, '/') : (uri.scheme === 'file' ? uri.fsPath : uri.toString()),
      workspace: root?.name,
      line: range.start.line + 1, column: range.start.character + 1,
      endLine: range.end.line + 1, endColumn: range.end.character + 1
    };
  }
  async target(spec, signal) {
    if (!spec || typeof spec !== 'object') fail('INVALID_ARGUMENT', 'A target is required. Use find_symbols or provide file, line and column (1-based).');
    checkAbort(signal);
    if (!spec.file || spec.line === undefined) {
      if (typeof spec.symbol !== 'string' || !spec.symbol.trim()) fail('INVALID_ARGUMENT', 'Provide file + line + column, or symbol (optionally file/workspace).');
      const found = await this.findSymbols({ query: spec.symbol, file: spec.file, workspace: spec.workspace, limit: 200 }, signal);
      const exact = found.symbols.filter(item => item.name === spec.symbol);
      if (exact.length !== 1 || found.truncated) {
        fail(exact.length ? 'AMBIGUOUS_SYMBOL' : 'SYMBOL_NOT_FOUND', exact.length ? 'The symbol is not unique. Select a candidate using file, line and column.' : 'No unique symbol found. Open its file and use a precise line/column.', { candidates: exact.slice(0, 30), truncated: found.truncated });
      }
      return this.target({ file: exact[0].location.uri, line: exact[0].location.line, column: exact[0].location.column }, signal);
    }
    let file = spec.file, uri, doc;
    if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[A-Za-z]:[\\/]/.test(file)) {
      try { uri = this.vscode.Uri.parse(file); } catch { fail('INVALID_ARGUMENT', 'Invalid document URI.'); }
      if (uri.scheme === 'file') file = fileURLToPath(file);
      else {
        doc = await this.document(uri, signal);
        const line = bounded(spec.line, 1, 1, doc.lineCount), text = doc.lineAt(line - 1).text;
        const column = bounded(spec.column, 1, 1, text.length + 1), pos = new this.vscode.Position(line - 1, column - 1), range = doc.getWordRangeAtPosition(pos);
        if (!range) fail('NO_SYMBOL', 'The position is not on a symbol. Place the cursor on a variable, function, method or component name.');
        return { name: doc.getText(range), location: this.location(uri, range), languageId: doc.languageId, documentVersion: doc.version, dirty: doc.isDirty, ephemeral: true };
      }
    }
    file = this.scope.resolve(file, spec.workspace);
    uri = this.vscode.Uri.file(file); doc = await this.document(uri, signal);
    const line = bounded(spec.line, 1, 1, doc.lineCount);
    const text = doc.lineAt(line - 1).text;
    const column = bounded(spec.column, 1, 1, text.length + 1);
    const pos = new this.vscode.Position(line - 1, column - 1);
    const range = doc.getWordRangeAtPosition(pos);
    if (!range) fail('NO_SYMBOL', 'The position is not on a symbol. Place the cursor on a variable, function, method or component name.');
    const name = doc.getText(range);
    if (spec.symbol && name !== spec.symbol) fail('TARGET_MOVED', 'The saved position no longer points to ' + spec.symbol + '. Re-select that symbol in the editor and open a new flow graph.');
    return { name, location: this.location(uri, range), languageId: doc.languageId, documentVersion: doc.version, dirty: doc.isDirty };
  }
  async normalizeLocations(raw, signal) {
    const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
    let excluded = 0;
    const all = await mapLimited(entries, 8, async entry => {
      checkAbort(signal);
      const uri = entry?.uri || entry?.targetUri;
      const range = entry?.targetSelectionRange || entry?.range || entry?.targetRange;
      if (!uri || !range || uri.scheme !== 'file' || !(await this.scope.allowed(uri.fsPath))) { excluded++; return null; }
      return this.location(uri, range);
    });
    const unique = new Map(); for (const location of all) if (location) unique.set(locKey(location), location);
    return { items: [...unique.values()], excluded };
  }
  async locations(command, target, signal) {
    const raw = await this.query(command, [this.uri(target), this.position(target)], locKey(target.location), signal);
    const result = await this.normalizeLocations(raw, signal);
    if (command !== 'vscode.executeReferenceProvider') {
      for (const loc of result.items) {
        if (loc.line === loc.endLine && loc.endColumn - loc.column <= target.name.length + 1) continue;
        try {
          const uri = this.vscode.Uri.parse(loc.uri);
          const symbols = await this.query('vscode.executeDocumentSymbolProvider', [uri], uri.toString(), signal);
          const candidates = [];
          const walk = list => { for (const item of list || []) {
            if (item.selectionRange && item.range && String(item.name).split('(')[0].trim().split('.').pop() === target.name) {
              const full = this.location(uri, item.range), selected = this.location(uri, item.selectionRange);
              if ((selected.line > loc.line || selected.line === loc.line && selected.column >= loc.column) && (selected.line < loc.endLine || selected.line === loc.endLine && selected.column <= loc.endColumn)) candidates.push({ ...selected, fullRange: full });
            } if (item.children) walk(item.children);
          } }; walk(symbols);
          if (candidates.length === 1) Object.assign(loc, candidates[0]);
        } catch (e) { checkAbort(signal); this.log('Symbol range normalization: ' + e.message); }
      }
    }
    return result;
  }
  definitions(target, signal) { return this.locations('vscode.executeDefinitionProvider', target, signal); }
  async implementations(target, signal) {
    const result = await this.locations('vscode.executeImplementationProvider', target, signal);
    // Some TS providers report import aliases as implementations. Canonicalize
    // only such import/export sites, not distinct real overrides in one file.
    const canonical = await mapLimited(result.items, 4, async loc => {
      if (!/\.[cm]?[jt]sx?$/i.test(loc.file)) return loc;
      try {
        const doc = await this.document(this.vscode.Uri.parse(loc.uri), signal);
        if (!/^\s*(import\b|export\s*[{*])/.test(doc.lineAt(loc.line - 1).text)) return loc;
        const defs = await this.definitions({name:target.name, location:loc},signal);
        return defs.items.length === 1 ? defs.items[0] : loc;
      } catch (e) { checkAbort(signal); return loc; }
    });
    return {...result, items:[...new Map(canonical.map(loc=>[locKey(loc),loc])).values()]};
  }
  references(target, signal) { return this.locations('vscode.executeReferenceProvider', target, signal); }
  async enrichReferences(items, signal) {
    const groups = new Map();
    for (const item of items) { if (!groups.has(item.uri)) groups.set(item.uri, []); groups.get(item.uri).push(item); }
    const out = await mapLimited([...groups], 4, async ([uri, locations]) => {
      try {
        const doc = await this.document(this.vscode.Uri.parse(uri), signal);
        return locations.map(location => {
          const line = doc.lineAt(location.line - 1).text;
          return { location, usageKind: classifyUsage(line, location.column - 1, location.endLine === location.line ? location.endColumn - 1 : location.column), classificationSource: 'line-heuristic' };
        });
      } catch (error) {
        checkAbort(signal);
        return locations.map(location => ({ location, usageKind: 'unknown', classificationSource: 'unavailable', warning: error.code || 'READ_ERROR' }));
      }
    });
    return out.flat();
  }
  async callItem(item) {
    if (!item?.uri || !item.range || item.uri.scheme !== 'file' || !(await this.scope.allowed(item.uri.fsPath))) return null;
    const location = this.location(item.uri, item.selectionRange || item.range); location.fullRange = this.location(item.uri, item.range);
    return { key: locKey(location), name: item.name, kind: item.kind, detail: item.detail || '', location, opaque: item };
  }
  async prepare(target, signal) {
    const raw = await this.query('vscode.prepareCallHierarchy', [this.uri(target), this.position(target)], locKey(target.location), signal);
    const items = await mapLimited(raw || [], 4, item => this.callItem(item));
    return { items: items.filter(Boolean), excluded: items.filter(item => !item).length };
  }
  async calls(item, direction, signal) {
    const command = direction === 'incoming' ? 'vscode.provideIncomingCalls' : 'vscode.provideOutgoingCalls';
    const raw = await this.query(command, [item.opaque], item.key, signal);
    let excluded = 0;
    const items = await mapLimited(raw || [], 6, async call => {
      checkAbort(signal);
      const neighbor = await this.callItem(direction === 'incoming' ? call.from : call.to);
      if (!neighbor) { excluded++; return null; }
      const callerUri = direction === 'incoming' ? call.from.uri : item.opaque.uri;
      const ranges = call.fromRanges || [];
      return { item: neighbor, sites: ranges.slice(0, 10).map(range => this.location(callerUri, range)), totalSites: ranges.length };
    });
    return { items: items.filter(Boolean), excluded };
  }

  async containingSymbols(location, signal) {
    const uri = this.vscode.Uri.parse(location.uri);
    const doc = await this.document(uri, signal);
    const point = new this.vscode.Position(location.line - 1, location.column - 1);
    const raw = await this.query('vscode.executeDocumentSymbolProvider', [uri], uri.toString(), signal);
    const candidates = [];
    const contains = range => !!range && (typeof range.contains === 'function' ? range.contains(point) :
      (point.line > range.start.line || (point.line === range.start.line && point.character >= range.start.character)) &&
      (point.line < range.end.line || (point.line === range.end.line && point.character <= range.end.character)));
    const score = range => range ? (range.end.line - range.start.line) * 1000000 + Math.max(0, range.end.character - range.start.character) : Number.MAX_SAFE_INTEGER;
    const walk = (items, depth = 0, parent = '') => {
      for (const item of items || []) {
        checkAbort(signal);
        // Modern providers normally return DocumentSymbol objects with a full
        // lexical range. SymbolInformation only has a selection location, so it
        // is useful only when that range actually contains the reference.
        const fullRange = item.range || item.location?.range;
        const selectionRange = item.selectionRange || item.location?.range || item.range;
        const itemUri = item.location?.uri || uri;
        if (itemUri?.toString?.() !== uri.toString() || !contains(fullRange)) continue;
        const selected = this.location(uri, selectionRange);
        candidates.push({ name: item.name, kind: item.kind, detail: item.detail || '', containerName: parent,
          location: selected, depth, spanScore: score(fullRange), source: 'document-symbol-provider' });
        if (item.children?.length) walk(item.children, depth + 1, item.name);
      }
    };
    walk(raw);
    const unique = [...new Map(candidates.map(item => [locKey(item.location), item])).values()]
      .filter(item => locKey(item.location) !== locKey(location))
      .sort((a, b) => b.depth - a.depth || a.spanScore - b.spanScore || a.name.localeCompare(b.name));
    return { items: unique.slice(0, 8).map(({ spanScore, ...item }) => item), total: unique.length,
      truncated: unique.length > 8, provider: 'vscode.executeDocumentSymbolProvider', documentVersion: doc.version };
  }
  async findSymbols(args, signal) {
    const query = args.query;
    if (typeof query !== 'string' || !query.trim() || query.length > 256) fail('INVALID_ARGUMENT', 'query must contain 1 to 256 characters.');
    const limit = bounded(args.limit, 30, 1, 200);
    let raw;
    if (args.file) {
      let file = args.file.startsWith('file:') ? fileURLToPath(args.file) : this.scope.resolve(args.file, args.workspace);
      const uri = this.vscode.Uri.file(file); await this.document(uri, signal);
      raw = await this.query('vscode.executeDocumentSymbolProvider', [uri], uri.toString(), signal);
      const flat = [];
      const walk = (symbols, container = '') => {
        for (const item of symbols || []) {
          flat.push({ name: item.name, kind: item.kind, containerName: container, location: item.location || { uri, range: item.selectionRange || item.range } });
          if (item.children) walk(item.children, item.name);
        }
      };
      walk(raw); raw = flat;
    } else raw = await this.query('vscode.executeWorkspaceSymbolProvider', [query], query, signal);
    const candidates = (raw || []).filter(item => item?.name?.toLowerCase().includes(query.toLowerCase()));
    let excluded = 0;
    const results = await mapLimited(candidates, 8, async item => {
      checkAbort(signal);
      const loc = item.location;
      if (!loc?.uri || !loc.range || loc.uri.scheme !== 'file' || !(await this.scope.allowed(loc.uri.fsPath))) { excluded++; return null; }
      return { name: item.name, kind: item.kind, containerName: item.containerName || '', location: this.location(loc.uri, loc.range) };
    });
    const unique = [...new Map(results.filter(Boolean).map(item => [locKey(item.location), item])).values()];
    unique.sort((a, b) => (b.name === query) - (a.name === query) || a.name.localeCompare(b.name) || a.location.uri.localeCompare(b.location.uri));
    return { symbols: unique.slice(0, limit), totalReturnedByProvider: unique.length, truncated: unique.length > limit, excluded, positionEncoding: '1-based lines and UTF-16 columns' };
  }
  async snippet(location, contextLines = 2, signal) {
    const doc = await this.document(this.vscode.Uri.parse(location.uri), signal);
    const radius = bounded(contextLines, 2, 0, 10);
    const from = Math.max(1, location.line - radius), to = Math.min(doc.lineCount, location.line + radius);
    const lines = [];
    for (let i = from; i <= to; i++) lines.push({ line: i, text: doc.lineAt(i - 1).text.slice(0, 1000) });
    return { file: location.file, startLine: from, endLine: to, lines, documentVersion: doc.version, dirty: doc.isDirty, untrustedSourceText: true };
  }
}
module.exports = { VSCodeAdapter, classifyUsage, mapLimited };
