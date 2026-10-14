'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webviewHtml } = require('../lib/webview-html');

test('0.1.2 newline interpolation failure is reproduced; current webview JS compiles as a separate asset', () => {
  // Same failure mode found in the actual 0.1.2 renderWebview template:
  const legacyGeneratedScript = `const ms = 5; const title = 'Providers: ' + ms + ' ms\n' + 'Total';`;
  assert.throws(() => new vm.Script(legacyGeneratedScript), SyntaxError);
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(__dirname, '../media/graph.js'), 'utf8')));
});
test('HTML shell contains no interpolated executable source data and authorizes one external script', () => {
  const html = webviewHtml({ scriptUri: 'https://local.invalid/graph.js', styleUri: 'https://local.invalid/graph.css', cspSource: 'https://local.invalid' });
  const script = html.match(/<script([^>]*)>([\s\S]*?)<\/script>/g);
  assert.equal(script.length, 1); assert.match(script[0], /nonce="[^"]+"/); assert.match(script[0], /src="https:\/\/local.invalid\/graph.js"/);
  assert.match(script[0], />\s*<\/script>$/);
  assert.match(html, /connect-src 'none'/); assert.match(html, /Loading the interface/);
});
