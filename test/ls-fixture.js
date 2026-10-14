'use strict';
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL,fileURLToPath}=require('node:url');
const ts=require('../vendor/typescript');
function fixture(root, files) {
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
  const Uri = { file: uri, parse: value => uri(fileURLToPath(value)) };
  const snapshots = new Map(), versions = new Map();
  for (const [file, text] of Object.entries(files)) { const full = path.join(root, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); versions.set(full, 1); }
  function document(file) {
    const text = fs.readFileSync(file, 'utf8'), lines = text.split(/\r?\n/);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return { uri: uri(file), version: versions.get(file) || 1, isDirty: false, languageId: file.endsWith('.tsx') ? 'typescriptreact' : 'typescript', lineCount: lines.length,
      lineAt: line => ({ text: lines[line] }),
      getWordRangeAtPosition: pos => { const line = lines[pos.line]; const matches = line.matchAll(/[$\w]+/g); for (const match of matches) if (pos.character >= match.index && pos.character <= match.index + match[0].length) return { start: new Position(pos.line, match.index), end: new Position(pos.line, match.index + match[0].length) }; },
      getText: range => range ? lines[range.start.line].slice(range.start.character, range.end.character) : text,
      offsetAt: pos => ts.getPositionOfLineAndCharacter(source, pos.line, pos.character),
      positionAt: offset => { const point = ts.getLineAndCharacterOfPosition(source, offset); return new Position(point.line, point.character); }, validatePosition: pos => pos };
  }
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve, strict: true, skipLibCheck: true };
  const host = { getScriptFileNames: () => Object.keys(files).map(file => path.join(root, file)), getScriptVersion: file => String(versions.get(file) || 0),
    getScriptSnapshot: file => { if (!fs.existsSync(file)) return undefined; const snapshot = ts.ScriptSnapshot.fromString(fs.readFileSync(file, 'utf8')); snapshots.set(file, snapshot); return snapshot; },
    getCurrentDirectory: () => root, getCompilationSettings: () => options, getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories };
  const service = ts.createLanguageService(host);
  const range = (file, span) => ({ start: document(file).positionAt(span.start), end: document(file).positionAt(span.start + span.length) });
  const location = info => ({ uri: uri(info.fileName), range: range(info.fileName, info.textSpan) });
  const callItem = item => ({ name: item.name, kind: 11, uri: uri(item.file), range: range(item.file, item.span), selectionRange: range(item.file, item.selectionSpan), detail: item.containerName, _ts: item });
  const vscode = { Position, Uri,
    workspace: { workspaceFolders: [{ name: 'fixture', uri: uri(root) }], getWorkspaceFolder: u => u.fsPath.startsWith(root + path.sep) ? { name: 'fixture', uri: uri(root) } : undefined,
      openTextDocument: async u => document(u.fsPath) },
    commands: { executeCommand: async (command, first, second) => {
      if (command === 'vscode.provideIncomingCalls' || command === 'vscode.provideOutgoingCalls') {
        const item = first._ts;
        if (command === 'vscode.provideIncomingCalls') return service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start).map(call => ({ from: callItem(call.from), fromRanges: call.fromSpans.map(span => range(call.from.file, span)) }));
        return service.provideCallHierarchyOutgoingCalls(item.file, item.selectionSpan.start).map(call => ({ to: callItem(call.to), fromRanges: call.fromSpans.map(span => range(item.file, span)) }));
      }
      if (command === 'vscode.executeWorkspaceSymbolProvider') return service.getNavigateToItems(first).map(item => ({ name: item.name, kind: 11, containerName: item.containerName, location: location({ fileName: item.fileName, textSpan: item.textSpan }) }));
      if (command === 'vscode.executeDocumentSymbolProvider') {
        const file = first.fsPath, tree = service.getNavigationTree(file);
        const convert = item => ({ name: item.text, kind: 11, detail: item.kind, range: range(file, item.spans[0]),
          selectionRange: range(file, item.nameSpan || item.spans[0]), children: (item.childItems || []).map(convert) });
        return (tree.childItems || []).map(convert);
      }
      const file = first.fsPath, offset = second ? document(file).offsetAt(second) : 0;
      if (command === 'vscode.executeDefinitionProvider') return (service.getDefinitionAtPosition(file, offset) || []).map(location);
      if (command === 'vscode.executeReferenceProvider') return (service.getReferencesAtPosition(file, offset) || []).map(location);
      if (command === 'vscode.executeImplementationProvider') return (service.getImplementationAtPosition(file, offset) || []).map(location);
      if (command === 'vscode.prepareCallHierarchy') { const found = service.prepareCallHierarchy(file, offset); return (Array.isArray(found) ? found : found ? [found] : []).map(callItem); }
      return [];
    } }
  };
  return { vscode, service, document, update(file, text) { const full = path.join(root, file); fs.writeFileSync(full, text); versions.set(full, (versions.get(full) || 0) + 1); } };
}


module.exports = { fixture };
