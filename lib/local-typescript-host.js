'use strict';
/** Filesystem + real TypeScript Language Service. No editor or project JS is loaded.
 * The small document/URI facade adapts the shared provider adapter's data contract;
 * it is not the VS Code API or a mock language service. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const ts = require('../vendor/typescript');
const { inside, blockedFile } = require('./scope');
const { fail } = require('./util');
const VENDOR = path.resolve(__dirname, '../vendor');
const SOURCE = /\.(?:[cm]?[jt]sx?|java)$/i;
const TS_SOURCE = /\.[cm]?[jt]sx?$/i;
const CONFIG_FILE = /^(?:tsconfig|jsconfig)(?:\.[^/\\]+)?\.json$/i;
const FOCUSED_CONTEXT_LIMIT = 8;
const FOCUSED_FILE_LIMIT = 1800;
const SECRET = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|id_ecdsa)$|\.(?:pem|key|p12|pfx|p8|keystore)$/i;
const EXTRA_SKIP = new Set(['.codex', '.agents', '.idea', '.vscode', 'target', 'vendor', '__pycache__', '.venv', 'venv']);
class Position { constructor(line, character) { this.line = line; this.character = character; } }
const uri = file => ({ scheme: 'file', fsPath: path.resolve(file), toString() { return pathToFileURL(this.fsPath).href; } });
const Uri = { file: uri, parse: value => uri(fileURLToPath(value)) };
function language(file) { return /\.java$/i.test(file) ? 'java' : /\.tsx$/i.test(file) ? 'typescriptreact' : /\.jsx$/i.test(file) ? 'javascriptreact' : /\.[cm]?js$/i.test(file) ? 'javascript' : 'typescript'; }
class TypeScriptHost {
  constructor(root, { maxFiles = 10000, tsconfig = null, focusFile = null, lightweight = false } = {}) {
    this.root = fs.realpathSync(root); this.maxFiles = maxFiles; this.lightweight = !!lightweight; this.preferredConfig = tsconfig && path.resolve(this.root, tsconfig);
    this.initialFocus = focusFile && inside(this.root, path.resolve(focusFile)) ? path.resolve(focusFile) : null;
    this.documents = new Map(); this.services = new Map(); this.overlays = new Map(); this.focusedContexts = new Map(); this.entries = new Map(); this.registry = ts.createDocumentRegistry(true, this.root);
    this.generation = 0; this.signature = '';
    // The interactive relationship worker must become ready immediately. In
    // lightweight mode we only discover the selected package here; the old
    // implementation synchronously walked the entire monorepo before posting
    // `ready`, which made the first graph feel like an LSP startup.
    if (this.lightweight) this.bootstrapLightweight(); else this.refresh(true);
    const folder = { name: path.basename(this.root), uri: uri(this.root) };
    this.facade = { Position, Uri, workspace: { workspaceFolders: [folder],
      getWorkspaceFolder: u => inside(this.root, u.fsPath) ? folder : undefined,
      openTextDocument: async u => this.document(u.fsPath) },
      commands: { executeCommand: async (...args) => this.command(...args) } };
  }
  note(message) { if (!this.warnings.includes(message)) this.warnings.push(message); }
  lightweightPackageSources(root, focusFile) {
    root = path.resolve(root); focusFile = focusFile && path.resolve(focusFile);
    const limit = Math.min(Math.max(300, this.maxFiles), 2400);
    const out = [], seen = new Set();
    const add = file => { file = path.resolve(file); if (seen.has(file) || !SOURCE.test(file) || (!this.overlays.has(file) && !this.readable(file))) return; seen.add(file); out.push(file); };
    if (focusFile) add(focusFile);
    const walk = dir => {
      if (out.length >= limit) return;
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a,b) => {
        const af = focusFile && (path.join(dir,a.name) === focusFile || focusFile.startsWith(path.join(dir,a.name) + path.sep)) ? 0 : 1;
        const bf = focusFile && (path.join(dir,b.name) === focusFile || focusFile.startsWith(path.join(dir,b.name) + path.sep)) ? 0 : 1;
        return af - bf || a.name.localeCompare(b.name);
      });
      for (const ent of entries) {
        if (out.length >= limit) return;
        const full = path.join(dir, ent.name), rel = path.relative(this.root, full);
        if (blockedFile(rel) || EXTRA_SKIP.has(ent.name) || ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) walk(full); else if (ent.isFile() && SOURCE.test(full)) add(full);
      }
    };
    walk(root); return out;
  }
  bootstrapLightweight() {
    this.files = []; this.fileSet = new Set(); this.warnings = []; this.cut = false;
    this.entries = new Map(); this.configs = []; this.documents.clear();
    this.focusedContexts.clear(); this.signature = 'focus-first';
    const focus = this.initialFocus;
    if (focus && SOURCE.test(focus) && this.readable(focus)) {
      // Startup is intentionally O(1): only register the selected file. TS/JS
      // candidate discovery scans the nearest package once, on the first actual
      // query, while Java performs the same package-local discovery lazily.
      // This lets the worker announce ready without crawling the package.
      this.files = [focus]; this.fileSet = new Set([focus]);
    } else if (focus) {
      // Keep the editor buffer addressable even when it has just been created
      // and does not exist on disk yet. setOverlays() will provide the text.
      this.files = [focus]; this.fileSet = new Set([focus]);
    }
    this.generation++;
    return true;
  }
  refreshLightweight() {
    // Structural refreshes remain package-scoped. QuerySemanticEngine performs
    // its own focus-local candidate discovery, so a full workspace crawl is
    // never required on the UI-critical path.
    const focus = this.initialFocus || this.overlays.keys().next().value || null;
    if (focus) this.initialFocus = path.resolve(focus);
    return this.bootstrapLightweight();
  }
  readable(file, isDirectory = false) {
    try {
      const full = path.resolve(file), real = fs.realpathSync(full);
      if (inside(VENDOR, real)) return isDirectory || /^lib(?:\..+)?\.d\.ts$/.test(path.basename(real));
      if (!inside(this.root, full) || !inside(this.root, real)) return false;
      const rel = path.relative(this.root, real);
      if (SECRET.test(rel) || rel.split(path.sep).some(p => ['.git', '.hg', '.svn', '.codex', '.agents'].includes(p))) return false;
      if (!isDirectory && !SOURCE.test(real) && !/\.json$/i.test(real)) return false;
      const stat = fs.statSync(real); return isDirectory ? stat.isDirectory() : stat.isFile() && stat.size <= 2_000_000;
    } catch { return false; }
  }
  read(file) { file = path.resolve(file); const overlay = this.overlays.get(file); if (overlay) return overlay.text;
    if (!this.readable(file)) return undefined; try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } }
  setOverlays(items = []) {
    const next = new Map();
    for (const item of items) {
      try { const file = path.resolve(item.file); if (!inside(this.root, file) || blockedFile(path.relative(this.root, file)) || !TS_SOURCE.test(file) || !this.readable(file) && (fs.existsSync(file) || !this.readable(path.dirname(file), true))) continue; const text=String(item.text || ''); if(Buffer.byteLength(text,'utf8')>2_000_000)continue; next.set(file, { text, version: String(item.version ?? 0), dirty: !!item.dirty }); } catch {}
    }
    let changed = next.size !== this.overlays.size;
    if (!changed) for (const [file, value] of next) { const old = this.overlays.get(file); if (!old || old.version !== value.version || old.text !== value.text) { changed = true; break; } }
    this.overlays = next; if (changed) { this.generation++; this.documents.clear(); }
    return changed;
  }
  bump() { this.generation++; this.documents.clear(); }
  liveEntries(dir) {
    dir = path.resolve(dir);
    if (!inside(this.root, dir) || !this.readable(dir, true)) return { files: [], directories: [] };
    const visible = { files: [], directories: [] };
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, ent.name), rel = path.relative(this.root, full);
        if (blockedFile(rel) || EXTRA_SKIP.has(ent.name) || ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) visible.directories.push(ent.name);
        else if (ent.isFile()) visible.files.push(ent.name);
      }
    } catch {}
    return visible;
  }
  configHost(dynamic = false) {
    return {
      useCaseSensitiveFileNames: true,
      fileExists: f => this.readable(f),
      readFile: f => this.read(f),
      readDirectory: (dir, extensions, exclude, include, depth) => ts.matchFiles(path.resolve(dir), extensions, exclude, include, true, this.root, depth,
        d => dynamic ? this.liveEntries(d) : (this.entries.get(path.resolve(d)) || { files: [], directories: [] }), f => f)
    };
  }
  nearbyConfigs(file) {
    const out = [];
    let dir = path.dirname(path.resolve(file));
    while (inside(this.root, dir)) {
      try {
        const names = fs.readdirSync(dir, { withFileTypes: true })
          .filter(ent => ent.isFile() && CONFIG_FILE.test(ent.name))
          .map(ent => ent.name)
          .sort((a, b) => {
            const rank = n => n.toLowerCase() === 'tsconfig.json' ? 0 : n.toLowerCase() === 'jsconfig.json' ? 1 : 2;
            return rank(a) - rank(b) || a.localeCompare(b);
          });
        for (const name of names) out.push(path.join(dir, name));
      } catch {}
      if (dir === this.root) break;
      const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
    }
    return out;
  }
  nearestPackageRoot(file, configFile = null) {
    let dir = path.dirname(path.resolve(file));
    while (inside(this.root, dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      if (dir === this.root) break;
      const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
    }
    return configFile ? path.dirname(configFile) : path.dirname(path.resolve(file));
  }
  defaultOptions() {
    return { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, esModuleInterop: true, skipLibCheck: true };
  }
  safeOptions(options = {}) {
    const clean = { ...options, noEmit: true, skipLibCheck: true, disableSourceOfProjectReferenceRedirect: false };
    delete clean.plugins;
    return clean;
  }
  parseNearbyConfig(configFile, focusFile) {
    const host = this.configHost(true);
    const read = ts.readConfigFile(configFile, host.readFile);
    if (read.error) return null;
    const parsed = ts.parseJsonConfigFileContent(read.config, host, path.dirname(configFile), undefined, configFile);
    const allNames = parsed.fileNames.map(f => path.resolve(f)).filter(f => TS_SOURCE.test(f) && this.readable(f));
    const includesFocus = allNames.includes(path.resolve(focusFile));
    return { file: configFile, allNames, includesFocus, options: this.safeOptions(parsed.options), errors: parsed.errors || [] };
  }
  focusedSources(root, focusFile, preferred = []) {
    root = path.resolve(root); focusFile = path.resolve(focusFile);
    const limit = Math.min(FOCUSED_FILE_LIMIT, Math.max(200, this.maxFiles));
    const seen = new Set(), found = [];
    const add = file => { file = path.resolve(file); if (seen.has(file) || !TS_SOURCE.test(file) || (!this.overlays.has(file) && !this.readable(file))) return; seen.add(file); found.push(file); };
    add(focusFile);
    const focusDir = path.dirname(focusFile);
    const proximity = file => {
      const rel = path.relative(focusDir, file).split(path.sep).filter(Boolean);
      return rel.length * 100000 + path.relative(root, file).length;
    };
    for (const file of [...preferred].sort((a, b) => proximity(a) - proximity(b))) { if (found.length >= limit) break; add(file); }
    if (found.length < limit) {
      const walk = dir => {
        if (found.length >= limit) return;
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
        for (const ent of entries) {
          if (found.length >= limit) return;
          const full = path.join(dir, ent.name), rel = path.relative(this.root, full);
          if (blockedFile(rel) || EXTRA_SKIP.has(ent.name) || ent.isSymbolicLink()) continue;
          if (ent.isDirectory()) walk(full); else if (ent.isFile() && TS_SOURCE.test(full)) add(full);
        }
      };
      walk(root);
    }
    return found;
  }
  ensureFocusedContext(file) {
    file = path.resolve(file);
    if (!TS_SOURCE.test(file) || (!this.overlays.has(file) && !this.readable(file))) fail('SOURCE_UNAVAILABLE', 'Selected source is outside the workspace, excluded, missing, or larger than 2 MB.');
    const cached = this.focusedContexts.get(file);
    if (cached) {
      this.focusedContexts.delete(file); this.focusedContexts.set(file, cached);
      return cached;
    }
    let chosen = null, fallback = null;
    for (const configFile of this.nearbyConfigs(file)) {
      const parsed = this.parseNearbyConfig(configFile, file);
      if (!parsed) continue;
      if (!fallback) fallback = parsed;
      if (parsed.includesFocus) { chosen = parsed; break; }
    }
    const base = chosen || fallback;
    const packageRoot = this.nearestPackageRoot(file, base?.file || null);
    const preferred=chosen?.allNames || [];
    const names = this.focusedSources(packageRoot, file, preferred);
    if(preferred.length>names.length)this.note(`Focused semantic context for ${path.relative(this.root,file)} is capped at ${names.length} nearby files; references outside that focused package slice may be partial.`);
    const context = { file: base?.file || null, names, options: base?.options || this.defaultOptions(), focused: true, focusRoot: packageRoot, focusFile: file };
    this.configs.unshift(context); this.focusedContexts.set(file, context);
    this.fileSet.add(file); if (!this.files.includes(file)) this.files.push(file);
    this.note(`Focused semantic context activated for ${path.relative(this.root, file)}${base?.file ? ` using ${path.relative(this.root, base.file)}` : ' using an inferred project'}.`);
    while (this.focusedContexts.size > FOCUSED_CONTEXT_LIMIT) {
      const [oldFile, old] = this.focusedContexts.entries().next().value;
      this.focusedContexts.delete(oldFile); this.configs = this.configs.filter(c => c !== old);
      const service = this.services.get(old); if (service) { service.dispose(); this.services.delete(old); }
    }
    return context;
  }
  refresh(force = false) {
    if (this.lightweight) return this.refreshLightweight();
    const files = [], configs = [], metadata = [], entriesByDir = new Map(), warnings = [];
    let entries = 0, sourceBytes = 0, cut = false;
    const walk = dir => {
      let children; try {
        children = fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => {
          const rank = ent => {
            if (CONFIG_FILE.test(ent.name) || ent.name === 'package.json') return 0;
            if (this.initialFocus) { const full = path.join(dir, ent.name); if (full === this.initialFocus || this.initialFocus.startsWith(full + path.sep)) return 1; }
            return 2;
          };
          return rank(a) - rank(b) || a.name.localeCompare(b.name);
        });
      } catch { warnings.push('Unreadable directory: ' + path.relative(this.root, dir)); return; }
      const visible = { files: [], directories: [] }; entriesByDir.set(dir, visible);
      for (const ent of children) {
        if (++entries > 60000) { cut = true; return; }
        const file = path.join(dir, ent.name), rel = path.relative(this.root, file);
        if (blockedFile(rel) || EXTRA_SKIP.has(ent.name)) continue;
        if (ent.isSymbolicLink()) { warnings.push('Symlink omitted from root-file discovery: ' + rel); continue; }
        if (ent.isDirectory()) { visible.directories.push(ent.name); walk(file); if (cut) return; }
        else if (ent.isFile() && (SOURCE.test(file) || CONFIG_FILE.test(ent.name) || ent.name === 'package.json')) {
          const stat = fs.statSync(file); metadata.push([rel, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]); visible.files.push(ent.name);
          if (SOURCE.test(file)) {
            if (files.length >= this.maxFiles || sourceBytes + stat.size > 96_000_000 || stat.size > 2_000_000) { cut = true; continue; }
            files.push(file); sourceBytes += stat.size;
          } else if (CONFIG_FILE.test(ent.name)) configs.push(file);
        }
      }
    };
    walk(this.root);
    const signature = crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
    if (!force && this.signature === signature) return false;
    this.signature = signature; this.generation++; this.files = files; this.fileSet = new Set(files); this.warnings = warnings.slice(0, 30); this.cut = cut;
    this.documents.clear(); for (const ls of this.services.values()) ls.dispose(); this.services.clear(); this.focusedContexts.clear();
    this.entries = entriesByDir; this.configs = [];
    if (cut) this.note('Discovery stopped at a file/entry/byte budget. Results are partial; open a narrower package.');
    if (this.lightweight) return true;
    if (configs.length > 32) this.note('Only the first 32 tsconfig/jsconfig files are considered. Open a package or specify tsconfig for a large monorepo.');
    if (this.preferredConfig && !this.readable(this.preferredConfig)) fail('INVALID_CONFIG', 'tsconfig must be a readable JSON file inside the selected project.');
    const candidates = this.preferredConfig ? [this.preferredConfig] : configs.slice(0, 32);
    const configHost = this.configHost(false);
    for (const file of candidates) {
      const read = ts.readConfigFile(file, configHost.readFile);
      if (read.error) { this.note('Config error in '+path.relative(this.root,file)+': '+ts.flattenDiagnosticMessageText(read.error.messageText, ' ')); continue; }
      const parsed = ts.parseJsonConfigFileContent(read.config, configHost, path.dirname(file), undefined, file);
      for (const e of parsed.errors.slice(0, 5)) this.note(path.relative(this.root, file)+': '+ts.flattenDiagnosticMessageText(e.messageText, ' '));
      const names = parsed.fileNames.filter(f => this.fileSet.has(path.resolve(f)) && TS_SOURCE.test(f));
      if (!names.length) continue; // Solution configs are covered by their discovered child configs.
      const options = this.safeOptions(parsed.options); // Never load compiler/language plugins from the project.
      this.configs.push({ file, names, options });
    }
    const assigned = new Set(this.configs.flatMap(c => c.names));
    const inferred = files.filter(f => TS_SOURCE.test(f) && !assigned.has(f));
    if (inferred.length) this.configs.push({ file: null, names: inferred, options: this.defaultOptions() });
    if (inferred.length) this.note('Files outside a discovered config use an inferred TS/JS project; cross-file coverage may be partial.');
    if (this.configs.length > 16) { this.note('Initial semantic search keeps 16 compilation contexts; files you inspect are added on demand with a focused context.'); this.configs = this.configs.slice(0, 16); }
    return true;
  }
  document(file) {
    file = path.resolve(file);
    if (this.documents.has(file)) return this.documents.get(file);
    const text = this.read(file); if (text === undefined || !SOURCE.test(file)) fail('SOURCE_UNAVAILABLE', 'Source is outside the project, excluded, missing, or larger than 2 MB.');
    const lines = text.split(/\r?\n/), starts = [0]; for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);
    const positionAt = offset => { offset=Math.max(0,Math.min(text.length,offset)); let lo=0,hi=starts.length; while(lo+1<hi){const mid=(lo+hi)>>1;if(starts[mid]<=offset)lo=mid;else hi=mid;}return new Position(lo,offset-starts[lo]); };
    const offsetAt = pos => (starts[Math.max(0,Math.min(lines.length-1,pos.line))] || 0) + Math.min(lines[pos.line]?.length || 0, Math.max(0,pos.character));
    const overlay = this.overlays.get(file); const doc = { uri: uri(file), version: overlay ? Number(overlay.version) || this.generation : this.generation, isDirty: !!overlay?.dirty, languageId: language(file), lineCount: lines.length,
      lineAt: line => ({ text: lines[line] ?? '' }), positionAt, offsetAt, validatePosition: p => positionAt(offsetAt(p)),
      getText: range => range ? text.slice(offsetAt(range.start),offsetAt(range.end)) : text,
      getWordRangeAtPosition: pos => { for(const match of (lines[pos.line] || '').matchAll(/[$\p{ID_Start}][$\p{ID_Continue}]*/gu))
        if(pos.character>=match.index && pos.character<=match.index+match[0].length)return {start:new Position(pos.line,match.index),end:new Position(pos.line,match.index+match[0].length)}; } };
    this.documents.set(file,doc); return doc;
  }
  service(config) {
    if (this.services.has(config)) { const ls = this.services.get(config); this.services.delete(config); this.services.set(config, ls); return ls; }
    const host = { getScriptFileNames: () => config.names, getScriptVersion: () => String(this.generation),
      getScriptSnapshot: f => { const text = this.read(f); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
      getCurrentDirectory: () => this.root, getCompilationSettings: () => config.options,
      getDefaultLibFileName: opts => path.join(VENDOR, ts.getDefaultLibFileName(opts)),
      getDefaultLibLocation: () => VENDOR, fileExists: f => this.readable(f), readFile: f => this.read(f),
      directoryExists: d => this.readable(d,true), getDirectories: d => { if(!this.readable(d,true))return[];try{return fs.readdirSync(d,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);}catch{return[];} },
      realpath: f => { try { return fs.realpathSync(f); } catch { return f; } },
      useCaseSensitiveFileNames: () => true, getNewLine: () => '\n' };
    const service = ts.createLanguageService(host,this.registry); this.services.set(config, service);
    while(this.services.size>3){const oldest=this.services.keys().next().value;this.services.get(oldest).dispose();this.services.delete(oldest);}
    return service;
  }
  configFor(file) {
    if (!TS_SOURCE.test(file)) fail('UNSUPPORTED_HEADLESS_SEMANTICS', 'The embedded semantic engine supports TS/JS/JSX/TSX here; Java semantic navigation is handled by the local Java index.');
    file = path.resolve(file);
    const focused=this.focusedContexts.get(file);
    if(focused)return focused;
    let matches=this.configs.filter(c=>c.names.includes(file));matches.sort((a,b)=>(b.file?.length||0)-(a.file?.length||0));
    // A root scan can contain the selected file but still omit its nearby
    // consumers because the global file/byte budget was hit. Large compilation
    // contexts are also narrowed for interactive queries so the first request
    // does not spend its entire deadline constructing a huge Program.
    if (this.cut || !matches.length || matches[0].names.length > FOCUSED_FILE_LIMIT) return this.ensureFocusedContext(file);
    return matches[0];
  }
  prime(file) {
    file=path.resolve(file);
    const config=this.configFor(file), service=this.service(config), program=service.getProgram();
    if(!program?.getSourceFile(file)) fail('SOURCE_NOT_IN_PROGRAM','Selected file could not be loaded into the focused TypeScript program.');
    return { file, config:config.file?path.relative(this.root,config.file):null, files:config.names.length, focused:!!config.focused };
  }
  range(file, span) { const d=this.document(file);return {start:d.positionAt(span.start),end:d.positionAt(span.start+span.length)}; }
  location(info) { return { uri: uri(info.fileName), range: this.range(info.fileName, info.textSpan) }; }
  callItem(item) { return { name:item.name,kind:11,uri:uri(item.file),range:this.range(item.file,item.span),selectionRange:this.range(item.file,item.selectionSpan),detail:item.containerName,_ts:item }; }
  command(command, first, second) {
    if (command === 'vscode.executeWorkspaceSymbolProvider') {
      const found = new Map();
      for(const config of this.configs)for(const item of this.service(config).getNavigateToItems(first,201,undefined,true)){
        if(!inside(this.root,item.fileName)||blockedFile(path.relative(this.root,item.fileName)))continue;
        found.set(item.fileName+':'+item.textSpan.start,{name:item.name,kind:11,containerName:item.containerName,location:this.location(item)});
      }
      return [...found.values()];
    }
    const call = command === 'vscode.provideIncomingCalls' || command === 'vscode.provideOutgoingCalls';
    const file = call ? first._ts.file : first.fsPath;
    const config = this.configFor(file), service = this.service(config);
    if(command === 'vscode.executeDocumentSymbolProvider'){
      const convert=item=>({name:item.text,kind:11,detail:item.kind,range:this.range(file,item.spans[0]),selectionRange:this.range(file,item.nameSpan||item.spans[0]),children:(item.childItems||[]).map(convert)});
      return (service.getNavigationTree(file).childItems||[]).map(convert);
    }
    const offset = call ? first._ts.selectionSpan.start : this.document(file).offsetAt(second);
    // Scan compilation contexts which actually include the selected file. This
    // follows consumers in monorepos without merging conflicting compiler options.
    const aggregate = ['vscode.executeReferenceProvider','vscode.provideIncomingCalls'].includes(command);
    const contexts = aggregate ? [config,...this.configs.filter(c=>c!==config && c.names.includes(file))] : [config];
    const out=[];
    for(const cfg of contexts){
      const ls=this.service(cfg); if(!ls.getProgram()?.getSourceFile(file))continue;
      if(command==='vscode.executeDefinitionProvider')out.push(...(ls.getDefinitionAtPosition(file,offset)||[]).map(i=>this.location(i)));
      else if(command==='vscode.executeReferenceProvider')out.push(...(ls.getReferencesAtPosition(file,offset)||[]).map(i=>this.location(i)));
      else if(command==='vscode.executeImplementationProvider')out.push(...(ls.getImplementationAtPosition(file,offset)||[]).map(i=>this.location(i)));
      else if(command==='vscode.prepareCallHierarchy'){const items=ls.prepareCallHierarchy(file,offset);out.push(...(Array.isArray(items)?items:items?[items]:[]).map(i=>this.callItem(i)));}
      else if(command==='vscode.provideIncomingCalls')out.push(...ls.provideCallHierarchyIncomingCalls(file,offset).map(c=>({from:this.callItem(c.from),fromRanges:c.fromSpans.map(s=>this.range(c.from.file,s))})));
      else if(command==='vscode.provideOutgoingCalls')out.push(...ls.provideCallHierarchyOutgoingCalls(file,offset).map(c=>({to:this.callItem(c.to),fromRanges:c.fromSpans.map(s=>this.range(file,s))})));
      else fail('UNSUPPORTED_PROVIDER',command);
    }
    return out;
  }
  status() { return { root:this.root,version:require('../package.json').version,backend:'embedded-typescript',typescriptVersion:ts.version,
    source:'workspace-files+open-editor-overlays',generation:this.generation,discoveredSourceFiles:this.files.length,
    compilationContexts:this.configs.map(c=>({config:c.file?path.relative(this.root,c.file):null,files:c.names.length,inferred:!c.file})),
    completeRepositoryAnalysis:false,discoveryTruncated:this.cut,warnings:this.warnings,
    capabilities:{typescriptJavaScript:'definitions/references/calls/owners/local-CFG/local-data-flow/interprocedural-value-flow/correlation/static-simulation',react:'static JSX hierarchy + JSX value propagation + user-authorized preview/runtime tools',java:'local semantic index + JDK CFG/data-flow when available',vscodeRequired:false},
    limitations:['No project scripts, plugins, build tasks or dependency installation are executed.','Static value tracing is bounded and covers assignments, arguments, returns, destructuring, object properties and JSX props; it is not complete heap/alias/async analysis and simulation never executes workspace code.','Symlink discovery is skipped; external source/type symlinks are not read.','Dependency changes require refresh_project. Open editor buffers are overlaid into the embedded engine; files outside the workspace are not visible.','Other languages require an external provider; not silently replaced by text search.'] }; }
  dispose(){for(const ls of this.services.values())ls.dispose();this.services.clear();this.documents.clear();}
}
module.exports = { TypeScriptHost, Position, Uri };
