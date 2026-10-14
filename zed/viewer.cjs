#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { fork, spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { fileURLToPath } = require('node:url');
const { Analysis } = require('../mcp/analysis.cjs');
const { webviewHtml } = require('../lib/webview-html');
const { version } = require('../package.json');

function position(input) {
  if (!input || typeof input.file !== 'string' || !input.file || input.file.length > 4096 ||
      !Number.isSafeInteger(input.line) || input.line < 1 || !Number.isSafeInteger(input.column) || input.column < 1) {
    throw new Error('Provide a file and positive, 1-based line and column.');
  }
  return { file:input.file, line:input.line, column:input.column };
}

function runCommand(command, args, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:['ignore','ignore','pipe'], windowsHide:true });
    let stderr = '', done = false, checking = false, poll;
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer); clearInterval(poll); child.stderr.destroy();
      if (error) { if (stderr.trim()) error.message += '\n' + stderr.trim(); reject(error); } else resolve();
    };
    const timer = setTimeout(() => finish(new Error(ready ? 'The graph page did not connect within 15 seconds.' : command + ' did not finish within 15 seconds.')), 15000);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', finish);
    child.once('exit', code => { if (code !== 0) finish(new Error(command + ' exited with code ' + code)); else if (!ready) finish(); });
    if (ready) poll = setInterval(async () => {
      if (checking || done) return; checking = true;
      try { if (await ready()) finish(); } catch (error) { finish(error); }
      finally { checking = false; }
    }, 250);
    child.unref();
  });
}

