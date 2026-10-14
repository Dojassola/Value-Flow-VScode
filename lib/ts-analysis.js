'use strict';
// Pinned TypeScript parser/type binder. This module never evaluates workspace code.
const ts = require('../vendor/typescript');
function parseTS(text, file = 'source.tsx', offset = 0) {
  const kind = /\.tsx$|\.jsx$/i.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const host = { getSourceFile: name => name === file ? sf : undefined, getDefaultLibFileName: () => '', writeFile() {},
    getCurrentDirectory: () => '', getDirectories: () => [], fileExists: name => name === file, readFile: name => name === file ? text : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n' };
  const program = ts.createProgram([file], { noResolve: true, noLib: true, allowJs: true, checkJs: true, jsx: ts.JsxEmit.Preserve }, host);
  const checker = program.getTypeChecker();
  const span = n => ({ start: n.getStart(sf), end: n.end });
  const code = n => n ? n.getText(sf) : '';
  const warnings = sf.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  function binding(n) {
    if (!n) return null;
    if (ts.isParenthesizedExpression(n)) return binding(n.expression);
    if (ts.isPropertyAccessExpression(n)) {
      const sym = checker.getSymbolAtLocation(n.name), decl = sym?.valueDeclaration || sym?.declarations?.[0];
      return { id: decl ? 'decl:' + decl.getStart(sf) : (binding(n.expression)?.id || 'external:' + code(n.expression)) + '.' + n.name.text, name: code(n), ...span(n) };
    }
    if (ts.isElementAccessExpression(n)) return { id: (binding(n.expression)?.id || 'external:' + code(n.expression)) + '[]', name: code(n.expression) + '[*]', ...span(n), uncertain: true };
    if (!ts.isIdentifier(n)) return null;
    const sym = checker.getSymbolAtLocation(n), decl = sym?.valueDeclaration || sym?.declarations?.[0];
    return { id: decl ? 'decl:' + decl.getStart(sf) : 'external:' + n.text, name: n.text, ...span(n) };
  }
  function effects(node) {
    const reads = [], writes = [], calls = []; let conditionalDepth = 0;
    const add = (list, n) => { const b = binding(n); if (b && !list.some(x => x.id === b.id && x.start === b.start)) list.push(list === writes && conditionalDepth ? {...b,maybe:true} : b); };
    function pattern(n) {
      if (!n) return;
      if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) { add(writes, n); if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) visit(n.expression); return; }
      if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) { for (const e of n.elements) if (ts.isBindingElement(e)) { pattern(e.name); if (e.initializer) visit(e.initializer); } }
    }
    function visit(n) {
      if (!n) return;
      if (ts.isTypeNode(n)) return;
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) { if (n.name) add(writes, n.name); return; }
      if (ts.isConditionalExpression(n)) { visit(n.condition); conditionalDepth++; visit(n.whenTrue); visit(n.whenFalse); conditionalDepth--; return; }
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) { visit(n.left); conditionalDepth++; visit(n.right); conditionalDepth--; return; }
      if (ts.isVariableDeclaration(n)) { visit(n.initializer); pattern(n.name); return; }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        if (n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) visit(n.left);
        visit(n.right); pattern(n.left); return;
      }
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) { visit(n.operand); pattern(n.operand); return; }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        calls.push({ name: code(n.expression), ...span(n.expression) });
        if (ts.isPropertyAccessExpression(n.expression)) visit(n.expression.expression);
        for (const arg of n.arguments || []) visit(arg);
        if (n.parent && !(ts.isExpressionStatement(n.parent))) reads.push({ id: 'call-result:' + n.getStart(sf), name: code(n.expression) + '() result', ...span(n.expression), boundary: 'opaque-call-result' });
        return;
      }
      if (ts.isPropertyAccessExpression(n)) { add(reads, n); visit(n.expression); return; }
      if (ts.isElementAccessExpression(n)) { add(reads, n); visit(n.expression); visit(n.argumentExpression); return; }
      if (ts.isPropertyAssignment(n)) { visit(n.initializer); return; }
      if (ts.isShorthandPropertyAssignment(n)) { add(reads, n.name); return; }
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) { for (const a of n.attributes.properties) { if (ts.isJsxSpreadAttribute(a)) visit(a.expression); else if (a.initializer && ts.isJsxExpression(a.initializer)) visit(a.initializer.expression); } return; }
      if (ts.isJsxClosingElement(n)) return;
      if (ts.isIdentifier(n)) { add(reads, n); return; }
      ts.forEachChild(n, visit);
    }
    visit(node); return { reads, writes, calls };
  }
  function atom(n, label) { const e=effects(n); const name=label || (e.writes.length ? (ts.isVariableStatement(n)?'declare ':'assign ')+[...new Set(e.writes.map(w=>w.name))].join(', ') : e.calls.length ? 'call '+e.calls[0].name : 'statement'); return { ...span(n), code: code(n), name, ...e }; }
  function statement(n) {
    if (!n) return { kind: 'block', statements: [] };
    if (ts.isBlock(n) || ts.isSourceFile(n)) return { kind: 'block', statements: n.statements.map(statement) };
    if (ts.isIfStatement(n)) return { kind: 'if', atom: atom(n.expression, 'if'), then: statement(n.thenStatement), else: statement(n.elseStatement) };
    if (ts.isWhileStatement(n) || ts.isDoStatement(n)) return { kind: ts.isDoStatement(n) ? 'do' : 'loop', atom: atom(n.expression, 'condition'), body: statement(n.statement) };
    if (ts.isForStatement(n)) return { kind: 'loop', init: n.initializer ? { kind: 'simple', atom: atom(n.initializer, 'init') } : null,
      atom: n.condition ? atom(n.condition, 'for condition') : { ...span(n), code: 'true /* for (;;) */', reads: [], writes: [], calls: [], always: true },
      update: n.incrementor ? { kind: 'simple', atom: atom(n.incrementor, 'update') } : null, body: statement(n.statement) };
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) { const e = atom(n.expression, 'iterate'); e.writes = effects(n.initializer).writes;
      return { kind: 'loop', atom: e, body: statement(n.statement), iteration: true }; }
    if (ts.isSwitchStatement(n)) return { kind: 'switch', atom: atom(n.expression, 'switch'), cases: n.caseBlock.clauses.map(c => ({ label: c.expression ? 'case ' + code(c.expression) : 'default', body: { kind: 'block', statements: c.statements.map(statement) }, fallthrough: true })) };
    if (ts.isReturnStatement(n)) return { kind: 'return', atom: atom(n, 'return') };
    if (ts.isThrowStatement(n)) return { kind: 'throw', atom: atom(n, 'throw') };
    if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) {
      if (n.label) { warnings.push('Labeled break/continue is an opaque control boundary.'); return { kind: 'opaque', atom: atom(n, 'labeled jump') }; }
      return { kind: ts.isBreakStatement(n) ? 'break' : 'continue', atom: atom(n, ts.isBreakStatement(n) ? 'break' : 'continue') };
    }
    if (ts.isTryStatement(n) || ts.isWithStatement(n) || ts.isLabeledStatement(n)) { warnings.push('try/finally, with or labeled control is summarized, not path-expanded.'); return { kind: 'opaque', atom: atom(n, 'opaque control boundary') }; }
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) return { kind: 'simple', atom: atom(n, 'declaration (body not executed here)') };
    return { kind: 'simple', atom: atom(n) };
  }
  let selected = sf;
  function select(n) { if (n.getStart(sf) <= offset && offset <= n.end) { if (ts.isFunctionLike(n) && n.body) selected = n; ts.forEachChild(n, select); } }
  select(sf);
  const selectedBody = selected === sf ? sf : selected.body;
  const params = selected.parameters ? selected.parameters.flatMap(p => {
    const e = effects(ts.factory.createVariableDeclaration(p.name, undefined, undefined, undefined));
    return e.writes;
  }) : [];
  // Factory nodes above preserve parameter name nodes with their real bound symbol.
  const entryEnd = selectedBody && ts.isBlock(selectedBody) ? selectedBody.getStart(sf) + 1 : selected.getStart(sf);
  const entry = { start: selected.getStart(sf), end: Math.max(selected.getStart(sf), entryEnd),
    code: selected === sf ? '// module scope' : text.slice(selected.getStart(sf), entryEnd) || code(selected.name) || 'function',
    name: selected.name ? code(selected.name) : selected.parent && ts.isVariableDeclaration(selected.parent) ? code(selected.parent.name) : 'function', reads: [], writes: params, calls: [] };
  const body = selected === sf || ts.isBlock(selectedBody) ? statement(selectedBody) : { kind: 'return', atom: atom(selectedBody, 'implicit return') };
  const components = [];
  const candidates = [];
  function gather(n) {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text)) candidates.push(n);
    ts.forEachChild(n, gather);
  }
  gather(sf);
  for (const candidate of candidates) {
    const children = [], props = []; const candidateSet = new Set(candidates.filter(n => n !== candidate));
    function jsx(n) {
      if (candidateSet.has(n)) return;
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const attrs = n.attributes.properties.map(p => ({ name: p.name ? code(p.name) : '...', expression: p.initializer ? code(p.initializer) : p.expression ? code(p.expression) : 'true' }));
        const tag = code(n.tagName);
        if (/^[A-Z]/.test(tag)) children.push({ name: tag, ...span(n.tagName), code: code(n), props: attrs });
        props.push(...attrs);
      }
      ts.forEachChild(n, jsx);
    }
    jsx(candidate);
    let hasJSX = false;
    function containsJSX(n) { if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) hasJSX = true; if (!candidateSet.has(n)) ts.forEachChild(n, containsJSX); }
    containsJSX(candidate);
    if (!hasJSX) continue;
    const name = candidate.name.text; let exported = [];
    const decl = ts.isVariableDeclaration(candidate) ? candidate.parent.parent : candidate;
    if (decl.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exported.push(decl.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : name);
    for (const s of sf.statements) {
      if (ts.isExportAssignment(s) && s.expression && code(s.expression) === name) exported.push('default');
      if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) if (code(e.propertyName || e.name) === name) exported.push(e.name.text);
    }
    components.push({ name, ...span(candidate), selection: span(candidate.name), children, exports: [...new Set(exported)], code: code(candidate) });
  }
  return { language: 'typescript', parser: 'TypeScript 5.8.3 AST + local binder', entry, body, components, warnings, start: selected.getStart(sf), end: selected.end };
}
module.exports = { parseTS };
