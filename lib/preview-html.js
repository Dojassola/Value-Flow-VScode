'use strict';
const crypto=require('node:crypto');
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function previewHtml({url,name,props,scriptUri,cspSource,isolated,wrapper=''}){
  const nonce=crypto.randomBytes(24).toString('base64'),origin=new URL(url).origin;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${esc(origin)}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none';">
  <style>html,body{height:100%;margin:0;background:var(--vscode-editor-background,#181b20);color:var(--vscode-foreground,#eee);font:13px system-ui}body{display:flex;flex-direction:column}header{padding:12px;border-bottom:1px solid #666}h2{font-size:15px;margin:0 0 8px}p{margin:8px 0;line-height:1.5}iframe{flex:1;width:100%;background:white;border:0}textarea{width:min(640px,95%);height:90px;background:var(--vscode-input-background,#222);color:inherit;font:12px monospace}button,input{padding:6px 10px;background:var(--vscode-button-secondaryBackground,#394451);color:inherit;border:1px solid #666;border-radius:4px}details{margin:8px 0}#error{color:#ffb59d}</style></head>
  <body><header><h2>React preview: ${esc(name)}</h2><p>${isolated?'Real React rendering with the project dependencies. ISOLATED: fetch/network, form submissions and remote assets are blocked. This is not a screenshot or inferred JSX mockup.':'Real running-app URL. The app may make network requests and perform actions. Its runtime environment is supplied by your dev server.'}</p>
  ${isolated?`<details><summary>Props (JSON) and optional provider wrapper</summary><textarea id="props">${esc(JSON.stringify(props,null,2))}</textarea><br><label>Wrapper file (default export): <input id="wrapper" value="${esc(wrapper)}" placeholder="optional workspace-relative .tsx"></label><button id="apply">Rebuild preview</button></details>`:''}
  <button id="external">Open in browser</button><button id="stop">Close preview</button><span id="error"></span></header>
  <iframe id="preview" title="Rendered React component" sandbox="allow-scripts allow-same-origin allow-forms" src="${esc(url)}"></iframe>
  <script nonce="${nonce}" src="${esc(scriptUri)}" defer></script></body></html>`;
}
module.exports={previewHtml};
