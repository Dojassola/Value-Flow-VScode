'use strict';
const assert = require('node:assert/strict');
const ts = require('../vendor/typescript');

const libraries = new Set(['redux', 'react-redux', '@reduxjs/toolkit', 'reduxsauce', 'reselect']);
const functions = new Set(['createStore', 'legacy_createStore', 'configureStore', 'combineReducers', 'createSlice', 'createReducer', 'createActions', 'createAction', 'useSelector', 'useDispatch', 'connect', 'createSelector']);
const fn = n => !!n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n));
const unwrap = n => { while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n))) n = n.expression; return n; };
const inside = (node, offset) => !!node && node.getStart() <= offset && offset < node.end;
const key = n => n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) ? n.text : null;
const field = (n, name) => n && ts.isObjectLiteralExpression(n) ? n.properties.find(p => key(p.name) === name) : undefined;
const value = p => p && (ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : fn(p) ? p : undefined);
const overlaps = (a, b) => a.slice(0, Math.min(a.length, b.length)).every((part, i) => part === b[i] || part === '*' || b[i] === '*');
function bindingPath(pattern, name, parts = []) {
  if (ts.isIdentifier(pattern)) return pattern.text === name ? parts : null;
  if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
    for (let i = 0; i < pattern.elements.length; i++) {
      const e = pattern.elements[i];
      if (!ts.isBindingElement(e)) continue;
      const part = ts.isArrayBindingPattern(pattern) ? String(i) : key(e.propertyName || e.name);
      if (part === null || e.dotDotDotToken) continue;
      const result = bindingPath(e.name, name, [...parts, part]);
      if (result) return result;
    }
  }
  return null;
}