async function serve(root, registry, zedCommand) {
  const analysis = new Analysis(root), token = crypto.randomBytes(32).toString('base64url');
  const clients = new Set();
  let origin, idleTimer, controller, lastRequest, fingerprints = new Map(), closed = false;
  let state = { type:'flow:state', epoch:0, graph:null, cards:{}, loading:null, error:null };
  const send = (message=state) => { const data = 'data: ' + JSON.stringify(message.type==='flow:state'?{...message,workspace:root,sessionId:path.basename(registry,'.json')}:message) + '\n\n'; for (const client of clients) client.write(data); };
  const idle = () => { clearTimeout(idleTimer); if (!clients.size) idleTimer = setTimeout(close, 90000); };
  function close() {
    if (closed) return; closed = true; clearTimeout(idleTimer); clearInterval(heartbeat); controller?.abort(); analysis.dispose();
    for (const client of clients) client.end();
    server.close(); server.closeAllConnections();
    try { if (JSON.parse(fs.readFileSync(registry, 'utf8')).token === token) fs.unlinkSync(registry); } catch {}
  }
  async function analyze(request, signal) {
    controller?.abort(); const operation = new AbortController(); controller = operation;
    const abort=()=>operation.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    lastRequest = request; const epoch = state.epoch + 1;
    state = { type:'flow:state', epoch, graph:null, cards:{}, loading:{trace_value:'Value flow',code_flow:'Code flow',simulate_value:'Value simulation',class_diagram:'Class / UML',module_dependencies:'Module dependencies'}[request.operation], error:null }; send();
    try {
      // shortcut: tasks provide saved files only; use live buffers when Zed exposes them.
      const graph = await analysis.run(request.operation, request.args, operation.signal);
      if (operation.signal.aborted || state.epoch !== epoch) return {error:'Analysis cancelled or replaced.'};
      assert(Array.isArray(graph.nodes) && Array.isArray(graph.edges) && graph.analysis && graph.target && graph.nodes.some(node => node.id === graph.rootId), 'Invalid graph returned by the analysis engine.');
      const observed = new Map();
      for (const location of [request.args, ...graph.nodes.map(node => node.location).filter(Boolean)]) {
        const file = (location.uri || location.file).startsWith('file:') ? fileURLToPath(location.uri || location.file) : analysis.adapter.scope.resolve(location.file);
        await analysis.adapter.scope.assert(file); const stat = fs.statSync(file);
        observed.set(file, `${stat.mtimeMs}:${stat.size}`);
      }
      if (operation.signal.aborted || state.epoch !== epoch) return {error:'Analysis cancelled or replaced.'};
      fingerprints = observed;
      state = { ...state, graph, loading:null }; send();
      const cards = {};
      await Promise.all(graph.nodes.filter(node => node.location && node.code === undefined).map(async node => {
        try { cards[node.id] = await analysis.adapter.sourceCard(node.location, 12, operation.signal); }
        catch (error) { cards[node.id] = { lines:[], warning:error.message }; }
      }));
      if (!operation.signal.aborted && state.epoch === epoch) { state = { ...state, cards }; send(); }
      if (operation.signal.aborted || state.epoch !== epoch) return {error:'Analysis cancelled or replaced.'};
      return {graph:state.graph};
    } catch (error) {
      if (state.epoch === epoch) { state = { ...state, loading:null, error:operation.signal.aborted ? 'Analysis cancelled.' : error.message }; send(); }
      return {error:operation.signal.aborted?'Analysis cancelled.':error.message};
    } finally {signal?.removeEventListener('abort',abort);}
  }
  function nodeFor(message) {
    if (message.epoch !== state.epoch || message.graphId !== state.graph?.graphId) throw new Error('The graph changed. Select the node again.');
    for (const [file, fingerprint] of fingerprints) {
      let current; try { const stat = fs.statSync(file); current = `${stat.mtimeMs}:${stat.size}`; } catch {}
      if (current !== fingerprint) {
        state.graph.analysis.stale = true; send(); throw new Error('Source changed. Refresh before following positions.');
      }
    }
    const node = state.graph.nodes.find(item => item.id === message.nodeId);
    if (!node?.location) throw new Error('This node has no source location.');
    return node;
  }
  async function message(input) {
    if (input.command === 'ready' || input.command === 'rendered') return;
    if (input.epoch !== state.epoch) throw new Error('The graph changed. Refresh the page.');
    if (input.command === 'cancel') { controller?.abort(); return; }
    if (input.command === 'close') { setTimeout(close, 100); return; }
    if (input.command === 'uiError') throw new Error(String(input.message).slice(0, 2000));
    if (input.command === 'refresh') { if (lastRequest) void analyze(lastRequest); return; }
    const node = nodeFor(input), target = position({ file:node.location.uri || node.location.file, line:node.location.line, column:node.location.column });
    if (input.command === 'selected') {state.graph.selectedNodeId=node.id;return;}
    analysis.adapter.scope.invalidate();
    if (input.command === 'openNode' || input.command === 'openCodeLine') {
      const uri = analysis.host.facade.Uri.parse(target.file);
      await analysis.adapter.scope.assert(uri.fsPath);
      if (input.command === 'openCodeLine') {
        const doc = await analysis.adapter.document(uri);
        if (!Number.isSafeInteger(input.line) || input.line < 1 || input.line > doc.lineCount) throw new Error('Invalid source line.');
        target.line = input.line; target.column = 1;
      }
      await runCommand(zedCommand, ['--existing', `${uri.fsPath}:${target.line}:${target.column}`]); return;
    }
    if (['valueTrace','valueOrigin','valueDestination'].includes(input.command)) {
      void analyze({ operation:'trace_value', args:{ ...target, direction:input.command === 'valueOrigin' ? 'incoming' : input.command === 'valueDestination' ? 'outgoing' : 'both', depth:4, maxNodes:140 } }); return;
    }
    if (input.command === 'codeFlow') { void analyze({ operation:'code_flow', args:{ ...target, maxNodes:250 } }); return; }
    if (input.command === 'classDiagram' || input.command === 'dependencies') { void analyze({operation:input.command==='classDiagram'?'class_diagram':'module_dependencies',args:target});return; }
    if (input.command === 'simulateValue' && Object.hasOwn(input, 'value')) {
      void analyze({ operation:'simulate_value', args:{ ...target, value:input.value, maxSteps:180, maxDepth:4 } }); return;
    }
    throw new Error('Unsupported viewer action.');
  }
  const assets = new Map([
    ['/graph.js', [path.join(__dirname, '../media/graph.js'), 'text/javascript']],
    ['/graph.css', [path.join(__dirname, '../media/graph.css'), 'text/css']],
    ['/browser.js', [path.join(__dirname, 'browser.js'), 'text/javascript']]
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    try {
      if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin) { res.writeHead(403).end(); return; }
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && (url.pathname === '/' || assets.has(url.pathname))) {
        if (url.pathname === '/') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(webviewHtml({scriptUri:'/graph.js',styleUri:'/graph.css',bridgeUri:'/browser.js',cspSource:"'self'",connectSource:"'self'",hostName:'Zed · local'}));
        } else { const [file, type] = assets.get(url.pathname); res.setHeader('Content-Type', type + '; charset=utf-8'); res.end(fs.readFileSync(file)); }
        return;
      }
      if ((req.headers['x-cfl-token'] || url.searchParams.get('token')) !== token) { res.writeHead(403).end(); return; }
      if (req.method === 'GET' && url.pathname === '/health') {
        res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({workspace:root,version,connected:clients.size > 0,viewerApi:1,graphId:state.graph?.graphId,kind:state.graph?.kind,name:state.graph?.target.name,selectedNodeId:state.graph?.selectedNodeId,loading:state.loading})); return;
      }
      if (req.method === 'GET' && url.pathname === '/graph') {
        if(!state.graph)throw new Error(state.error||'The graph is still loading. Run a viewer task or wait for the current analysis.');
        const node=state.graph.nodes.find(item=>item.id===(state.graph.selectedNodeId||state.graph.rootId));
        try{nodeFor({epoch:state.epoch,graphId:state.graph.graphId,nodeId:node.id});}catch(error){if(!state.graph.analysis.stale)throw error;}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({workspace:root,epoch:state.epoch,graph:state.graph,selectedNode:node,sourceCard:state.cards[node.id]}));return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {'Content-Type':'text/event-stream','Connection':'keep-alive'}); clients.add(res); clearTimeout(idleTimer);
        send(); res.on('close', () => { clients.delete(res); idle(); }); return;
      }
      if (req.method !== 'POST' || !['/launch','/message','/analyze','/focus'].includes(url.pathname)) { res.writeHead(404).end(); return; }
      if (req.headers['content-type'] !== 'application/json') { res.writeHead(415).end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(url.pathname==='/focus'){
        const node=nodeFor(input);state.graph.selectedNodeId=node.id;send({type:'flow:focusNode',epoch:state.epoch,graphId:state.graph.graphId,nodeId:node.id});
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({focused:node.id}));return;
      }
      if(url.pathname==='/analyze'){
        const node=nodeFor(input);
        if(!['trace_value','simulate_value','code_flow','class_diagram','module_dependencies'].includes(input.operation))throw new Error('Unsupported analysis operation.');
        if(input.operation==='simulate_value'&&!Object.hasOwn(input,'value'))throw new Error('Simulation requires a JSON value.');
        if(!['incoming','outgoing','both'].includes(input.direction)||!Number.isInteger(input.depth)||input.depth<1||input.depth>12||!Number.isInteger(input.maxNodes)||input.maxNodes<2||input.maxNodes>500)throw new Error('Invalid analysis direction or limits.');
        if(input.operation==='code_flow'&&input.maxNodes<5)throw new Error('Code flow requires at least 5 nodes.');
        const lifetime=new AbortController();res.once('close',()=>{if(!res.writableEnded)lifetime.abort();});
        const result=await analyze({operation:input.operation,args:{file:node.location.uri,line:node.location.line,column:node.location.column,direction:input.direction,depth:input.depth,maxNodes:input.maxNodes,value:input.value,maxSteps:180,maxDepth:4}},lifetime.signal);
        res.writeHead(result.error?400:200,{'Content-Type':'application/json'}).end(JSON.stringify(result));return;
      }
      if (url.pathname === '/launch') {
        const target = position(input);
        await analysis.adapter.scope.assert(analysis.adapter.scope.resolve(target.file));
        if (!['value','code'].includes(input.mode)) throw new Error('Mode must be value or code.');
        void analyze({ operation:input.mode === 'code' ? 'code_flow' : 'trace_value', args:{ ...target, direction:'both', depth:4, maxNodes:input.mode === 'code' ? 250 : 140 } });
        idle();
      } else { if (!input || typeof input.command !== 'string') throw new Error('Invalid viewer message.'); await message(input); }
      res.setHeader('Content-Type', 'application/json'); res.end('{}');
    } catch (error) {
      res.writeHead(400, {'Content-Type':'application/json'}).end(JSON.stringify({error:error.message}));
    }
  });
  server.requestTimeout = 15000;
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': keepalive\n\n'); }, 30000);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    const entry = { origin, token, workspace:root, version };
    fs.writeFileSync(registry, JSON.stringify(entry), { mode:0o600 });
    process.send?.(entry); process.disconnect?.(); idle();
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } catch (error) { close(); throw error; }
}

