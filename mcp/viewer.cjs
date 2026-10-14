'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const directory = path.join(os.tmpdir(), 'code-flow-lens-' + (process.getuid?.() ?? os.userInfo().username));

function session(id) {
  assert(/^[a-f0-9]{64}$/.test(id), 'Invalid graph session identifier.');
  const folder = fs.lstatSync(directory), file = path.join(directory,id+'.json'), stat = fs.lstatSync(file);
  if (!folder.isDirectory() || folder.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || process.getuid && (folder.uid !== process.getuid() || stat.uid !== process.getuid() || (folder.mode & 0o077)!==0)) throw new Error('Unsafe graph session.');
  const entry = JSON.parse(fs.readFileSync(file,'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(entry.origin) || !/^[\w-]{43}$/.test(entry.token) || typeof entry.workspace !== 'string' || !path.isAbsolute(entry.workspace)) throw new Error('Invalid graph session metadata.');
  return entry;
}

async function request(id, route, input, signal, timeoutMs=35000) {
  const entry = session(id), controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort',abort,{once:true}); if (signal?.aborted) abort();
  const timer = setTimeout(abort,timeoutMs);
  try {
    const response = await fetch(entry.origin+route, {method:input === undefined ? 'GET' : 'POST',headers:{'x-cfl-token':entry.token,...(input === undefined ? {} : {'Content-Type':'application/json'})},...(input === undefined ? {} : {body:JSON.stringify(input)}),signal:controller.signal});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The graph viewer rejected the request.');
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
}

async function list(signal) {
  if (!fs.existsSync(directory)) return {graphs:[]};
  const files = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  const results = await Promise.allSettled(files.map(async name => {
    const id = name.slice(0,-5), entry = session(id), health = await request(id,'/health',undefined,signal,1500);
    if (health.workspace !== entry.workspace || health.viewerApi !== 1 || !health.connected) return null;
    return {session_id:id,workspace:health.workspace,graphId:health.graphId,kind:health.kind,name:health.name,selectedNodeId:health.selectedNodeId,loading:health.loading};
  }));
  if (signal?.aborted) throw new Error('Graph discovery cancelled.');
  return {graphs:results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value)};
}

module.exports = { list, request };