class ReduxValueTrace {
  constructor(tracer, graph) { this.t = tracer; this.graph = graph; this.partial = false; this.entries = []; this.apis = new Map(); this.imports = new Map(); this.discoveryDeadline = graph.deadline - Math.floor(graph.timeBudgetMs / 3); }
  budget() { this.t.budget(this.graph); }
  facts(c) {
    if (c.reduxFacts) return c.reduxFacts;
    const calls = []; let count = 0;
    const visit = n => { if (!(count++ % 128)) this.budget(); if (ts.isCallExpression(n)) calls.push(n); ts.forEachChild(n, visit); };
    visit(c.sf); return c.reduxFacts = { calls };
  }
  imported(c, name, seen = new Set()) {
    const id = c.file + ':' + name;
    if (this.imports.has(id)) return this.imports.get(id);
    const info = this.t.instant.info(c.file), imp = info.imports.get(name);
    if (!imp || libraries.has(imp.spec)) return null;
    const file = this.t.instant.resolveModule(c.file, imp.spec);
    const result = file ? this.exported(this.t.source(file), imp.imported, seen) : null;
    this.imports.set(id, result); return result;
  }
  exported(c, name, seen) {
    const id = c.file + ':' + name;
    if (seen.has(id) || seen.size > 16) return null;
    seen.add(id); this.budget();
    for (const s of c.sf.statements) {
      if (name === 'default' && ts.isExportAssignment(s) && !s.isExportEquals) return { c, node: s.expression };
      if (s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (name === 'default' && s.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) return { c, node: s };
        if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (bindingPath(d.name, name)) return { c, node: d, binding: name };
        if (s.name?.text === name) return { c, node: s };
      }
      if (!ts.isExportDeclaration(s)) continue;
      const spec = s.moduleSpecifier?.text, elements = s.exportClause && ts.isNamedExports(s.exportClause) ? s.exportClause.elements : null;
      const e = elements?.find(e => e.name.text === name);
      if (elements && !e) continue;
      if (spec) {
        const file = this.t.instant.resolveModule(c.file, spec);
        const found = file && this.exported(this.t.source(file), e?.propertyName?.text || e?.name.text || name, seen);
        if (found) return found;
      } else if (e) return { c, node: e.propertyName || e.name };
    }
    return null;
  }
  resolve(c, node, seen = new Set()) {
    node = unwrap(node); if (!node) return null;
    this.budget(); const id = c.file + ':' + node.getStart(c.sf);
    if (seen.has(id) || seen.size > 20) return { c, node, access: [] };
    seen.add(id);
    if (ts.isIdentifier(node)) {
      const decl = this.t.lexicalDecl(c, node.text, node.getStart(c.sf));
      if (decl) return this.resolveDeclaration(c, decl, node.text, seen) || { c, node: decl, access: [] };
      const imported = this.imported(c, node.text);
      if (imported) return ts.isVariableDeclaration(imported.node) ? this.resolveDeclaration(imported.c, imported.node, imported.binding || node.text, seen) : this.resolve(imported.c, imported.node, seen);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const part = ts.isPropertyAccessExpression(node) ? node.name.text : key(node.argumentExpression);
      if (part !== null && ts.isIdentifier(node.expression) && !this.t.lexicalDecl(c, node.expression.text, node.expression.getStart(c.sf))) {
        const ns = this.t.instant.info(c.file).namespaceImports.get(node.expression.text), file = ns && !libraries.has(ns.spec) && this.t.instant.resolveModule(c.file, ns.spec);
        const exported = file && this.exported(this.t.source(file), part, new Set());
        if (exported) return ts.isVariableDeclaration(exported.node) ? this.resolveDeclaration(exported.c, exported.node, exported.binding || part, seen) : this.resolve(exported.c, exported.node, seen);
      }
      const base = this.resolve(c, node.expression, seen);
      if (!base || part === null) return { c, node, access: [] };
      const prop = ts.isObjectLiteralExpression(base.node) && field(base.node, part);
      if (prop) return this.resolve(base.c, value(prop), seen);
      return { ...base, access: [...(base.access || []), part] };
    }
    return { c, node, access: [] };
  }
  resolveDeclaration(c, decl, name, seen) {
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return fn(decl) ? { c, node: decl, access: [] } : null;
    const result = this.resolve(c, decl.initializer, seen), parts = bindingPath(decl.name, name) || [];
    if (!result) return null;
    return parts.length ? this.project(result, parts) : result;
  }
  project(context, parts) {
    let current = context;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], resolved = current.access?.length ? current : this.resolve(current.c, current.node);
      if (!resolved) return null;
      if (resolved.access?.length) return { ...resolved, access: [...resolved.access, ...parts.slice(i)], opaque: true };
      const prop = ts.isObjectLiteralExpression(resolved.node) && field(resolved.node, part);
      const element = ts.isArrayLiteralExpression(resolved.node) && resolved.node.elements[Number(part)];
      if (prop || element) current = { c: resolved.c, node: element || value(prop), access: [] };
      else return { ...resolved, access: [...(resolved.access || []), ...parts.slice(i)], opaque: true };
    }
    return this.resolve(current.c, current.node);
  }
  api(c, expression, seen = new Set()) {
    expression = unwrap(expression); if (!expression || seen.size > 12) return null;
    const id = c.file + ':' + expression.getStart(c.sf); if (seen.has(id)) return null;
    if (this.apis.has(id)) return this.apis.get(id);
    seen.add(id);
    const done = result => { this.apis.set(id, result); return result; };
    if (fn(expression) || ts.isObjectLiteralExpression(expression)) return done(null);
    if (ts.isIdentifier(expression) && !this.t.lexicalDecl(c, expression.text, expression.getStart(c.sf))) {
      const imp = this.t.instant.info(c.file).imports.get(expression.text);
      if (imp && libraries.has(imp.spec) && functions.has(imp.imported)) return done({ name: imp.imported, library: imp.spec });
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const ns = ts.isIdentifier(expression.expression) && this.t.instant.info(c.file).namespaceImports.get(expression.expression.text);
      if (ns && libraries.has(ns.spec) && functions.has(expression.name.text) && !this.t.lexicalDecl(c, expression.expression.text, expression.expression.getStart(c.sf))) return done({ name: expression.name.text, library: ns.spec });
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'withTypes') return done(this.api(c, expression.expression.expression, seen));
    const resolved = this.resolve(c, expression);
    return done(resolved && (resolved.c !== c || resolved.node !== expression) && !resolved.access?.length ? this.api(resolved.c, resolved.node, seen) : null);
  }
  literal(c, expression) {
    const r = this.resolve(c, expression);
    if (!r) return null;
    if (ts.isStringLiteralLike(r.node)) return r.node.text;
    this.literals ||= new Set();
    const id = r.c.file + ':' + r.node.getStart(r.c.sf) + ':' + r.access.join('.');
    if (this.literals.has(id) || this.literals.size > 16) { this.partial = true; return null; }
    this.literals.add(id);
    try { return this.action(r.c, r.node, r.access)?.type || null; }
    finally { this.literals.delete(id); }
  }
  action(c, expression, access) {
    const r = access ? { c, node: expression, access } : this.resolve(c, expression);
    if (!r) return null;
    if (ts.isObjectLiteralExpression(r.node)) { const type = value(field(r.node, 'type')); return type ? { type: this.literal(r.c, type), fields: null } : null; }
    if (fn(r.node)) {
      const returned = this.t.findReturns(r.node).find(n => ts.isObjectLiteralExpression(unwrap(n)));
      return returned ? this.action(r.c, unwrap(returned)) : null;
    }
    if (!ts.isCallExpression(r.node)) return null;
    const api = this.api(r.c, r.node.expression), parts = r.access || [];
    if (api?.name === 'createAction') return { type: this.literal(r.c, r.node.arguments[0]), fields: ['payload'] };
    if (api?.name === 'createSlice' && parts[0] === 'actions' && parts.length === 2) {
      const opts = unwrap(r.node.arguments[0]), name = this.literal(r.c, value(field(opts, 'name'))), reducer = value(field(unwrap(value(field(opts, 'reducers'))), parts[1]));
      const prepare = reducer && ts.isObjectLiteralExpression(reducer) && value(field(reducer, 'prepare'));
      return name !== null ? { type: name + '/' + parts[1], fields: ['payload'], prepare: prepare && { c: r.c, node: prepare } } : null;
    }
    if (api?.name === 'createActions' && parts.length === 2) {
      if (!['Types', 'Creators'].includes(parts[0])) return null;
      const opts = unwrap(r.node.arguments[1]), prefix = value(field(opts, 'prefix')), p = prefix ? this.literal(r.c, prefix) : '';
      if (p === null) return null;
      const screaming = name => name.replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
      const definitions = unwrap(r.node.arguments[0]);
      if (!definitions || !ts.isObjectLiteralExpression(definitions)) return null;
      const definition = parts[0] === 'Types' ? definitions.properties.find(p => key(p.name) !== null && screaming(key(p.name)) === parts[1]) : field(definitions, parts[1]);
      if (!definition) return null;
      const name = parts[1], type = parts[0] === 'Types' ? name : screaming(name);
      const args = value(definition);
      return { type: p + type, fields: args && ts.isArrayLiteralExpression(args) ? args.elements.map(e => key(e)) : null };
    }
    return null;
  }
  candidates(c, terms) {
    const result = this.t.instant.candidateFiles(terms[0], c.file, terms.slice(1));
    this.partial ||= result.truncated || result.indexing;
    const sources = [];
    for (const file of result.files) {
      try { sources.push(this.t.source(file)); }
      catch (error) { if (error.code !== 'VALUE_FILE_UNAVAILABLE') throw error; this.partial = true; }
    }
    return sources;
  }
  async load(c) {
    const packageRoot = this.t.host.nearestPackageRoot(c.file, null);
    if (this.loadedRoot === packageRoot) return;
    this.loadedRoot = packageRoot; this.entries = [];
    const sources = this.candidates(c, ['redux', 'reduxsauce', '@reduxjs/toolkit']);
    const stores = [], combines = [];
    for (const source of sources) {
      if (!/\b(createStore|legacy_createStore|configureStore|combineReducers)\b/.test(source.text)) continue;
      for (const call of this.facts(source).calls) {
        this.budget();
        const api = this.api(source, call.expression);
        if (['createStore', 'legacy_createStore', 'configureStore'].includes(api?.name)) stores.push({ c: source, node: call, api });
        if (api?.name === 'combineReducers') combines.push({ c: source, node: call, api });
      }
    }
    for (const store of stores.length ? stores : combines) {
      const opts = unwrap(store.node.arguments[0]), configure = store.api.name === 'configureStore';
      const reducer = configure ? value(field(opts, 'reducer')) : store.api.name === 'combineReducers' ? store.node : opts;
      const preloaded = configure ? value(field(opts, 'preloadedState')) : store.node.arguments[1];
      const loaded = preloaded && this.resolve(store.c, preloaded);
      store.preloaded = preloaded && (configure || loaded && (ts.isObjectLiteralExpression(loaded.node) || ts.isArrayLiteralExpression(loaded.node) || ts.isLiteralExpression(loaded.node))) ? { c: store.c, node: preloaded } : null;
      if (!stores.length) store.unverifiedStore = true;
      this.registration(store.c, reducer, [], store, new Set());
    }
  }
  registration(c, expression, parts, store, seen) {
    const r = this.resolve(c, expression); if (!r) return;
    const id = r.c.file + ':' + r.node.getStart(r.c.sf) + ':' + parts.join('.');
    if (seen.has(id) || seen.size > 80 || parts.length > 10) { this.partial = true; return; }
    const next = new Set(seen); next.add(id); this.budget();
    if (ts.isObjectLiteralExpression(r.node)) {
      for (const p of r.node.properties) { const name = key(p.name); if (name !== null && value(p)) this.registration(r.c, value(p), [...parts, name], store, next); else this.partial = true; }
      return;
    }
    if (ts.isCallExpression(r.node)) {
      const api = this.api(r.c, r.node.expression);
      if (api?.name === 'combineReducers') return this.registration(r.c, r.node.arguments[0], parts, store, next);
      if (api?.name === 'createSlice' && (!r.access?.length || r.access.join('.') === 'reducer')) {
        const opts = unwrap(r.node.arguments[0]), entry = { ...r, parts, store, kind: 'toolkit', handlers: [], initial: { c: r.c, node: value(field(opts, 'initialState')) } };
        const reducers = unwrap(value(field(opts, 'reducers'))), name = this.literal(r.c, value(field(opts, 'name')));
        if (reducers && ts.isObjectLiteralExpression(reducers)) for (const p of reducers.properties) {
          const handler = value(p), actionName = key(p.name);
          this.handler(entry, r.c, handler && ts.isObjectLiteralExpression(handler) ? value(field(handler, 'reducer')) : handler, name !== null && actionName !== null ? name + '/' + actionName : null);
        } else if (reducers) entry.unsupported = true;
        this.handlers(entry, r.c, value(field(opts, 'extraReducers'))); this.entries.push(entry); return;
      }
      if (api?.name === 'createReducer') {
        const entry = { ...r, parts, store, kind: api.library === 'reduxsauce' ? 'reduxsauce' : 'toolkit', initial: { c: r.c, node: r.node.arguments[0] }, handlers: [] };
        this.handlers(entry, r.c, r.node.arguments[1]); this.entries.push(entry); return;
      }
      const factory = this.resolve(r.c, r.node.expression);
      if (factory && fn(factory.node)) { for (const returned of this.t.findReturns(factory.node)) this.registration(factory.c, returned, parts, store, next); return; }
    }
    if (fn(r.node)) {
      const entry = { ...r, parts, store, kind: 'classic', initial: { c: r.c, node: r.node.parameters[0]?.initializer }, handlers: [] };
      const action = r.node.parameters[1];
      const visit = n => {
        this.budget(); if (n !== r.node && fn(n)) return;
        if (ts.isSwitchStatement(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'type' && action && ts.isIdentifier(n.expression.expression) && this.t.lexicalDecl(r.c, n.expression.expression.text, n.expression.expression.getStart(r.c.sf)) === action) {
          let pending = [];
          for (const clause of n.caseBlock.clauses) {
            if (ts.isCaseClause(clause)) pending.push(this.literal(r.c, clause.expression));
            if (clause.statements.length) { for (const type of pending.length ? pending : [null]) entry.handlers.push({ c: r.c, node: r.node, body: clause, type }); pending = []; }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(r.node); if (!entry.handlers.length) entry.unsupported = true;
      this.entries.push(entry); return;
    }
    this.entries.push({ ...r, parts, store, handlers: [], unsupported: true });
  }
  handler(entry, c, expression, type) {
    const r = this.resolve(c, expression);
    if (r && fn(r.node)) entry.handlers.push({ c: r.c, node: r.node, type });
    else entry.unsupported = true;
  }
  handlers(entry, c, expression) {
    const r = this.resolve(c, expression); if (!r) return;
    if (ts.isObjectLiteralExpression(r.node)) for (const p of r.node.properties) {
      if (!p.name) { entry.unsupported = true; continue; }
      const type = ts.isComputedPropertyName(p.name) ? this.literal(r.c, p.name.expression) : key(p.name);
      this.handler(entry, r.c, value(p), type);
    }
    else if (fn(r.node)) {
      const builder = r.node.parameters[0];
      for (const call of this.facts(r.c).calls.filter(call => inside(r.node, call.getStart(r.c.sf)))) {
        if (!ts.isPropertyAccessExpression(call.expression)) continue;
        let base = call.expression.expression;
        while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)) base = base.expression.expression;
        if (!builder || !ts.isIdentifier(base) || this.t.lexicalDecl(r.c, base.text, base.getStart(r.c.sf)) !== builder) continue;
        if (call.expression.name.text === 'addCase') this.handler(entry, r.c, call.arguments[1], this.literal(r.c, call.arguments[0]));
        else if (['addMatcher', 'addDefaultCase'].includes(call.expression.name.text)) entry.unsupported = true;
      }
    } else entry.unsupported = true;
  }
  statePath(c, expression, func, parameter = func.parameters[0], seen = new Set()) {
    expression = unwrap(expression); if (!expression || !parameter || seen.size > 12) return null;
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const base = this.statePath(c, expression.expression, func, parameter, seen);
      const part = ts.isPropertyAccessExpression(expression) ? expression.name.text : key(expression.argumentExpression) ?? '*';
      return base && [...base, part];
    }
    if (!ts.isIdentifier(expression)) return null;
    const decl = this.t.lexicalDecl(c, expression.text, expression.getStart(c.sf));
    if (decl === parameter) return bindingPath(parameter.name, expression.text);
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || seen.has(decl)) return null;
    seen.add(decl);
    const base = this.statePath(c, decl.initializer, func, parameter, seen);
    return base && [...base, ...(bindingPath(decl.name, expression.text) || [])];
  }
  reads(c, func, call) {
    const out = [];
    const visit = n => {
      this.budget(); if (n !== func && fn(n)) return;
      if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        if ((ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) && n.parent.expression === n) return;
        if (n.parent.name === n || ts.isParameter(n.parent)) return;
        const parts = this.statePath(c, n, func);
        if (parts) out.push({ c, node: n, parts, call, func });
      }
      ts.forEachChild(n, visit);
    };
    visit(func.body || func); return out;
  }
  consumers(sources) {
    const out = [];
    for (const c of sources) for (const call of this.facts(c).calls) {
      if (Date.now() >= this.discoveryDeadline) { this.partial = true; return out; }
      const api = this.api(c, call.expression);
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'getState') {
        const store = this.resolve(c, call.expression.expression);
        if (store && ts.isCallExpression(store.node) && ['configureStore', 'createStore', 'legacy_createStore'].includes(this.api(store.c, store.node.expression)?.name)) {
          const parts = []; let node = call;
          while ((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node) { node = node.parent; parts.push(ts.isPropertyAccessExpression(node) ? node.name.text : key(node.argumentExpression) ?? '*'); }
          if (parts.length) out.push({ c, node, parts, store, call: { c, node } });
        }
        continue;
      }
      if (!['useSelector', 'connect', 'createSelector'].includes(api?.name)) continue;
      const args = api.name === 'createSelector' ? call.arguments.slice(0, -1).flatMap(a => ts.isArrayLiteralExpression(a) ? [...a.elements] : [a]) : [call.arguments[0]];
      for (const arg of args) { const selector = this.resolve(c, arg); if (selector && fn(selector.node)) for (const read of this.reads(selector.c, selector.node, { c, node: call })) out.push(read); }
    }
    return out;
  }
  dispatches(sources) {
    const out = [];
    for (const c of sources) for (const call of this.facts(c).calls) {
      if (Date.now() >= this.discoveryDeadline) { this.partial = true; return out; }
      let dispatch = false;
      const callee = this.resolve(c, call.expression);
      if (callee && ts.isCallExpression(callee.node) && this.api(callee.c, callee.node.expression)?.name === 'useDispatch') dispatch = true;
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'dispatch') {
        const store = this.resolve(c, call.expression.expression);
        dispatch ||= !!store && ts.isCallExpression(store.node) && ['configureStore', 'createStore', 'legacy_createStore'].includes(this.api(store.c, store.node.expression)?.name);
      }
      if (!dispatch || !call.arguments[0]) continue;
      const expr = unwrap(call.arguments[0]), action = this.action(c, ts.isCallExpression(expr) ? expr.expression : expr);
      if (action?.type) out.push({ c, node: call, action, expression: expr });
    }
    return out;
  }
  initialPath(context, c, offset, parts = []) {
    const r = context?.node && this.resolve(context.c, context.node); if (!r) return null;
    if (r.c.file !== c.file || !inside(r.node, offset)) return null;
    if (ts.isObjectLiteralExpression(r.node)) for (const p of r.node.properties) if (inside(p, offset) && key(p.name) !== null) return this.initialPath({ c: r.c, node: value(p) }, c, offset, [...parts, key(p.name)]) || [...parts, key(p.name)];
    return parts;
  }
  writes(entry, handler, parts) {
    const out = [], state = handler.node.parameters[0];
    const visit = n => {
      this.budget(); if (n !== handler.node && fn(n)) return;
      if (entry.kind === 'toolkit' && ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const path = this.statePath(handler.c, n.left, handler.node);
        if (path && overlaps(path, parts)) out.push({ c: handler.c, node: n, expression: n.right, path: parts.slice(path.length), handler, possible: path.includes('*') });
      }
      if (entry.kind === 'toolkit' && (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) {
        const path = this.statePath(handler.c, n.operand, handler.node);
        if (path && overlaps(path, parts)) out.push({ c: handler.c, node: n, expression: n.operand, path: [], handler });
      }
      if (entry.kind === 'toolkit' && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'].includes(n.expression.name.text)) {
        const path = this.statePath(handler.c, n.expression.expression, handler.node);
        if (path && overlaps(path, parts)) out.push({ c: handler.c, node: n, expression: n, path: [], handler, possible: path.includes('*') });
      }
      if (entry.kind === 'toolkit' && ts.isDeleteExpression(n)) {
        const path = this.statePath(handler.c, n.expression, handler.node);
        if (path && overlaps(path, parts)) out.push({ c: handler.c, node: n, expression: n, path: [], handler });
      }
      if (ts.isReturnStatement(n) && n.expression) returned(n.expression);
      ts.forEachChild(n, visit);
    };
    const returned = expression => {
      const path = this.statePath(handler.c, expression, handler.node);
      if (path && !path.length) return;
      const r = this.resolve(handler.c, expression); if (!r) return;
      if (parts.length && ts.isObjectLiteralExpression(r.node)) {
        const p = field(r.node, parts[0]);
        if (p) { out.push({ c: r.c, node: value(p), expression: value(p), path: parts.slice(1), handler }); return; }
        for (const spread of r.node.properties.filter(ts.isSpreadAssignment)) {
          const existing = r.c === handler.c && this.statePath(handler.c, spread.expression, handler.node);
          if (!existing || existing.length) out.push({ c: r.c, node: spread, expression: spread.expression, path: parts, handler, possible: true });
        }
        return;
      }
      out.push({ c: handler.c, node: expression, expression, path: parts, handler, possible: parts.includes('*') });
    };
    if (state && handler.node.body && !ts.isBlock(handler.node.body) && !handler.body) returned(handler.node.body);
    else visit(handler.body || handler.node.body || handler.node);
    return out;
  }
  selectedPath(c, node, entry, reads, dispatches) {
    const offset = node.getStart(c.sf), decl = ts.isIdentifier(node) && this.t.lexicalDecl(c, node.text, offset);
    const inSelection = (source, expr) => source.file === c.file && (inside(expr, offset) || decl && ts.isVariableDeclaration(decl) && decl.initializer && inside(decl.initializer, expr.getStart(source.sf)));
    for (const read of reads) if (overlaps(entry.parts, read.parts) && entry.parts.every((p, i) => read.parts[i] === p)) {
      if (read.store && (read.store.c.file !== entry.store.c.file || read.store.node.getStart(read.store.c.sf) !== entry.store.node.getStart(entry.store.c.sf))) continue;
      if (inSelection(read.c, read.node) || inSelection(read.call.c, read.call.node)) {
        const selected = read.func && read.c.file === c.file && this.statePath(c, node, read.func);
        if (selected && !overlaps(selected, read.parts)) continue;
        return { parts: (selected || read.parts).slice(entry.parts.length), role: 'read', read };
      }
    }
    const initial = this.initialPath(entry.initial, c, offset);
    if (initial) return { parts: initial, role: 'initial' };
    const r = decl && this.resolve(c, node), init = entry.initial?.node && this.resolve(entry.initial.c, entry.initial.node);
    if (r && init && r.c === init.c && r.node === init.node) return { parts: [], role: 'initial' };
    for (const handler of entry.handlers) if (handler.c.file === c.file && inside(handler.body || handler.node, offset)) {
      const path = this.statePath(c, node, handler.node);
      if (path) return { parts: path, role: 'write', stateSelected: true };
      for (const write of this.writes(entry, handler, [])) if (inside(write.node, offset)) {
        const lhs = ts.isBinaryExpression(write.node) && this.statePath(c, write.node.left, handler.node);
        return { parts: lhs || [], role: 'write' };
      }
    }
    if (dispatches.some(d => inSelection(d.c, d.node) && entry.handlers.some(h => h.type === d.action.type))) return { parts: [], role: 'dispatch' };
    return null;
  }
  node(context, name, role, layer, metadata) {
    assert(metadata.statePath.every(part => typeof part === 'string') && context.node.getSourceFile() === context.c.sf, 'Redux evidence must retain its state path and original source.');
    const valueKind = ts.isIdentifier(context.node) ? 'symbol' : ts.isPropertyAccessExpression(context.node) ? 'property' : ts.SyntaxKind[context.node.kind];
    return this.t.add(this.graph, context.c, context.node, name, role, layer, { ...this.t.snippet(context.c, context.node, true), valueKind, redux: metadata });
  }
  async origins(context, node, parts, maxDepth) {
    if (!context?.node) return;
    await this.t.sourceExpr(this.graph, context.c, context.node, node, 1, maxDepth, new Set(), parts.map(key => ({ kind: 'property', key })), true);
  }
  async trace(c, token, root, direction, maxDepth) {
    const decl = ts.isIdentifier(token) && this.t.lexicalDecl(c, token.text, token.getStart(c.sf));
    const call = decl?.initializer && unwrap(decl.initializer);
    const hasHint = /['"](?:redux|react-redux|reduxsauce|@reduxjs\/toolkit|reselect)['"]|\b(useAppSelector|useSelector|useDispatch|createSlice|createReducer|combineReducers|getState)\b/.test(c.text);
    let selector = null;
    if (!hasHint) for (let parent = token.parent; parent && parent !== c.sf; parent = parent.parent) if (ts.isCallExpression(parent)) { selector = this.api(c, parent.expression); if (selector?.name === 'useSelector') break; }
    if (!hasHint && selector?.name !== 'useSelector' && !(call && ts.isCallExpression(call) && this.api(c, call.expression))) return false;
    const localReads = this.consumers([c]), localDispatches = this.dispatches([c]);
    const offset = token.getStart(c.sf), readsSelection = localReads.some(read => read.c.file === c.file && inside(read.node, offset) || read.call.c.file === c.file && (inside(read.call.node, offset) || decl?.initializer && inside(decl.initializer, read.call.node.getStart(c.sf))));
    await this.load(c);
    if (!this.entries.length) { if (readsSelection) this.graph.cutoffs.add('reduxDynamic'); return false; }
    const selectedEntries = this.entries.filter(e => this.selectedPath(c, token, e, localReads, localDispatches));
    const sources = this.candidates(c, ['useSelector', 'useAppSelector', 'useDispatch', 'dispatch', 'connect', 'createSelector', 'getState', ...selectedEntries.flatMap(e => e.parts.slice(0, 1))]);
    const reads = this.consumers(sources), dispatches = this.dispatches(sources);
    const matches = this.entries.map(entry => ({ entry, selected: this.selectedPath(c, token, entry, reads, dispatches) })).filter(x => x.selected);
    if (!matches.length) { if (readsSelection) this.graph.cutoffs.add('reduxDynamic'); return false; }
    if (this.partial) this.graph.cutoffs.add('reduxDiscovery');
    const origins = [], uses = [];
    for (const { entry, selected } of matches) {
      this.budget(); const parts = [...entry.parts, ...selected.parts], path = parts.join('.') || '(root)';
      const metadata = { statePath: parts, store: this.t.loc(entry.store.c.file, entry.store.node.getStart(entry.store.c.sf), entry.store.node.end), reducerKind: entry.kind || 'unknown', association: selected.role === 'read' ? 'matched state path' : 'registered reducer' };
      const ambiguous = selected.role === 'read' && matches.some(m => m.entry !== entry && m.entry.parts.join('.') === entry.parts.join('.') && m.entry.store !== entry.store);
      if (entry.unsupported || entry.store.unverifiedStore || selected.parts.includes('*') || ambiguous) this.graph.cutoffs.add('reduxDynamic');
      root.redux = { ...metadata, kind: selected.role };
      if (ambiguous) root.redux.storeCandidates = matches.filter(m => m.entry.parts.join('.') === entry.parts.join('.')).map(m => this.t.loc(m.entry.store.c.file, m.entry.store.node.getStart(m.entry.store.c.sf), m.entry.store.node.end));
      const state = selected.stateSelected ? root : this.node(entry, 'Redux state: ' + path + (ambiguous ? ' [' + metadata.store.file + ':' + metadata.store.line + ']' : ''), 'redux-state', selected.role === 'read' ? -1 : 1, { ...metadata, kind: 'state' });
      if (selected.role === 'read') this.t.edge(this.graph, state, root, 'redux_read', 'selector reads ' + path);
      else if (selected.role !== 'write') this.t.edge(this.graph, root, state, 'redux_write', selected.role === 'initial' ? 'initializes ' + path : 'can update ' + path);
      if (direction !== 'incoming') for (const read of reads.filter(r => overlaps(parts, r.parts) && entry.parts.every((p, i) => r.parts[i] === p) && (!r.store || r.store.c.file === entry.store.c.file && r.store.node.getStart(r.store.c.sf) === entry.store.node.getStart(entry.store.c.sf)))) {
        const selectedRead = selected.role === 'read' && selected.read === read;
        const n = selectedRead ? root : this.node(read, 'Read: ' + read.parts.join('.'), 'destination', 2, { ...metadata, kind: 'read' });
        this.t.edge(this.graph, state, n, 'redux_read', 'selector reads state');
        uses.push({ read, node: n });
      }
      if (direction !== 'outgoing' || selected.role === 'write' || selected.role === 'dispatch') {
        const initial = entry.initial?.node && this.project(entry.initial, selected.parts);
        if (direction !== 'outgoing' && initial && !initial.opaque) {
          const n = selected.role === 'initial' ? root : this.node(initial, 'Initial: ' + path, 'origin', -2, { ...metadata, kind: 'initial' });
          this.t.edge(this.graph, n, state, 'redux_initial', 'initial state'); origins.push({ context: initial, node: n, parts: [] });
        }
        const preload = entry.store.preloaded && this.project(entry.store.preloaded, parts);
        if (direction !== 'outgoing' && preload && !preload.opaque) { const n = this.node(preload, 'Preloaded: ' + path, 'origin', -2, { ...metadata, kind: 'preloaded' }); this.t.edge(this.graph, n, state, 'redux_initial', 'preloaded state'); origins.push({ context: preload, node: n, parts: [] }); }
        for (const handler of entry.handlers) for (const write of this.writes(entry, handler, selected.parts)) {
          const selectedWrite = selected.role === 'write' && write.c.file === c.file && inside(write.node, token.getStart(c.sf));
          if (direction === 'outgoing' && selected.role === 'write' && !selectedWrite) continue;
          if (direction === 'outgoing' && selected.role === 'dispatch' && !dispatches.some(d => d.c.file === c.file && inside(d.node, token.getStart(c.sf)) && d.action.type === handler.type)) continue;
          const n = this.node(write, 'Update: ' + path, 'transformation', -2, { ...metadata, kind: 'write', actionType: handler.type, possible: !!write.possible });
          if (selectedWrite) {
            const target = ts.isBinaryExpression(write.node) && inside(write.node.left, token.getStart(c.sf));
            this.t.edge(this.graph, target ? state : root, target ? root : n, target ? 'redux_read' : 'flows_to', target ? 'updated field' : 'write input');
          }
          this.t.edge(this.graph, n, state, 'redux_write', write.possible ? 'may replace/merge field' : 'updates ' + path);
          if (write.possible || !handler.type) this.graph.cutoffs.add('reduxDynamic');
          if (handler.type) {
            const action = this.node(handler, handler.type, 'redux-action', -3, { ...metadata, kind: 'action', actionType: handler.type });
            this.t.edge(this.graph, action, n, 'redux_action', 'handled action');
            for (const d of dispatches.filter(d => d.action.type === handler.type && (direction !== 'outgoing' || selected.role !== 'dispatch' || d.c.file === c.file && inside(d.node, token.getStart(c.sf))))) {
              const dispatch = selected.role === 'dispatch' && d.c.file === c.file && inside(d.node, token.getStart(c.sf)) ? root : this.node(d, 'dispatch ' + handler.type, 'redux-dispatch', -4, { ...metadata, kind: 'dispatch', actionType: handler.type });
              this.t.edge(this.graph, dispatch, action, 'redux_dispatch', 'dispatches action');
              const prepare = d.action.prepare && this.node(d.action.prepare, 'prepare ' + handler.type, 'transformation', -5, { ...metadata, kind: 'prepare', actionType: handler.type });
              if (prepare) { this.t.edge(this.graph, prepare, dispatch, 'redux_prepare', 'prepared action'); this.graph.cutoffs.add('reduxDynamic'); }
              if (ts.isCallExpression(d.expression)) for (let i = 0; i < d.expression.arguments.length; i++) {
                const input = { c: d.c, node: d.expression.arguments[i] }, name = d.action.fields?.[i] || 'argument #' + (i + 1);
                const payload = this.node(input, 'Action input: ' + name, 'argument', -5, { ...metadata, kind: 'payload', actionType: handler.type, actionField: name });
                this.t.edge(this.graph, payload, prepare || dispatch, 'redux_payload', prepare ? 'prepare input' : name); origins.push({ context: input, node: payload, parts: [] });
              }
              else if (ts.isObjectLiteralExpression(d.expression)) for (const p of d.expression.properties) if (key(p.name) !== 'type' && value(p)) {
                const input = { c: d.c, node: value(p) }, payload = this.node(input, 'Action input: ' + key(p.name), 'argument', -5, { ...metadata, kind: 'payload', actionType: handler.type, actionField: key(p.name) });
                this.t.edge(this.graph, payload, dispatch, 'redux_payload', key(p.name)); origins.push({ context: input, node: payload, parts: [] });
              }
            }
          }
          if (direction !== 'outgoing') origins.push({ context: { c: write.c, node: write.expression }, node: n, parts: write.path });
        }
      }
    }
    for (const item of origins) await this.origins(item.context, item.node, item.parts, maxDepth);
    for (const item of uses) await this.t.propagateExpressionUse(this.graph, item.read.call.c, item.read.call.node, item.node, 1, maxDepth, new Set());
    return true;
  }
}

module.exports = { ReduxValueTrace };
