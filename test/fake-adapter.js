'use strict';
const { locKey, abortable } = require('../lib/util');
function location(name, line = 1, column = 1) { return { uri: `file:///workspace/${name}.ts`, file: `${name}.ts`, workspace: 'demo', line, column, endLine: line, endColumn: column + name.length }; }
class FakeAdapter {
  constructor() {
    this.links = { A: ['B'], B: ['C'], C: ['A'], Page: ['A'], Toolbar: ['A'] };
    this.requests = []; this.delay = 0; this.noHierarchy = false; this.failReferences = false;
  }
  workspaces() { return [{ name: 'demo', uri: 'file:///workspace', file: '/workspace' }]; }
  invalidate() { this.requests.push('invalidate'); }
  async target(spec) { const name = spec.symbol || spec.file.split('/').pop().split('.')[0]; return { name, location: location(name), languageId: 'typescript', documentVersion: 1, dirty: false }; }
  item(name) { const loc = location(name); return { key: locKey(loc), name, location: loc, kind: 11, detail: '', opaque: { name } }; }
  async definitions(t) { this.requests.push('definitions:' + t.name); return { items: [t.location], excluded: 0 }; }
  async implementations() { return { items: [], excluded: 0 }; }
  async references(t) { if (this.failReferences) throw new Error('Reference provider unavailable'); return { items: [t.location, location('Page', 8), location('Toolbar', 6)], excluded: 0 }; }
  async enrichReferences(items) { return items.map(loc => ({ location: loc, usageKind: 'call', classificationSource: 'line-heuristic' })); }
  async containingSymbols(loc) { this.requests.push('owners:' + loc.file + ':' + loc.line); return { items: [
    { name: 'OptionsObject', kind: 13, detail: '', location: location('OptionsObject', 3), depth: 2, source: 'document-symbol-provider' },
    { name: 'OwnerFunction', kind: 11, detail: '', location: location('OwnerFunction', 1), depth: 1, source: 'document-symbol-provider' }
  ], total: 2, truncated: false, provider: 'fake' }; }
  async prepare(t) { this.requests.push('prepare:' + t.name); return { items: this.noHierarchy ? [] : [this.item(t.name)], excluded: 0 }; }
  async calls(item, direction, signal) {
    this.requests.push(direction + ':' + item.name);
    if (this.delay) await abortable(new Promise(resolve => setTimeout(resolve, this.delay)), signal);
    const names = direction === 'outgoing' ? this.links[item.name] || [] : Object.keys(this.links).filter(key => this.links[key].includes(item.name));
    return { items: names.map(name => ({ item: this.item(name), sites: [location(direction === 'incoming' ? name : item.name, 8)], totalSites: 1 })), excluded: 0 };
  }
  async findSymbols({ query }) { return { symbols: Object.keys(this.links).filter(name => name.includes(query)).map(name => ({ name, location: location(name) })), truncated: false }; }
  async snippet(loc) { return { lines: [{ line: loc.line, text: 'demo source only' }], untrustedSourceText: true }; }
}
module.exports = { FakeAdapter, location };
