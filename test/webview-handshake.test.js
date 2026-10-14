'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webviewHtml } = require('../lib/webview-html');
const { previewHtml } = require('../lib/preview-html');
const { runtimeHtml } = require('../runtime/view');

const root = path.join(__dirname, '..');
const graphSource = fs.readFileSync(path.join(root, 'media', 'graph.js'), 'utf8');
const html = webviewHtml({ scriptUri: 'graph.js', styleUri: 'graph.css', cspSource: 'vscode-resource:', initToken: 'test-token' });
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));

function makeElement(id) {
  const listeners = {};
  return {
    id, style: {}, checked: false, disabled: false, hidden: false, value: '', textContent: '', className: '', title: '',
    clientWidth: 800, clientHeight: 600,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(child) { return child; }, append() {}, replaceChildren() {},
    querySelector() { return null; }, closest() { return null; }, focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
    setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {},
    _listeners: listeners
  };
}

function runGraph(idSet) {
  const elements = new Map([...idSet].map(id => [id, makeElement(id)]));
  const posted = [];
  const sandbox = {
    document: {
      getElementById: id => elements.get(id) || null,
      createElement: tag => makeElement(tag),
      querySelector: () => null,
      addEventListener() {}
    },
    window: {
      innerWidth: 1200, innerHeight: 800,
      addEventListener() {},
      requestAnimationFrame: () => 0,
      cancelAnimationFrame() {}
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message), getState: () => null, setState: () => {} }),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(graphSource, sandbox, { timeout: 5000, filename: 'graph.js' });
  return { posted, elements };
}

test('current HTML shell: graph.js boots, sends ready, and reports no interface errors', () => {
  const { posted } = runGraph(htmlIds);
  assert.ok(posted.some(m => m.command === 'ready'), 'ready handshake must be sent');
  assert.ok(!posted.some(m => m.command === 'uiError'), 'a matching shell must not report uiError');
});

test('stale HTML from an older build: no crash, ready still sent, missing ids reported before ready', () => {
  // Reproduces the 0.13.0 production bug: an HTML shell restored by VS Code from a
  // previous build lacks buttons the current media/graph.js wires up (analyzeSmart).
  const staleIds = new Set(htmlIds);
  staleIds.delete('analyzeSmart');
  const { posted } = runGraph(staleIds);
  const readyIndex = posted.findIndex(m => m.command === 'ready');
  assert.ok(readyIndex >= 0, 'ready must still be sent so the host keeps the handshake');
  const errorIndex = posted.findIndex(m => m.command === 'uiError' && Array.isArray(m.missing));
  assert.ok(errorIndex >= 0, 'uiError with the missing id list must be sent');
  assert.ok(posted[errorIndex].missing.includes('analyzeSmart'));
  assert.match(posted[errorIndex].message, /analyzeSmart/);
  assert.ok(errorIndex < readyIndex, 'the host must see the interface error before ready to reload the shell');
});

test('every literal element id referenced by media/graph.js exists in the HTML shell', () => {
  const refs = [...graphSource.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
  assert.ok(refs.length > 20, 'expected the script to reference many element ids');
  for (const id of new Set(refs)) assert.ok(htmlIds.has(id), `id "${id}" is used by graph.js but missing from the HTML shell`);
});

test('preview script only references ids present in the preview shell', () => {
  const shell = previewHtml({ url: 'http://localhost:5173/', name: 'Demo', props: {}, scriptUri: 'preview.js', cspSource: 'csp', isolated: true });
  const ids = new Set([...shell.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const source = fs.readFileSync(path.join(root, 'media', 'preview.js'), 'utf8');
  for (const id of new Set([...source.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]))) assert.ok(ids.has(id), `id "${id}" missing from preview shell`);
});

test('runtime script only references ids present in the runtime shell', () => {
  const shell = runtimeHtml({ scriptUri: 'runtime.js', cspSource: 'csp' });
  const ids = new Set([...shell.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const source = fs.readFileSync(path.join(root, 'media', 'runtime.js'), 'utf8');
  for (const id of new Set([...source.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]))) assert.ok(ids.has(id), `id "${id}" missing from runtime shell`);
});

test('restored panels are reactivated: onWebviewPanel event and serializer are registered', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.activationEvents.includes('onWebviewPanel:codeFlowLens.graph'), 'activationEvents must include onWebviewPanel:codeFlowLens.graph');
  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.match(source, /registerWebviewPanelSerializer\('codeFlowLens\.graph'/, 'a webview serializer must be registered for codeFlowLens.graph');
  assert.match(source, /attachPanel\(panel\)/, 'the serializer must adopt the restored panel through attachPanel');
});
