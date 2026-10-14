'use strict';
const crypto = require('node:crypto');
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
/** Static shell only: graph/source data never gets interpolated into JavaScript.
 * Register onDidReceiveMessage BEFORE assigning this HTML, then wait for ready.
 */
function webviewHtml({ scriptUri, styleUri, cspSource, initToken = '', bridgeUri, hostName = 'VS Code', connectSource = "'none'" }) {
  const nonce = crypto.randomBytes(24).toString('base64');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="cfl-init" content="${escapeHtml(initToken)}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escapeHtml(cspSource)}; style-src ${escapeHtml(cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${escapeHtml(connectSource)}; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${escapeHtml(styleUri)}"><title>Code Flow Lens</title>
</head><body>
<div id="app">
  <header>
    <div class="heading"><strong id="title">Code Flow Lens</strong><span id="stats"></span><span class="spacer"></span><span class="local-only">${escapeHtml(hostName)}</span></div>
    <div class="modes">
      <button id="analyzeSmart">Analyze</button><button id="relations" class="primary">Relations</button><button id="valueTrace" title="Trace where a selected value comes from and where it can propagate.">Value flow</button><button id="simulateValue" title="Inject a hypothetical value at the selected binding/use and statically evaluate reachable transformations.">Inject value</button><button id="classDiagram" title="Build a local AST UML/dependency diagram for classes, interfaces, types and React components in the file.">Class / UML</button><button id="correlate">Correlate</button><button id="codeFlow" title="Control flow graph for the surrounding function/method: branches, loops and local data edges.">Code flow</button><button id="reactTree" title="Static React render/dependency hierarchy.">React tree</button><button id="previewReact">Render React</button><button id="runtime" title="Observe a running app: DOM, React state when visible, network events and screenshots.">Runtime</button>
      <span class="spacer"></span><label><input id="showCode" type="checkbox" checked> Code cards</label><label><input id="showRefs" type="checkbox" checked> Reference files</label>
      <button id="diagnostics">Diagnostics</button><button id="javaHelp">Java diagnostics</button>
    </div><div class="actions">
      <input id="search" type="search" placeholder="Filter nodes..." aria-label="Filter nodes">
      <button id="zoomOut" title="Zoom out">-</button><button id="zoomIn" title="Zoom in">+</button><button id="resetZoom" title="Reset zoom around the viewport center">100%</button>
      <button id="fit" title="Fit all visible nodes">Fit</button><button id="center" title="Center the selected node">Center</button>
      <select id="edgeMode" title="Show control paths or local data dependencies"><option value="control">Control / relations</option><option value="data">Data dependencies</option></select>
      <button id="origin">Origin</button><button id="destination">Destination</button><button id="allPaths">All</button><button id="resetView" title="Clear filters, reveal reference groups and fit the graph">Reset view</button>
      <button id="walk">Walk path</button><button id="walkBack" hidden>Back</button><button id="walkReverse" hidden>Reverse step</button>
      <button id="refresh">Refresh</button><button id="cancel" hidden>Stop</button>
      <button id="export" title="Save the loaded graph as structured JSON. Code-flow exports include source code.">JSON</button>
      <button id="shortcut" title="Configure the Show Symbol Flow keyboard shortcut">Keys</button>
      <button id="details" aria-pressed="true" title="Toggle node details">Details</button>
    </div>
    <div id="status" role="status" aria-live="polite">Loading the interface... If this persists, open Output &gt; Code Flow Lens.</div>
    <div id="viewNotice" role="status" hidden><span id="viewNoticeText"></span> <button id="showHiddenReferences">Show references</button></div>
  </header>
  <main id="main" class="with-details">
    <div id="viewport" tabindex="0" role="region" aria-label="Code graph. Drag background to pan. Control plus wheel to zoom. Arrow keys to pan. F to fit.">
      <div id="world"><svg id="edges" width="1" height="1" aria-hidden="true"></svg><div id="nodes"></div></div>
      <div id="empty">Waiting for the selected symbol...</div>
      <div class="navigation-help">Drag to pan &middot; Ctrl + wheel to zoom &middot; Double-click opens source</div>
    </div>
    <aside id="inspector" aria-label="Selected node details"><p>Select a node to inspect references or expand its calls.</p></aside>
  </main>
  <div id="error" role="alert" hidden></div>
</div>
${bridgeUri ? `<script nonce="${nonce}" src="${escapeHtml(bridgeUri)}" defer></script>` : ''}
<script nonce="${nonce}" src="${escapeHtml(scriptUri)}" defer></script>
</body></html>`;
}
module.exports = { webviewHtml };
