'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
let count = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'test-artifacts'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
      count++;
    }
  }
}
walk(root);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== '0.13.0' || manifest.publisher !== 'local-dev' || manifest.name !== 'code-flow-lens') throw new Error('Unexpected extension identity.');
if (!manifest.activationEvents.includes('onWebviewPanel:codeFlowLens.graph')) throw new Error('Missing onWebviewPanel activation event for panel restore.');
new vm.Script(fs.readFileSync(path.join(root, 'media', 'graph.js'), 'utf8'));
const { webviewHtml } = require(path.join(root, 'lib', 'webview-html'));
const shell = webviewHtml({ scriptUri: 'graph.js', styleUri: 'graph.css', cspSource: 'vscode-resource:', initToken: 'check' });
if (!shell.includes('id="viewport"') || !shell.includes('src="graph.js"') || !shell.includes('name="cfl-init"')) throw new Error('Webview HTML shell failed to render required assets.');
console.log(`Checked ${count} JavaScript files, including the actual webview asset; manifest identity/version valid; webview shell renders.`);
