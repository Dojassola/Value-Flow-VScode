'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {fileURLToPath,pathToFileURL}=require('node:url');
const ts=require('../vendor/typescript');
const {inside}=require('./scope');
const {FlowError}=require('./util');
const {BloomFileIndex}=require('./bloom-file-index');
const TS_SOURCE=/\.[cm]?[jt]sx?$/i;
const SKIP=new Set(['node_modules','.git','.next','.nuxt','dist','build','coverage','vendor','.codex','.turbo','out']);
const CALLABLE=new Set([ts.SyntaxKind.FunctionDeclaration,ts.SyntaxKind.FunctionExpression,ts.SyntaxKind.ArrowFunction,ts.SyntaxKind.MethodDeclaration,ts.SyntaxKind.Constructor,ts.SyntaxKind.GetAccessor,ts.SyntaxKind.SetAccessor]);
function callable(n){return !!n&&CALLABLE.has(n.kind)}
function containingCallable(n){for(let p=n;p;p=p.parent)if(callable(p))return p;return null}
function exported(n){
  if(!n)return false;
  if(n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))return true;
  // `export const/let/var` carries the modifier on the VariableStatement, not on
  // the VariableDeclaration, so walk up before giving up.
  if(ts.isVariableDeclaration(n)){const list=n.parent;if(list?.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))return true;return !!list?.parent?.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)}
  return false;
}
function defaulted(n){return !!n?.modifiers?.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword)}
function idText(n){return n&&ts.isIdentifier(n)?n.text:null}
function declarationNameNode(n){if(n?.name&&ts.isIdentifier(n.name))return n.name;return null}
function tokenAt(sf,offset){let best=sf;const visit=n=>{if(n.getFullStart()<=offset&&offset<=n.end){if(n.end-n.getStart(sf)<=best.end-best.getStart(sf))best=n;ts.forEachChild(n,visit)}};visit(sf);if(ts.isIdentifier(best))return best;for(let p=best;p&&p!==sf;p=p.parent){if(ts.isIdentifier(p))return p;if(p.name&&ts.isIdentifier(p.name)&&p.name.getStart(sf)<=offset&&offset<=p.name.end)return p.name}return best}
function sameLoc(a,b){return !!a&&!!b&&a.uri===b.uri&&a.line===b.line&&a.column===b.column}
class InstantSemanticEngine{
  constructor(host,{maxCandidates=260,scanBudgetMs=180,maxPackageFiles=6000,cacheDir=null,log=()=>{}}={}){this.host=host;this.maxCandidates=maxCandidates;this.scanBudgetMs=scanBudgetMs;this.maxPackageFiles=maxPackageFiles;this.searchIndex=new BloomFileIndex(host.root,cacheDir,{log});this.files=new Map();this.packageFiles=new Map();this.optionsCache=new Map();this.candidates=new Map();this.moduleCache=new Map();this.exportCache=new Map();this.referenceCache=new Map();this.generation=-1;}
  sync(){if(this.generation===this.host.generation)return;this.generation=this.host.generation;this.files.clear();this.packageFiles.clear();this.optionsCache.clear();this.candidates.clear();this.moduleCache.clear();this.exportCache.clear();this.referenceCache.clear();}
  fileFromTarget(target){const raw=target?.location?.uri||target?.location?.file||target?.file;if(!raw)throw new FlowError('NO_FILE','Semantic target has no file.');return path.resolve(String(raw).startsWith('file:')?fileURLToPath(raw):raw)}
  loc(file,start,end=start+1,fullStart,fullEnd){const d=this.host.document(file),a=d.positionAt(start),b=d.positionAt(Math.max(start+1,end));const out={uri:pathToFileURL(file).href,file:path.relative(this.host.root,file).replace(/\\/g,'/'),workspace:path.basename(this.host.root),line:a.line+1,column:a.character+1,endLine:b.line+1,endColumn:b.character+1};if(fullStart!==undefined){const x=d.positionAt(fullStart),y=d.positionAt(fullEnd??end);out.fullRange={uri:out.uri,file:out.file,workspace:out.workspace,line:x.line+1,column:x.character+1,endLine:y.line+1,endColumn:y.character+1}}return out}
  info(file){this.sync();file=path.resolve(file);const cached=this.files.get(file);if(cached)return cached;const text=this.host.read(file);if(text===undefined)throw new FlowError('SOURCE_UNAVAILABLE','Source is unavailable to the embedded index.');const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,TS_SOURCE.test(file)&&/x$/i.test(file)?ts.ScriptKind.TSX:ts.ScriptKind.TS);const declarations=[],imports=new Map(),namespaceImports=new Map(),reexports=[],identifiers=new Map(),callables=[],calls=[],heritages=[];
    const addId=n=>{if(!ts.isIdentifier(n))return;let a=identifiers.get(n.text);if(!a)identifiers.set(n.text,a=[]);a.push(n)};
    const addDecl=(nameNode,node,kind,meta={})=>{if(!nameNode||!ts.isIdentifier(nameNode))return;declarations.push({name:nameNode.text,node,nameNode,kind,exported:exported(node)||ts.isVariableDeclaration(node)&&ts.isVariableStatement(node.parent?.parent)&&exported(node.parent.parent),defaulted:defaulted(node),...meta})};
    const visit=n=>{
      if(ts.isIdentifier(n))addId(n);
      if(ts.isImportDeclaration(n)&&ts.isStringLiteralLike(n.moduleSpecifier)){
        const spec=n.moduleSpecifier.text,cl=n.importClause;if(cl?.name)imports.set(cl.name.text,{local:cl.name.text,imported:'default',spec,node:cl.name});
        const nb=cl?.namedBindings;if(nb&&ts.isNamedImports(nb))for(const el of nb.elements)imports.set(el.name.text,{local:el.name.text,imported:el.propertyName?.text||el.name.text,spec,node:el.name});
        if(nb&&ts.isNamespaceImport(nb))namespaceImports.set(nb.name.text,{local:nb.name.text,spec,node:nb.name});
      }
      if(ts.isExportDeclaration(n)){const spec=n.moduleSpecifier&&ts.isStringLiteralLike(n.moduleSpecifier)?n.moduleSpecifier.text:null;if(n.exportClause&&ts.isNamedExports(n.exportClause)){for(const el of n.exportClause.elements)reexports.push({exported:el.name.text,imported:el.propertyName?.text||el.name.text,spec,node:el.name})}else if(spec)reexports.push({exported:'*',imported:'*',spec,node:n.moduleSpecifier})}
      if(ts.isFunctionDeclaration(n)&&n.name){addDecl(n.name,n,'function');callables.push(n)}
      else if(ts.isClassDeclaration(n)&&n.name)addDecl(n.name,n,'class');
      else if(ts.isInterfaceDeclaration(n)&&n.name)addDecl(n.name,n,'interface');
      else if(ts.isTypeAliasDeclaration(n)&&n.name)addDecl(n.name,n,'type');
      else if(ts.isEnumDeclaration(n)&&n.name)addDecl(n.name,n,'enum');
      else if(ts.isMethodDeclaration(n)&&n.name&&ts.isIdentifier(n.name)){addDecl(n.name,n,'method');callables.push(n)}
      else if(ts.isVariableDeclaration(n)){
        const bind=(x)=>{if(ts.isIdentifier(x))addDecl(x,n,'variable',{binding:x});else if(ts.isObjectBindingPattern(x)||ts.isArrayBindingPattern(x))for(const e of x.elements)if(ts.isBindingElement(e))bind(e.name)};bind(n.name);
        if(n.initializer&&callable(n.initializer))callables.push(n.initializer);
      }
      if(ts.isParameter(n)){const bind=x=>{if(ts.isIdentifier(x))addDecl(x,n,'parameter');else if(ts.isObjectBindingPattern(x)||ts.isArrayBindingPattern(x))for(const e of x.elements)if(ts.isBindingElement(e))bind(e.name)};bind(n.name);}
      if((ts.isClassDeclaration(n)||ts.isClassExpression(n)||ts.isInterfaceDeclaration(n))&&n.heritageClauses){for(const h of n.heritageClauses)for(const t of h.types)heritages.push({node:n,type:t.expression,name:ts.isIdentifier(t.expression)?t.expression.text:t.expression.getText(sf)})}
      if(ts.isCallExpression(n)||ts.isNewExpression(n)){let probe=n.expression,name=null;if(ts.isIdentifier(probe))name=probe.text;else if(ts.isPropertyAccessExpression(probe)&&ts.isIdentifier(probe.name))name=probe.name.text;if(name)calls.push({node:n,probe,name,owner:containingCallable(n)})}
      ts.forEachChild(n,visit);
    };visit(sf);const result={file,text,sf,declarations,imports,namespaceImports,reexports,identifiers,callables,calls,heritages};this.files.set(file,result);return result;
  }
  optionsFor(file){let key=this.host.nearbyConfigs(file)[0]||'<default>';if(this.optionsCache.has(key))return this.optionsCache.get(key);let options=this.host.defaultOptions();for(const c of this.host.nearbyConfigs(file)){try{const read=ts.readConfigFile(c,f=>this.host.read(f));if(read.error)continue;const parsed=ts.parseJsonConfigFileContent(read.config,{useCaseSensitiveFileNames:true,fileExists:f=>this.host.readable(f),readFile:f=>this.host.read(f),readDirectory:()=>[]},path.dirname(c),undefined,c);options=this.host.safeOptions(parsed.options);key=c;break}catch{}}this.optionsCache.set(key,options);return options}
  resolveModule(containingFile,spec){if(!spec)return null;const cacheKey=path.resolve(containingFile)+'|'+spec;if(this.moduleCache.has(cacheKey))return this.moduleCache.get(cacheKey);let resolved=null;
    // Relative imports are overwhelmingly common inside an app package. Resolve
    // those with a few direct filesystem probes before invoking TypeScript's
    // general module resolver (paths/package exports/node_modules), which is much
    // more expensive when repeated across hundreds of reference candidates.
    if(spec.startsWith('.')){const base=path.resolve(path.dirname(containingFile),spec);for(const c of [base,base+'.ts',base+'.tsx',base+'.js',base+'.jsx',base+'.mts',base+'.cts',base+'.mjs',base+'.cjs',path.join(base,'index.ts'),path.join(base,'index.tsx'),path.join(base,'index.js'),path.join(base,'index.jsx')])if(this.host.read(c)!==undefined){resolved=path.resolve(c);break}}
    if(!resolved)try{const opts=this.optionsFor(containingFile);const r=ts.resolveModuleName(spec,containingFile,opts,{fileExists:f=>this.host.readable(f),readFile:f=>this.host.read(f),directoryExists:d=>this.host.readable(d,true),realpath:f=>{try{return fs.realpathSync(f)}catch{return f}},getCurrentDirectory:()=>this.host.root,getDirectories:d=>{try{return fs.readdirSync(d,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name)}catch{return[]}}}).resolvedModule?.resolvedFileName;if(r&&inside(this.host.root,r)&&TS_SOURCE.test(r))resolved=path.resolve(r)}catch{}
    this.moduleCache.set(cacheKey,resolved);return resolved}
  exportDefinition(file,name,seen=new Set(),depth=0){if(depth>8)return null;file=path.resolve(file);const sk=file+'|'+name;if(depth===0&&this.exportCache.has(sk))return this.exportCache.get(sk);if(seen.has(sk))return null;seen.add(sk);let inf;try{inf=this.info(file)}catch{return null}
    const finish=v=>{if(depth===0)this.exportCache.set(sk,v);return v};for(const d of inf.declarations){if(name==='default'&&d.defaulted)return finish(this.loc(file,d.nameNode.getStart(inf.sf),d.nameNode.end,d.node.getStart(inf.sf),d.node.end));if(d.name===name&&d.exported)return finish(this.loc(file,d.nameNode.getStart(inf.sf),d.nameNode.end,d.node.getStart(inf.sf),d.node.end))}
    for(const r of inf.reexports){if(r.exported!==name&&r.exported!=='*')continue;if(r.spec){const f=this.resolveModule(file,r.spec);if(!f)continue;const found=this.exportDefinition(f,r.exported==='*'?name:r.imported,seen,depth+1);if(found)return finish(found)}else{const d=inf.declarations.find(x=>x.name===r.imported);if(d)return finish(this.loc(file,d.nameNode.getStart(inf.sf),d.nameNode.end,d.node.getStart(inf.sf),d.node.end))}}
    return finish(null)}
  targetInfo(target){const file=this.fileFromTarget(target),doc=this.host.document(file),offset=doc.offsetAt({line:target.location.line-1,character:target.location.column-1}),inf=this.info(file),token=tokenAt(inf.sf,offset),name=target.name||idText(token)||doc.getText(doc.getWordRangeAtPosition(doc.positionAt(offset))||{start:doc.positionAt(offset),end:doc.positionAt(offset)});return{file,doc,offset,inf,token,name}}
  chooseLocalDeclaration(t){
    const property=t.token.parent&&ts.isPropertyAccessExpression(t.token.parent)&&t.token.parent.name===t.token;
    const list=t.inf.declarations.filter(d=>d.name===t.name&&(!property||d.kind==='method'&&t.token.parent.expression.kind===ts.SyntaxKind.ThisKeyword));
    const scopes=[];for(let n=t.token;n;n=n.parent)scopes.push(n);
    let best=null,bestRank=Infinity,bestAfter=true,bestDistance=Infinity;
    for(const declaration of list){
      if(declaration.nameNode===t.token)return declaration;
      const node=declaration.node,functionScoped=ts.isVariableDeclaration(node)&&!(node.parent.flags&ts.NodeFlags.BlockScoped);let scope=node.parent;
      while(scope&&!ts.isSourceFile(scope)&&!callable(scope)&&(functionScoped||!ts.isBlock(scope)&&!ts.isForStatement(scope)&&!ts.isForOfStatement(scope)&&!ts.isForInStatement(scope)&&!ts.isCatchClause(scope)&&!ts.isClassDeclaration(scope)&&!ts.isClassExpression(scope)&&!ts.isInterfaceDeclaration(scope)))scope=scope.parent;
      const rank=scopes.indexOf(scope);if(rank<0)continue;
      const start=declaration.nameNode.getStart(t.inf.sf),after=start>t.offset,distance=Math.abs(start-t.offset);
      if(rank<bestRank||rank===bestRank&&(after<bestAfter||after===bestAfter&&distance<bestDistance)){best=declaration;bestRank=rank;bestAfter=after;bestDistance=distance;}
    }
    return best;
  }
  definitionMeta(target){const t=this.targetInfo(target),d=this.chooseLocalDeclaration(t);const imp=t.inf.imports.get(t.name);if(imp&&!d){const mod=this.resolveModule(t.file,imp.spec),loc=mod&&this.exportDefinition(mod,imp.imported);if(loc)return{loc,file:path.resolve(fileURLToPath(loc.uri)),name:imp.imported,exported:true,confidence:'module'}}
    if(ts.isIdentifier(t.token)&&t.token.parent&&ts.isPropertyAccessExpression(t.token.parent)&&t.token.parent.name===t.token&&ts.isIdentifier(t.token.parent.expression)){const base=t.token.parent.expression,ns=t.inf.namespaceImports.get(base.text);if(ns&&!this.chooseLocalDeclaration({...t,name:base.text,token:base})){ const mod=this.resolveModule(t.file,ns.spec),loc=mod&&this.exportDefinition(mod,t.name);if(loc)return{loc,file:path.resolve(fileURLToPath(loc.uri)),name:t.name,exported:true,confidence:'module'}}}
    if(d){const loc=this.loc(t.file,d.nameNode.getStart(t.inf.sf),d.nameNode.end,d.node.getStart(t.inf.sf),d.node.end);const locallyExported=t.inf.reexports.some(r=>!r.spec&&r.imported===d.name);return{loc,file:t.file,name:d.name,exported:d.exported||d.defaulted||locallyExported,confidence:'local',decl:d}}
    return{loc:this.loc(t.file,t.token.getStart(t.inf.sf),t.token.end),file:t.file,name:t.name,exported:false,confidence:'position'}
  }
  packageFileList(focusFile){
    this.sync();const root=this.host.nearestPackageRoot(focusFile,null),cached=this.packageFiles.get(root);
    if(cached&&!cached.truncated)return cached;
    const persisted=this.searchIndex.cachedFiles(root).filter(f=>this.host.readable(f));
    const out=[...new Set([path.resolve(focusFile),...persisted])].slice(0,this.maxPackageFiles);
    let truncated=out.length>=this.maxPackageFiles;
    if(out.length<Math.min(400,this.maxPackageFiles)){
      const seen=new Set(out),deadline=Date.now()+Math.max(60,this.scanBudgetMs>>1);
      const walk=dir=>{
        if(out.length>=this.maxPackageFiles||Date.now()>deadline)return;
        let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
        entries.sort((a,b)=>{
          const first=path.join(dir,a.name),second=path.join(dir,b.name);
          const aFocus=first===focusFile||focusFile.startsWith(first+path.sep);
          const bFocus=second===focusFile||focusFile.startsWith(second+path.sep);
          return Number(bFocus)-Number(aFocus)||a.name.localeCompare(b.name);
        });
        for(const entry of entries){
          if(out.length>=this.maxPackageFiles||Date.now()>deadline)return;
          if(entry.isSymbolicLink()||SKIP.has(entry.name))continue;
          const file=path.join(dir,entry.name);
          if(entry.isDirectory())walk(file);
          else if(entry.isFile()&&TS_SOURCE.test(file)&&!seen.has(file)){seen.add(file);out.push(file)}
        }
      };
      walk(root);truncated=out.length>=this.maxPackageFiles||Date.now()>deadline;
    }
    const result={root,files:out,truncated};this.packageFiles.set(root,result);
    this.searchIndex.ensureBackground(root,out,f=>this.host.read(f));
    this.searchIndex.discoverBackground(root,{maxFiles:this.maxPackageFiles,read:f=>this.host.read(f)});
    return result;
  }
  candidateFiles(name,focusFile,extraTerms=[]){
    this.sync();focusFile=path.resolve(focusFile);
    const key=[focusFile,name,...extraTerms].join('\n'),cached=this.candidates.get(key);
    if(cached)return cached;
    const pkg=this.packageFileList(focusFile),terms=[name,...extraTerms].filter(Boolean);
    const indexed=this.searchIndex.candidates(pkg.root,terms,{limit:this.maxPackageFiles,focusFile});
    const known=new Set(this.searchIndex.cachedFiles(pkg.root)),unindexed=pkg.files.filter(file=>!known.has(file));
    const overlays=[...this.host.overlays.keys()].filter(f=>inside(pkg.root,f)&&TS_SOURCE.test(f));
    const files=[...new Set([focusFile,...indexed,...unindexed,...overlays])],folder=path.dirname(focusFile);
    const distance=file=>path.relative(folder,path.dirname(file)).split(path.sep).filter(part=>part==='..').length;
    files.sort((a,b)=>(a===focusFile?-1:distance(a))-(b===focusFile?-1:distance(b)));
    const out=[],deadline=Date.now()+this.scanBudgetMs;let scanned=0,timedOut=false;
    for(const file of files){
      if(out.length>=this.maxCandidates||Date.now()>deadline){timedOut=true;break}
      let text;try{text=this.host.read(file)}catch{}
      scanned++;if(text===undefined)continue;
      this.searchIndex.updateText(pkg.root,file,text);
      if(terms.some(term=>text.includes(term)))out.push(file);
    }
    const indexing=this.searchIndex.status().building>0;
    this.searchIndex.ensureBackground(pkg.root,pkg.files,f=>this.host.read(f));
    this.searchIndex.discoverBackground(pkg.root,{maxFiles:this.maxPackageFiles,read:f=>this.host.read(f)});
    const result={files:out,matched:out.length,scanned,truncated:pkg.truncated||timedOut,indexing};
    if(!result.truncated&&!indexing)this.candidates.set(key,result);
    return result;
  }
  definitions(target){const m=this.definitionMeta(target);return{items:m?.loc?[m.loc]:[],excluded:0,backend:'instant-ast-index',coverage:{candidateFiles:1,matchedFiles:1,truncated:false,confidence:m?.confidence||'none',programBuildMs:0}}}
  localNamesForCanonical(file,canonical){const inf=this.info(file),names=new Set();if(path.resolve(file)===path.resolve(canonical.file))names.add(canonical.name);for(const imp of inf.imports.values()){const mod=this.resolveModule(file,imp.spec);if(!mod)continue;const loc=this.exportDefinition(mod,imp.imported);if(loc&&path.resolve(fileURLToPath(loc.uri))===path.resolve(canonical.file)&&loc.line===canonical.loc.line&&loc.column===canonical.loc.column)names.add(imp.local)}return names}
  references(target){
    const canonical=this.definitionMeta(target);
    if(!canonical)return{items:[],excluded:0,backend:'instant-ast-index',coverage:{candidateFiles:0,matchedFiles:0,truncated:false,programBuildMs:0}};
    const refKey=canonical.loc.uri+':'+canonical.loc.line+':'+canonical.loc.column+':'+canonical.name,cached=this.referenceCache.get(refKey);
    if(cached)return cached;
    const base=path.basename(canonical.file).replace(/\.[^.]+$/,'');
    let cand=canonical.exported?this.candidateFiles(canonical.name,canonical.file,[base]):{files:[canonical.file],matched:1,truncated:false,scanned:1,indexing:false};
    if(canonical.exported){
      const bridgeTerms=new Set();
      for(const file of cand.files){
        if(path.resolve(file)===path.resolve(canonical.file))continue;
        let inf;try{inf=this.info(file)}catch{continue}
        for(const reexport of inf.reexports){
          if(!reexport.spec||reexport.exported!=='*'&&reexport.imported!==canonical.name&&reexport.exported!==canonical.name)continue;
          const module=this.resolveModule(file,reexport.spec);
          const location=module&&this.exportDefinition(module,reexport.exported==='*'?canonical.name:reexport.imported);
          if(!sameLoc(location,canonical.loc))continue;
          if(reexport.exported!=='*')bridgeTerms.add(reexport.exported);
          const filename=path.basename(file).replace(/\.[^.]+$/,'');
          bridgeTerms.add(filename==='index'?path.basename(path.dirname(file)):filename);
        }
      }
      if(bridgeTerms.size)cand=this.candidateFiles(canonical.name,canonical.file,[base,...bridgeTerms]);
    }
    const items=[];
    for(const file of cand.files){
      let inf;try{inf=this.info(file)}catch{continue}
      const names=this.localNamesForCanonical(file,canonical);
      if(!names.size&&file!==canonical.file)continue;
      for(const name of names)for(const node of inf.identifiers.get(name)||[]){
        const parent=node.parent;
        if(parent&&((ts.isImportSpecifier(parent)&&parent.name===node)||(ts.isImportClause(parent)&&parent.name===node)||(ts.isNamespaceImport(parent)&&parent.name===node)))continue;
        const location=this.loc(file,node.getStart(inf.sf),node.end),actual=this.definitionMeta({name,location});
        if(sameLoc(actual?.loc,canonical.loc))items.push(location);
      }
    }
    const result={items:this.uniq(items),excluded:0,backend:'instant-ast-index',coverage:{candidateFiles:cand.files.length,matchedFiles:cand.matched,truncated:cand.truncated,indexing:!!cand.indexing,scannedFiles:cand.scanned,programBuildMs:0,confidence:canonical.confidence}};
    if(!cand.truncated&&!cand.indexing)this.referenceCache.set(refKey,result);
    return result;
  }
  implementations(target){const t=this.targetInfo(target),cand=this.candidateFiles(t.name,t.file),items=[];for(const file of cand.files){let inf;try{inf=this.info(file)}catch{continue}for(const h of inf.heritages)if(h.name===t.name){const n=h.node.name;if(n&&ts.isIdentifier(n))items.push(this.loc(file,n.getStart(inf.sf),n.end,h.node.getStart(inf.sf),h.node.end))}}return{items:this.uniq(items),excluded:0,backend:'instant-ast-index',coverage:{candidateFiles:cand.files.length,matchedFiles:cand.matched,truncated:cand.truncated,scannedFiles:cand.scanned,programBuildMs:0}}}
  callableItem(node,inf){let nameNode=node.name;if(!nameNode&&node.parent&&ts.isVariableDeclaration(node.parent)&&ts.isIdentifier(node.parent.name))nameNode=node.parent.name;if(!nameNode||!ts.isIdentifier(nameNode))return null;const loc=this.loc(inf.file,nameNode.getStart(inf.sf),nameNode.end,node.getStart(inf.sf),node.end);return{key:`${loc.uri}:${loc.line}:${loc.column}`,name:nameNode.text,kind:11,detail:'',location:loc,opaque:{instant:true,file:inf.file,start:node.getStart(inf.sf),end:node.end,name:nameNode.text}}}
  prepare(target){const t=this.targetInfo(target);let node=containingCallable(t.token);if(!node){const d=this.chooseLocalDeclaration(t);if(d&&d.kind==='function')node=d.node;else if(d&&d.kind==='method')node=d.node;else if(d?.node?.initializer&&callable(d.node.initializer))node=d.node.initializer}const item=node&&this.callableItem(node,t.inf);return{items:item?[item]:[],excluded:0,backend:'instant-ast-index',coverage:{candidateFiles:1,matchedFiles:1,truncated:false,programBuildMs:0}}}
  itemForLocation(loc,name){const file=path.resolve(fileURLToPath(loc.uri)),inf=this.info(file),offset=this.host.document(file).offsetAt({line:loc.line-1,character:loc.column-1}),tok=tokenAt(inf.sf,offset);let owner=containingCallable(tok);if(!owner){const d=inf.declarations.find(x=>x.name===name&&Math.abs(x.nameNode.getStart(inf.sf)-offset)<120);if(d&&(d.kind==='function'||d.kind==='method'))owner=d.node}return owner?this.callableItem(owner,inf):null}
  calls(item,direction){const target={name:item.name,location:item.location},t=this.targetInfo(target);let owner=containingCallable(t.token);if(!owner&&item.opaque?.file){const inf=this.info(item.opaque.file);owner=inf.callables.find(c=>c.getStart(inf.sf)===item.opaque.start)||null}if(!owner){const d=this.chooseLocalDeclaration(t);if(d&&(d.kind==='function'||d.kind==='method'))owner=d.node}if(!owner)return{items:[],excluded:0,backend:'instant-ast-index',coverage:{candidateFiles:1,matchedFiles:1,truncated:false,programBuildMs:0}};const ownerItem=this.callableItem(owner,this.info(owner.getSourceFile().fileName));const out=new Map(),add=(ci,site)=>{if(!ci)return;let e=out.get(ci.key);if(!e){e={item:ci,sites:[],totalSites:0};out.set(ci.key,e)}e.totalSites++;if(e.sites.length<10)e.sites.push(site)};
    if(direction==='outgoing'){const inf=this.info(owner.getSourceFile().fileName);for(const c of inf.calls){if(!(owner.getStart(inf.sf)<=c.node.getStart(inf.sf)&&c.node.end<=owner.end))continue;const loc=this.loc(inf.file,c.probe.getStart(inf.sf),c.probe.end);const defs=this.definitions({name:c.name,location:loc}).items;for(const d of defs){const ci=this.itemForLocation(d,c.name);add(ci,loc)}}return{items:[...out.values()],excluded:0,backend:'instant-ast-index',coverage:{candidateFiles:1,matchedFiles:1,truncated:false,programBuildMs:0}}}
    const refs=this.references({name:ownerItem?.name||item.name,location:ownerItem?.location||item.location});for(const loc of refs.items){const file=path.resolve(fileURLToPath(loc.uri)),inf=this.info(file),off=this.host.document(file).offsetAt({line:loc.line-1,character:loc.column-1}),tok=tokenAt(inf.sf,off);let callNode=null;for(let p=tok;p&&p!==inf.sf;p=p.parent){if(ts.isCallExpression(p)||ts.isNewExpression(p)){callNode=p;break}if(callable(p))break}if(!callNode)continue;const caller=containingCallable(callNode);if(caller)add(this.callableItem(caller,inf),loc)}return{items:[...out.values()],excluded:0,backend:'instant-ast-index',coverage:refs.coverage}
  }
  containingSymbols(location){const file=path.resolve(String(location.uri).startsWith('file:')?fileURLToPath(location.uri):location.file),inf=this.info(file),off=this.host.document(file).offsetAt({line:location.line-1,character:location.column-1}),tok=tokenAt(inf.sf,off),items=[];for(let p=tok;p&&p!==inf.sf;p=p.parent){if(callable(p)){const ci=this.callableItem(p,inf);if(ci)items.push({name:ci.name,kind:11,detail:'callable',location:ci.location})}else if((ts.isClassDeclaration(p)||ts.isInterfaceDeclaration(p))&&p.name){items.push({name:p.name.text,kind:5,detail:ts.SyntaxKind[p.kind],location:this.loc(file,p.name.getStart(inf.sf),p.name.end,p.getStart(inf.sf),p.end)})}}return{items,total:items.length,truncated:false,provider:'instant-ast-index'}}
  findSymbols(args){const q=String(args.query||'').toLowerCase(),limit=Math.max(1,Math.min(200,args.limit||30)),focus=args.file?path.resolve(args.file):this.host.initialFocus||this.host.root,pkg=this.packageFileList(focus),hits=[];for(const file of pkg.files){if(hits.length>=limit)break;let inf;try{inf=this.info(file)}catch{continue}for(const d of inf.declarations)if(d.name.toLowerCase().includes(q)){hits.push({name:d.name,kind:d.kind==='function'||d.kind==='method'?11:5,containerName:'',location:this.loc(file,d.nameNode.getStart(inf.sf),d.nameNode.end,d.node.getStart(inf.sf),d.node.end)});if(hits.length>=limit)break}}return{symbols:hits,totalReturnedByProvider:hits.length,truncated:hits.length>=limit,excluded:0}}
  uniq(items){const m=new Map();for(const x of items)m.set(`${x.uri}:${x.line}:${x.column}:${x.endLine}:${x.endColumn}`,x);return[...m.values()]}
  status(){return{backend:'persistent-bloom-ast-index',searchIndex:this.searchIndex.status(),generation:this.host.generation,parsedFiles:this.files.size,packageCaches:this.packageFiles.size,maxCandidates:this.maxCandidates,scanBudgetMs:this.scanBudgetMs,warnings:this.host.warnings||[],capabilities:{typescriptJavaScript:'persistent Bloom prefilter + AST/module confirmation for definitions/references/calls/owners/implementations',vscodeRequired:false}}}
  invalidate(){this.generation=-1;this.files.clear();this.packageFiles.clear();this.optionsCache.clear()}
}
module.exports={InstantSemanticEngine};