async function main() {
  const { values } = parseArgs({options:{workspace:{type:'string'},file:{type:'string'},line:{type:'string'},column:{type:'string'},mode:{type:'string',default:'value'},zed:{type:'string',default:'zed'},serve:{type:'boolean',default:false}},strict:true});
  if (!values.workspace || !path.isAbsolute(values.workspace)) throw new Error('--workspace requires an absolute project directory.');
  const root = fs.realpathSync(values.workspace);
  if (!fs.statSync(root).isDirectory()) throw new Error('--workspace must be a directory.');
  const directory = path.join(os.tmpdir(), 'code-flow-lens-' + (process.getuid?.() ?? os.userInfo().username));
  fs.mkdirSync(directory, {recursive:true,mode:0o700});
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new Error('Unsafe viewer session directory.');
  fs.chmodSync(directory, 0o700);
  const registry = path.join(directory, crypto.createHash('sha256').update(__dirname + '\0' + root + '\0' + values.zed).digest('hex') + '.json');
  if (values.serve) { await serve(root, registry, values.zed); return; }
  const target = position({file:values.file,line:Number(values.line),column:Number(values.column)});
  if (!['value','code'].includes(values.mode)) throw new Error('--mode must be value or code.');
  let entry;
  try {
    const saved = JSON.parse(fs.readFileSync(registry, 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(saved.origin) || !/^[\w-]{43}$/.test(saved.token)) throw new Error('Invalid saved session.');
    const response = await fetch(saved.origin + '/health', {headers:{'x-cfl-token':saved.token},signal:AbortSignal.timeout(1500)});
    const health = await response.json();
    if (response.ok && health.workspace === root && health.version === version && typeof health.connected === 'boolean') entry = saved;
  } catch {}
  if (!entry) {
    entry = await new Promise((resolve, reject) => {
      const child = fork(__filename, ['--serve','--workspace',root,'--zed',values.zed], {detached:true,stdio:['ignore','ignore','ignore','ipc']});
      const timer = setTimeout(() => { child.kill(); reject(new Error('Viewer startup timed out.')); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Viewer failed to start (exit ' + code + ').')); });
      child.once('message', data => { clearTimeout(timer); child.unref(); data.error ? reject(new Error(data.error)) : resolve(data); });
    });
  }
  const response = await fetch(entry.origin + '/launch', {method:'POST',headers:{'Content-Type':'application/json','x-cfl-token':entry.token},body:JSON.stringify({...target,mode:values.mode}),signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error((await response.json()).error || 'Failed to select the source.');
  const url = entry.origin + '/#' + entry.token;
  console.log('Code Flow Lens: ' + url);
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  try {
    await runCommand(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], async () => {
      const health = await fetch(entry.origin + '/health', {headers:{'x-cfl-token':entry.token},signal:AbortSignal.timeout(1500)});
      return health.ok && (await health.json()).connected === true;
    });
  } catch (error) { throw new Error('Automatic browser opening failed. Open the URL above manually.\n' + error.message); }
}
main().catch(error => { process.send?.({error:error.message}); console.error('Code Flow Lens viewer: ' + error.message); process.exitCode = 1; });
