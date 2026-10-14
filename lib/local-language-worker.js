'use strict';
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { TypeScriptHost } = require('./local-typescript-host');
const { InstantSemanticEngine } = require('./instant-semantic-engine');
const { QuickSimulationEngine } = require('./quick-simulation-engine');
const { QuickValueTracer } = require('./quick-value-trace');
const { errorInfo } = require('./util');

// The always-on worker is intentionally light: it discovers workspace files and
// serves relationship queries through the persistent Bloom + AST index. It never
// creates a TypeScript LanguageService/Program for the normal graph.
const host = new TypeScriptHost(workerData.root, { maxFiles: workerData.maxFiles || 8000, focusFile: workerData.focusFile || null, lightweight: true });
const quick = new InstantSemanticEngine(host, { maxCandidates: workerData.maxCandidates || 260, scanBudgetMs: workerData.scanBudgetMs || 180, cacheDir: workerData.cacheDir || null });
const simulator = new QuickSimulationEngine(host, quick);
const valueTracer = new QuickValueTracer(host, quick);

function maskJava(text) {
  let out = '', i = 0, mode = 'code';
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (mode === 'code' && c === '/' && n === '/') { out += '  '; i += 2; mode = 'line'; continue; }
    if (mode === 'code' && c === '/' && n === '*') { out += '  '; i += 2; mode = 'block'; continue; }
    if (mode === 'code' && c === '"') { out += ' '; i++; mode = 'string'; continue; }
    if (mode === 'code' && c === "'") { out += ' '; i++; mode = 'char'; continue; }
    if (mode === 'line') { if (c === '\n') { out += '\n'; mode = 'code'; } else out += ' '; i++; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { out += '  '; i += 2; mode = 'code'; } else { out += c === '\n' ? '\n' : ' '; i++; } continue; }
    if (mode === 'string' || mode === 'char') { const quote = mode === 'string' ? '"' : "'"; if (c === '\\') { out += ' '; i++; if (i < text.length) { out += text[i] === '\n' ? '\n' : ' '; i++; } continue; } if (c === quote) { out += ' '; i++; mode = 'code'; } else { out += c === '\n' ? '\n' : ' '; i++; } continue; }
    out += c; i++;
  }
  return out;
}
function braceEnd(mask, open) {
  let depth = 0;
  for (let i = open; i < mask.length; i++) { if (mask[i] === '{') depth++; else if (mask[i] === '}' && --depth === 0) return i + 1; }
  return mask.length;
}
class JavaIndex {
  constructor(host) { this.host = host; this.generation = -1; this.files = []; this.decls = []; this.methods = []; this.classes = []; }
  location(file, start, end = start + 1) {
    const d = this.host.document(file), a = d.positionAt(start), b = d.positionAt(end);
    return { uri: pathToFileURL(file).href, file: path.relative(this.host.root, file).replace(/\\/g, '/'), workspace: path.basename(this.host.root), line: a.line + 1, column: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 };
  }
  ensure() {
    if (this.generation === this.host.generation) return;
    this.generation = this.host.generation; this.files = []; this.decls = []; this.methods = []; this.classes = [];
    const seed=this.host.initialFocus&&/\.java$/i.test(this.host.initialFocus)?this.host.initialFocus:null;
    const packageRoot=seed?this.host.nearestPackageRoot(seed,null):this.host.root;
    const discovered=seed?this.host.lightweightPackageSources(packageRoot,seed):this.host.files;
    for (const file of [...new Set([...this.host.files,...discovered])].filter(f => /\.java$/i.test(f)).slice(0, 4000)) {
      const text = this.host.read(file); if (text == null) continue; const mask = maskJava(text); this.files.push({ file, text, mask });
      const classRe = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)\b([^\{;]*)\{/g; let m;
      while ((m = classRe.exec(mask))) { const name = m[2], start = m.index + m[0].indexOf(name), open = m.index + m[0].lastIndexOf('{'), end = braceEnd(mask, open); const c = { kind: m[1], name, file, start, end, header: m[3] || '' }; this.classes.push(c); this.decls.push(c); }
      const methodRe = /(?:^|[;{}])\s*(?:@[\w$.]+(?:\([^)]*\))?\s*)*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>{};]+>\s*)?(?:[A-Za-z_$][\w$<>\[\],.?\s]*\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^\{;]+)?\{/gm;
      while ((m = methodRe.exec(mask))) { const name = m[1]; if (['if','for','while','switch','catch','synchronized','try','new'].includes(name)) continue; const nameAt = m.index + m[0].lastIndexOf(name), open = m.index + m[0].lastIndexOf('{'), end = braceEnd(mask, open); const method = { kind: 'method', name, file, start: nameAt, bodyStart: open + 1, end }; method.owner = this.classes.filter(c => c.file === file && c.start <= nameAt && nameAt < c.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0]?.name || ''; this.methods.push(method); this.decls.push(method); }
      const fieldRe = /\b(?:[A-Za-z_$][\w$<>\[\],.?]*\s+)+([A-Za-z_$][\w$]*)\s*(?==|;|,)/g;
      while ((m = fieldRe.exec(mask))) { const name = m[1], start = m.index + m[0].lastIndexOf(name); if (!this.methods.some(md => md.file === file && md.bodyStart <= start && start < md.end)) this.decls.push({ kind:'field', name, file, start, end:start+name.length }); }
    }
  }
  offset(target) { const d = this.host.document(fileURLToPath(target.location.uri)); return d.offsetAt({ line: target.location.line - 1, character: target.location.column - 1 }); }
  defs(name) { this.ensure(); return this.decls.filter(d => d.name === name); }
  containing(file, offset) {
    this.ensure(); const out = [];
    for (const m of this.methods.filter(x => x.file === file && x.start <= offset && offset < x.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))) out.push({ name:m.name, kind:11, detail:'method', location:this.location(file,m.start,m.start+m.name.length) });
    for (const c of this.classes.filter(x => x.file === file && x.start <= offset && offset < x.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))) out.push({ name:c.name, kind:5, detail:c.kind, location:this.location(file,c.start,c.start+c.name.length) });
    return out;
  }
  references(name) {
    this.ensure(); const results = [], re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\b','g');
    for (const f of this.files) { let m; while ((m = re.exec(f.mask))) results.push(this.location(f.file,m.index,m.index+name.length)); }
    return results;
  }
  callItem(method) { const loc=this.location(method.file,method.start,method.start+method.name.length); loc.fullRange=this.location(method.file,method.start,method.end); return { key:`${loc.uri}:${loc.line}:${loc.column}`, name:method.name, kind:11, detail:method.owner, location:loc, opaque:{ java:true,file:method.file,start:method.start,name:method.name } }; }
  prepare(target) { this.ensure(); const file = fileURLToPath(target.location.uri), offset = this.host.document(file).offsetAt({line:target.location.line-1,character:target.location.column-1}); const methods=this.methods.filter(m=>m.file===file&&m.start<=offset&&offset<m.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start)); const exact=this.methods.filter(m=>m.file===file&&m.name===target.name&&Math.abs(m.start-offset)<Math.max(80,target.name.length+20)); const selected=methods[0]||exact[0]; return selected?[this.callItem(selected)]:[]; }
  calls(item, direction) {
    this.ensure(); const current=this.methods.find(m=>m.file===item.opaque.file&&m.start===item.opaque.start) || this.methods.find(m=>m.name===item.name); if(!current)return[];
    if(direction==='outgoing'){
      const f=this.files.find(x=>x.file===current.file); const body=f?.mask.slice(current.bodyStart,current.end)||''; const re=/\b([A-Za-z_$][\w$]*)\s*\(/g, out=[]; let m;
      while((m=re.exec(body))){const name=m[1];if(['if','for','while','switch','catch','synchronized','super','this','new'].includes(name))continue;const defs=this.methods.filter(x=>x.name===name).slice(0,4);for(const d of defs){const site=this.location(current.file,current.bodyStart+m.index,current.bodyStart+m.index+name.length);out.push({item:this.callItem(d),sites:[site],totalSites:1});}}
      return out;
    }
    const out=[];for(const caller of this.methods){const f=this.files.find(x=>x.file===caller.file);const body=f?.mask.slice(caller.bodyStart,caller.end)||'';const re=new RegExp('\\b'+current.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*\\(','g');let m,sites=[];while((m=re.exec(body)))sites.push(this.location(caller.file,caller.bodyStart+m.index,caller.bodyStart+m.index+current.name.length));if(sites.length)out.push({item:this.callItem(caller),sites:sites.slice(0,10),totalSites:sites.length});}return out;
  }
  query(op,args){ this.ensure(); const t=args.target;
    if(op==='definitions') return {items:this.defs(t.name).map(d=>this.location(d.file,d.start,d.start+d.name.length)),excluded:0,backend:'local-java-index'};
    if(op==='implementations'){const defs=[];for(const c of this.classes){if(new RegExp('\\b(?:extends|implements)\\s+[^\\{]*\\b'+t.name+'\\b').test(c.header))defs.push(this.location(c.file,c.start,c.start+c.name.length));}return{items:defs,excluded:0,backend:'local-java-index'};}
    if(op==='references')return{items:this.references(t.name),excluded:0,backend:'local-java-index'};
    if(op==='prepare')return{items:this.prepare(t),excluded:0,backend:'local-java-index'};
    if(op==='calls')return{items:this.calls(args.item,args.direction),excluded:0,backend:'local-java-index'};
    if(op==='containingSymbols'){const file=fileURLToPath(args.location.uri),off=this.host.document(file).offsetAt({line:args.location.line-1,character:args.location.column-1});const items=this.containing(file,off);return{items,total:items.length,truncated:false,provider:'local-java-index'};}
    if(op==='findSymbols'){const q=args.args.query.toLowerCase(),limit=args.args.limit||30;const all=this.decls.filter(d=>d.name.toLowerCase().includes(q)).map(d=>({name:d.name,kind:d.kind==='method'?11:5,containerName:d.owner||'',location:this.location(d.file,d.start,d.start+d.name.length)}));return{symbols:all.slice(0,limit),totalReturnedByProvider:all.length,truncated:all.length>limit,excluded:0};}
    throw new Error('Unsupported Java local op '+op);
  }
}
const javaIndex = new JavaIndex(host);

function cleanCallItem(item){ if(!item)return item; const opaque=item.opaque?{_ts:item.opaque._ts}:undefined; return {...item,opaque}; }
function cleanResult(op,result){
  if(op==='prepare'&&result?.items)return {...result,items:result.items.map(cleanCallItem)};
  if(op==='calls'&&result?.items)return {...result,items:result.items.map(call=>({...call,item:cleanCallItem(call.item)}))};
  return result;
}

function languageForTarget(target){return target?.languageId || (/\.java$/i.test(target?.location?.file||target?.location?.uri||'')?'java':'typescript');}
async function run(op,args){
  if(op==='setOverlays'){
    const changed=host.setOverlays(args.items||[]);quick.invalidate();
    return {changed,generation:host.generation};
  }
  if(op==='invalidate'){
    // This is only sent for an actual editor/disk change now, not for every graph.
    host.bump();quick.invalidate();
    return {generation:host.generation};
  }
  if(op==='refresh'){
    host.refresh(true);quick.invalidate();
    return {status:{...host.status(),quick:quick.status()}};
  }
  if(op==='status')return {...host.status(),quick:quick.status(),backend:'persistent-bloom-ast-index'};
  if(op==='warmIndex'){const file=path.resolve(args.file);if(/\.[cm]?[jt]sx?$/i.test(file))quick.packageFileList(file);return {file,index:quick.status().searchIndex};}
  // Prime is a no-op for normal graph queries. Query-local Programs are built
  // once for the selected symbol and shared by definitions/refs/calls/impls.
  if(op==='prime')return {file:args.file,mode:'query-local',files:0,focused:true};
  if(languageForTarget(args.target)==='java'||args.item?.opaque?.java||op==='findSymbols'&&args.args?.file&&/\.java$/i.test(args.args.file))return javaIndex.query(op,args);
  if(op==='simulateValue')return simulator.simulate(args.target,args.options||{});
  if(op==='valueTrace')return valueTracer.trace(args.target,args.options||{});
  if(op==='definitions')return quick.definitions(args.target);
  if(op==='implementations')return quick.implementations(args.target);
  if(op==='references')return quick.references(args.target);
  if(op==='prepare')return quick.prepare(args.target);
  if(op==='calls')return quick.calls(args.item,args.direction);
  if(op==='containingSymbols')return quick.containingSymbols(args.location);
  if(op==='findSymbols')return quick.findSymbols(args.args);
  throw new Error('Unsupported local language operation: '+op);
}
parentPort.postMessage({type:'ready',status:host.status()});
parentPort.on('message',async m=>{try{const result=await run(m.op,m.args||{});parentPort.postMessage({id:m.id,result});}catch(error){parentPort.postMessage({id:m.id,error:errorInfo(error)});}});
