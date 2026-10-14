'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {fileURLToPath,pathToFileURL}=require('node:url');
const ts=require('../vendor/typescript');
const {inside}=require('./scope');
const {FlowError}=require('./util');
const VENDOR=path.resolve(__dirname,'../vendor');
const TS_SOURCE=/\.[cm]?[jt]sx?$/i;
const CALLABLE=new Set([
  ts.SyntaxKind.FunctionDeclaration,ts.SyntaxKind.FunctionExpression,ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,ts.SyntaxKind.Constructor,ts.SyntaxKind.GetAccessor,ts.SyntaxKind.SetAccessor
]);
function isCallable(n){return !!n&&CALLABLE.has(n.kind);}
function canonical(checker,symbol){
  if(!symbol)return null;
  try{while(symbol&&(symbol.flags&ts.SymbolFlags.Alias)){const next=checker.getAliasedSymbol(symbol);if(!next||next===symbol)break;symbol=next;}}catch{}
  return symbol||null;
}
function tokenAt(sf,offset){
  let best=sf;
  function visit(n){if(n.getFullStart()<=offset&&offset<=n.end){if(n.end-n.getStart(sf)<=best.end-best.getStart(sf))best=n;ts.forEachChild(n,visit);}}
  visit(sf);
  if(ts.isIdentifier(best)||ts.isPrivateIdentifier?.(best))return best;
  for(let n=best;n&&n!==sf;n=n.parent){if(ts.isIdentifier(n)||ts.isPrivateIdentifier?.(n))return n;if(n.name&&ts.isIdentifier(n.name)&&n.name.getStart(sf)<=offset&&offset<=n.name.end)return n.name;}
  return best;
}
function declNameNode(d){return d?.name&&typeof d.name.getStart==='function'?d.name:d;}
function callableDecl(decl){
  if(!decl)return null;
  if(isCallable(decl))return decl;
  if(ts.isVariableDeclaration(decl)&&decl.initializer&&isCallable(decl.initializer))return decl.initializer;
  if(ts.isPropertyAssignment(decl)&&decl.initializer&&isCallable(decl.initializer))return decl.initializer;
  return null;
}
function containingCallable(n){for(let p=n;p;p=p.parent)if(isCallable(p))return p;return null;}
function declarationName(decl,sf){
  if(decl?.name&&typeof decl.name.getText==='function')return decl.name.getText(sf);
  const c=callableDecl(decl);if(c?.parent&&ts.isVariableDeclaration(c.parent))return c.parent.name.getText(sf);
  return 'anonymous';
}
class QuerySemanticEngine{
  constructor(host,{maxCandidates=900}={}){
    this.host=host;this.maxCandidates=maxCandidates;this.programs=new Map();this.candidates=new Map();this.optionsCache=new Map();this.generation=-1;
  }
  syncGeneration(){if(this.generation===this.host.generation)return;this.generation=this.host.generation;this.programs.clear();this.candidates.clear();this.optionsCache.clear();}
  fileFromTarget(target){const raw=target?.location?.uri||target?.location?.file||target?.file;if(!raw)throw new FlowError('NO_FILE','Semantic target has no file.');return path.resolve(String(raw).startsWith('file:')?fileURLToPath(raw):raw);}
  docOffset(target){const file=this.fileFromTarget(target),doc=this.host.document(file);return{file,doc,offset:doc.offsetAt({line:target.location.line-1,character:target.location.column-1})};}
  optionsFor(file){
    const configs=this.host.nearbyConfigs(file);const key=configs[0]||'<default>';
    if(this.optionsCache.has(key))return this.optionsCache.get(key);
    let options=this.host.defaultOptions(),configFile=null;
    for(const c of configs){
      try{
        const read=ts.readConfigFile(c,f=>this.host.read(f));if(read.error)continue;
        const parseHost={useCaseSensitiveFileNames:true,fileExists:f=>this.host.readable(f),readFile:f=>this.host.read(f),readDirectory:()=>[]};
        const parsed=ts.parseJsonConfigFileContent(read.config,parseHost,path.dirname(c),undefined,c);
        options=this.host.safeOptions(parsed.options);configFile=c;break;
      }catch{}
    }
    // Relationship analysis does not need standard-library or @types programs.
    // Keeping them out makes the query program dramatically smaller while local
    // imports/path aliases still resolve through the real compiler options.
    options={...options,noEmit:true,skipLibCheck:true,noLib:true,types:[]};delete options.typeRoots;delete options.lib;delete options.plugins;
    const value={options,configFile};this.optionsCache.set(key,value);return value;
  }
  targetedFiles(focusFile){
    focusFile=path.resolve(focusFile);const root=this.host.nearestPackageRoot(focusFile,null);const out=[];const seen=new Set();const limit=Math.min(Math.max(this.maxCandidates*3,600),3000);
    // TypeScriptHost's focus-first bootstrap already discovered the selected
    // package. Reuse that list instead of walking the same tree again on the
    // first semantic query. This is the common path for editor graphs.
    for(const file of this.host.files||[]){const f=path.resolve(file);if(inside(root,f)&&TS_SOURCE.test(f)&&!seen.has(f)){seen.add(f);out.push(f);if(out.length>=limit)return out;}}
    if(out.length>1)return out;
    const walk=dir=>{if(out.length>=limit)return;let ents;try{ents=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}for(const ent of ents){if(out.length>=limit)return;if(ent.isSymbolicLink())continue;if(['node_modules','.git','.next','.nuxt','dist','build','coverage','vendor','.codex'].includes(ent.name))continue;const full=path.join(dir,ent.name);if(ent.isDirectory())walk(full);else if(ent.isFile()&&TS_SOURCE.test(full)){const f=path.resolve(full);if(!seen.has(f)){seen.add(f);out.push(f);}}}};
    walk(root);return out;
  }
  candidateFiles(name,focusFile){
    this.syncGeneration();name=String(name||'').trim();focusFile=path.resolve(focusFile);
    const cacheKey=name+'|'+focusFile;
    if(this.candidates.has(cacheKey))return this.candidates.get(cacheKey);
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const ident=name?new RegExp(`(^|[^$\\p{ID_Continue}])${escaped}([^$\\p{ID_Continue}]|$)`,'u'):null;
    const base=path.basename(focusFile).replace(/\.[^.]+$/,'');
    const packageRoot=this.host.nearestPackageRoot(focusFile,null);
    const scored=[];let matched=0;
    const pool=[...new Set([focusFile,...this.targetedFiles(focusFile),...this.host.files.filter(f=>TS_SOURCE.test(f)),...this.host.overlays.keys()].map(f=>path.resolve(f)))];
    for(const file of pool){
      let text;try{text=this.host.read(file);}catch{}if(text===undefined)continue;
      let hit=file===focusFile;
      if(!hit&&name)hit=text.includes(name)&&(ident?ident.test(text):true);
      // Default imports often rename the declaration. The module path still tends
      // to contain the defining file basename, so include those candidates too.
      if(!hit&&base&&base.length>2&&text.includes(base)&&/\b(?:import|export)\b/.test(text))hit=true;
      if(!hit)continue;matched++;
      const samePackage=inside(packageRoot,file)?0:1;
      const distance=path.relative(path.dirname(focusFile),file).split(path.sep).length;
      scored.push({file,score:(file===focusFile?-1_000_000:0)+samePackage*100000+distance*100+file.length});
    }
    scored.sort((a,b)=>a.score-b.score||a.file.localeCompare(b.file));
    const files=scored.slice(0,this.maxCandidates).map(x=>x.file);
    const result={files,matched,truncated:matched>files.length};this.candidates.set(cacheKey,result);return result;
  }
  compilerHost(options){
    const host=this.host;
    const read=file=>{const r=host.read(file);if(r!==undefined)return r;try{const real=fs.realpathSync(file);if(inside(VENDOR,real)&&/\.d\.ts$/.test(real))return fs.readFileSync(real,'utf8');}catch{}return undefined;};
    return{
      getSourceFile(fileName,languageVersion){const text=read(fileName);if(text===undefined)return undefined;return ts.createSourceFile(fileName,text,languageVersion,true);},
      getDefaultLibFileName:opts=>path.join(VENDOR,ts.getDefaultLibFileName(opts)),
      writeFile(){},getCurrentDirectory:()=>host.root,getDirectories:d=>{try{return fs.readdirSync(d,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);}catch{return[];}},
      fileExists:f=>read(f)!==undefined,readFile:read,directoryExists:d=>{try{return fs.statSync(d).isDirectory();}catch{return false;}},
      getCanonicalFileName:f=>f,useCaseSensitiveFileNames:()=>true,getNewLine:()=>"\n",realpath:f=>{try{return fs.realpathSync(f);}catch{return f;}}
    };
  }
  context(target){
    this.syncGeneration();const {file,doc,offset}=this.docOffset(target);const name=target.name||doc.getText(doc.getWordRangeAtPosition(doc.positionAt(offset))||{start:doc.positionAt(offset),end:doc.positionAt(offset)});
    const {files,matched,truncated}=this.candidateFiles(name,file);const {options,configFile}=this.optionsFor(file);
    const key=[this.generation,configFile||'',name,files.join('|')].join('\n');
    let ctx=this.programs.get(key);
    if(!ctx){
      const started=Date.now();const program=ts.createProgram({rootNames:files.length?files:[file],options,host:this.compilerHost(options)});const checker=program.getTypeChecker();
      ctx={program,checker,files,matched,truncated,configFile,name,buildMs:Date.now()-started};this.programs.set(key,ctx);
      while(this.programs.size>6)this.programs.delete(this.programs.keys().next().value);
    }else{this.programs.delete(key);this.programs.set(key,ctx);}
    const sf=ctx.program.getSourceFile(file);if(!sf)throw new FlowError('SOURCE_NOT_IN_PROGRAM','Selected file could not be loaded into the query-local semantic program.');
    const node=tokenAt(sf,offset);let symbol=canonical(ctx.checker,ctx.checker.getSymbolAtLocation(node));
    if(!symbol&&node?.name)symbol=canonical(ctx.checker,ctx.checker.getSymbolAtLocation(node.name));
    return{...ctx,file,doc,offset,sf,node,symbol};
  }
  loc(file,start,end=start+1,fullStart,fullEnd){const d=this.host.document(file),a=d.positionAt(start),b=d.positionAt(Math.max(start+1,end));const out={uri:pathToFileURL(file).href,file:path.relative(this.host.root,file).replace(/\\/g,'/'),workspace:path.basename(this.host.root),line:a.line+1,column:a.character+1,endLine:b.line+1,endColumn:b.character+1};if(fullStart!==undefined){const x=d.positionAt(fullStart),y=d.positionAt(fullEnd??end);out.fullRange={uri:out.uri,file:out.file,workspace:out.workspace,line:x.line+1,column:x.character+1,endLine:y.line+1,endColumn:y.character+1};}return out;}
  locDecl(decl){const sf=decl.getSourceFile(),name=declNameNode(decl);return this.loc(sf.fileName,name.getStart(sf),name.end,decl.getStart(sf),decl.end);}
  sameSymbol(a,b){return !!a&&!!b&&a===b;}
  definitions(target){const c=this.context(target),items=[];if(c.symbol)for(const d of c.symbol.declarations||[]){if(inside(this.host.root,d.getSourceFile().fileName))items.push(this.locDecl(d));}return{items:this.uniqLoc(items),excluded:0,backend:'query-local-checker',coverage:this.coverage(c)};}
  references(target){
    const c=this.context(target),items=[];if(!c.symbol)return{items,excluded:0,backend:'query-local-checker',coverage:this.coverage(c)};
    for(const sf of c.program.getSourceFiles()){
      if(!inside(this.host.root,sf.fileName)||!TS_SOURCE.test(sf.fileName))continue;
      const visit=n=>{if(ts.isIdentifier(n)||ts.isPrivateIdentifier?.(n)){const sym=canonical(c.checker,c.checker.getSymbolAtLocation(n));if(this.sameSymbol(sym,c.symbol))items.push(this.loc(sf.fileName,n.getStart(sf),n.end));}ts.forEachChild(n,visit);};visit(sf);
    }
    return{items:this.uniqLoc(items),excluded:0,backend:'query-local-checker',coverage:this.coverage(c)};
  }
  implementations(target){
    const c=this.context(target),items=[];if(!c.symbol)return{items,excluded:0,backend:'query-local-checker',coverage:this.coverage(c)};
    for(const sf of c.program.getSourceFiles()){
      if(!inside(this.host.root,sf.fileName)||!TS_SOURCE.test(sf.fileName))continue;
      const visit=n=>{
        if((ts.isClassDeclaration(n)||ts.isClassExpression(n)||ts.isInterfaceDeclaration(n))&&n.name){
          for(const h of n.heritageClauses||[])for(const t of h.types||[]){const sym=canonical(c.checker,c.checker.getSymbolAtLocation(t.expression));if(this.sameSymbol(sym,c.symbol))items.push(this.loc(sf.fileName,n.name.getStart(sf),n.name.end,n.getStart(sf),n.end));}
        }
        ts.forEachChild(n,visit);
      };visit(sf);
    }
    return{items:this.uniqLoc(items),excluded:0,backend:'query-local-checker',coverage:this.coverage(c)};
  }
  callableFromSymbol(symbol){if(!symbol)return null;for(const d of symbol.declarations||[]){const c=callableDecl(d);if(c)return c;}return null;}
  callItemFromDecl(decl,checker){
    const callable=callableDecl(decl)||decl;if(!callable)return null;const sf=callable.getSourceFile();let nameNode=callable.name;
    if(!nameNode&&callable.parent&&ts.isVariableDeclaration(callable.parent))nameNode=callable.parent.name;
    if(!nameNode&&decl?.name)nameNode=decl.name;if(!nameNode)return null;
    const name=declarationName(decl||callable,sf);const loc=this.loc(sf.fileName,nameNode.getStart(sf),nameNode.end,callable.getStart(sf),callable.end);
    return{key:`${loc.uri}:${loc.line}:${loc.column}`,name,kind:11,detail:'',location:loc,opaque:{query:true,file:sf.fileName,start:callable.getStart(sf),end:callable.end,name}};
  }
  prepare(target){const c=this.context(target);let decl=this.callableFromSymbol(c.symbol);if(!decl){const fn=containingCallable(c.node);if(fn)decl=fn;}const item=decl?this.callItemFromDecl(decl,c.checker):null;return{items:item?[item]:[],excluded:0,backend:'query-local-checker',coverage:this.coverage(c)};}
  symbolForCallee(expr,checker){let probe=expr;if(ts.isPropertyAccessExpression(expr))probe=expr.name;else if(ts.isElementAccessExpression(expr))probe=expr.argumentExpression||expr.expression;return canonical(checker,checker.getSymbolAtLocation(probe)||checker.getSymbolAtLocation(expr));}
  calls(item,direction){
    const target={name:item.name,location:item.location},c=this.context(target);let targetSymbol=c.symbol;
    if(!targetSymbol&&item.opaque?.file){const sf=c.program.getSourceFile(item.opaque.file);if(sf){const n=tokenAt(sf,item.opaque.start);targetSymbol=canonical(c.checker,c.checker.getSymbolAtLocation(n));}}
    const targetDecl=this.callableFromSymbol(targetSymbol);if(!targetDecl)return{items:[],excluded:0,backend:'query-local-checker',coverage:this.coverage(c)};
    const out=new Map();
    const add=(neighbor,site)=>{const ci=this.callItemFromDecl(neighbor,c.checker);if(!ci)return;let e=out.get(ci.key);if(!e){e={item:ci,sites:[],totalSites:0};out.set(ci.key,e);}e.totalSites++;if(e.sites.length<10)e.sites.push(site);};
    if(direction==='outgoing'){
      const visit=n=>{if(ts.isCallExpression(n)||ts.isNewExpression(n)){const sym=this.symbolForCallee(n.expression,c.checker),decl=this.callableFromSymbol(sym);if(decl&&inside(this.host.root,decl.getSourceFile().fileName))add(decl,this.loc(n.getSourceFile().fileName,n.expression.getStart(n.getSourceFile()),n.expression.end));}ts.forEachChild(n,visit);};visit(targetDecl.body||targetDecl);
    }else{
      for(const sf of c.program.getSourceFiles()){
        if(!inside(this.host.root,sf.fileName)||!TS_SOURCE.test(sf.fileName))continue;
        const visit=n=>{if(ts.isCallExpression(n)||ts.isNewExpression(n)){const sym=this.symbolForCallee(n.expression,c.checker);if(this.sameSymbol(sym,targetSymbol)){const owner=containingCallable(n);if(owner)add(owner,this.loc(sf.fileName,n.expression.getStart(sf),n.expression.end));}}ts.forEachChild(n,visit);};visit(sf);
      }
    }
    return{items:[...out.values()],excluded:0,backend:'query-local-checker',coverage:this.coverage(c)};
  }
  containingSymbols(location){
    const file=path.resolve(String(location.uri).startsWith('file:')?fileURLToPath(location.uri):location.file),doc=this.host.document(file),offset=doc.offsetAt({line:location.line-1,character:location.column-1});const text=this.host.read(file),sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);const items=[];
    function named(n){if(n.name&&typeof n.name.getText==='function')return n.name;return null;}
    const visit=n=>{if(n.getFullStart()<=offset&&offset<=n.end){const nm=named(n);if(nm&&(isCallable(n)||ts.isClassLike(n)||ts.isInterfaceDeclaration(n)||ts.isVariableDeclaration(n)&&n.initializer&&(ts.isObjectLiteralExpression(n.initializer)||isCallable(n.initializer))))items.push({name:nm.getText(sf),kind:isCallable(n)?11:5,detail:ts.SyntaxKind[n.kind],location:this.loc(file,nm.getStart(sf),nm.end,n.getStart(sf),n.end)});ts.forEachChild(n,visit);}};visit=visit.bind(this);visit(sf);
    items.sort((a,b)=>((a.location.fullRange?.endLine-a.location.fullRange?.line)-(b.location.fullRange?.endLine-b.location.fullRange?.line)));
    return{items,total:items.length,truncated:false,provider:'query-local-parser'};
  }
  findSymbols(args){
    const q=String(args.query||'').toLowerCase(),limit=Math.max(1,Math.min(200,args.limit||30)),hits=[];const pool=this.host.files.filter(f=>TS_SOURCE.test(f));
    for(const file of pool){const text=this.host.read(file);if(!text||!text.toLowerCase().includes(q))continue;const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);const visit=n=>{if(n.name&&ts.isIdentifier(n.name)&&n.name.text.toLowerCase().includes(q)){hits.push({name:n.name.text,kind:isCallable(n)||ts.isFunctionDeclaration(n)?11:5,containerName:'',location:this.loc(file,n.name.getStart(sf),n.name.end,n.getStart(sf),n.end)});if(hits.length>=limit)return;}ts.forEachChild(n,visit);};visit(sf);if(hits.length>=limit)break;}
    return{symbols:hits,totalReturnedByProvider:hits.length,truncated:hits.length>=limit,excluded:0};
  }
  coverage(c){return{candidateFiles:c.files.length,matchedFiles:c.matched,truncated:c.truncated,programBuildMs:c.buildMs,config:c.configFile?path.relative(this.host.root,c.configFile):null};}
  uniqLoc(items){const m=new Map();for(const x of items)m.set(`${x.uri}:${x.line}:${x.column}:${x.endLine}:${x.endColumn}`,x);return[...m.values()];}
  status(){return{backend:'query-local-typescript-checker',generation:this.host.generation,discoveredSourceFiles:this.host.files.filter(f=>TS_SOURCE.test(f)).length,programCache:this.programs.size,candidateCache:this.candidates.size,maxCandidates:this.maxCandidates,warnings:this.host.warnings||[],capabilities:{typescriptJavaScript:'query-local TypeScript checker: definitions/references/calls/owners/implementations',vscodeRequired:false}};}
  invalidate(){this.programs.clear();this.candidates.clear();this.optionsCache.clear();this.generation=-1;}
}
module.exports={QuerySemanticEngine};
