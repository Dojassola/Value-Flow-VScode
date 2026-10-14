'use strict';
const { fileURLToPath } = require('node:url');
const { TypeScriptHost } = require('../lib/local-typescript-host');
const { HybridAdapter } = require('../lib/hybrid-adapter');
const { CodeExplorer } = require('../lib/code-explorer');
const { ClassDiagramEngine } = require('../lib/class-diagram');
const { checkAbort, fail } = require('../lib/util');

class Analysis {
  constructor(root) {
    this.host = new TypeScriptHost(root, { lightweight:true });
    this.adapter = new HybridAdapter(this.host.facade, { mode:'local' });
    this.explorer = new CodeExplorer(this.adapter);
    this.classes = new ClassDiagramEngine(this.adapter);
    this.tail = Promise.resolve(); this.pending = 0; this.disposed = false; this.version = 0;
  }
  async context(positions, signal) {
    checkAbort(signal);
    const overlays = [], specs = [];
    for (const position of positions) {
      const file = position.file.startsWith('file:') ? fileURLToPath(position.file) : this.adapter.scope.resolve(position.file);
      await this.adapter.scope.assert(file);
      if (position.sourceText !== undefined) {
        if (Buffer.byteLength(position.sourceText, 'utf8') > 2_000_000) fail('SOURCE_TOO_LARGE', 'Source text is limited to 2 MB.');
        const previous=overlays.find(item=>item.file===file);
        if(previous&&previous.text!==position.sourceText)fail('INVALID_ARGUMENT','Conflicting source buffers for the same file.');
        if(!previous)overlays.push({file,text:position.sourceText,version:++this.version,dirty:true});
      }
      specs.push({file,line:position.line,column:position.column});
    }
    this.host.bump(); this.host.setOverlays(overlays);
    this.host.facade.workspace.textDocuments = overlays.map(item => this.host.document(item.file));
    this.adapter.invalidate(); this.explorer.invalidate();
    checkAbort(signal);
    return specs;
  }
  run(operation, args, signal) {
    if (this.disposed) return Promise.reject(new Error('The analysis service was closed.'));
    if (this.pending >= 4) return Promise.reject(new Error('The analysis queue is full. Retry after a current request finishes.'));
    this.pending++;
    const result = this.tail.catch(() => {}).then(async () => {
      checkAbort(signal); if (this.disposed) fail('CANCELLED', 'The analysis service was closed.');
      const specs = await this.context(operation === 'correlate_symbols' ? args.positions : [args], signal);
      checkAbort(signal); if(this.disposed)fail('CANCELLED','The analysis service was closed.');
      if (operation === 'code_flow') return this.explorer.codeFlow(specs[0], {maxNodes:args.maxNodes,includeCode:true}, signal);
      if (operation === 'class_diagram' || operation === 'module_dependencies') return this.classes.analyze(specs[0], signal, {dependenciesOnly:operation === 'module_dependencies'});
      const targets = await Promise.all(specs.map(spec => this.adapter.target(spec, signal)));
      if (operation === 'trace_value') return this.adapter.valueTrace(targets[0], {direction:args.direction,depth:args.depth,maxNodes:args.maxNodes}, signal);
      if (operation === 'simulate_value') return this.adapter.simulateValue(targets[0], {value:args.value,maxSteps:args.maxSteps,maxDepth:args.maxDepth,timeBudgetMs:900}, signal);
      if (operation === 'correlate_symbols') return this.adapter.correlate(targets, {depth:args.depth,maxNodes:args.maxNodes}, signal);
      fail('INVALID_ARGUMENT', 'Unknown analysis operation.');
    }).finally(() => { this.pending--; });
    this.tail = result.catch(() => {});
    return result;
  }
  dispose() {
    this.disposed = true; this.adapter.dispose(); this.explorer.invalidate(); this.explorer.graphs.clear();
  }
}
module.exports = { Analysis };
