'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
const {fileURLToPath,pathToFileURL}=require('node:url');
const ts=require('../vendor/typescript');
const {FlowError}=require('./util');
const {valueContext}=require('./value-context');
function hash(x){return crypto.createHash('sha1').update(String(x)).digest('hex').slice(0,14);}
function scriptKind(file){return /\.tsx$/i.test(file)?ts.ScriptKind.TSX:/\.jsx$/i.test(file)?ts.ScriptKind.JSX:/\.[cm]?js$/i.test(file)?ts.ScriptKind.JS:ts.ScriptKind.TS;}
function tokenAt(sf,pos){let best=sf;function v(n){if(n.getFullStart()<=pos&&pos<=n.end){if(n.end-n.getStart(sf)<=best.end-best.getStart(sf))best=n;ts.forEachChild(n,v);}}v(sf);if(ts.isIdentifier(best))return best;for(let p=best;p&&p!==sf;p=p.parent)if(ts.isIdentifier(p))return p;return best;}
function callable(n){return !!n&&(ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isArrowFunction(n)||ts.isMethodDeclaration(n)||ts.isConstructorDeclaration(n));}
function containingFunction(n){for(let p=n;p;p=p.parent)if(callable(p))return p;return null;}
function bindingNames(name,out=[]){if(ts.isIdentifier(name))out.push(name.text);else if(ts.isObjectBindingPattern(name)||ts.isArrayBindingPattern(name))for(const e of name.elements)if(ts.isBindingElement(e))bindingNames(e.name,out);return out;}
function pathInBinding(name,target,path=[]){if(ts.isIdentifier(name))return name.text===target?path:null;if(ts.isArrayBindingPattern(name)){for(let i=0;i<name.elements.length;i++){const e=name.elements[i];if(!ts.isBindingElement(e))continue;const r=pathInBinding(e.name,target,[...path,{kind:'index',key:i}]);if(r)return r;}}if(ts.isObjectBindingPattern(name)){for(const e of name.elements){if(!ts.isBindingElement(e))continue;const key=(e.propertyName||e.name).getText().replace(/^['"]|['"]$/g,'');const r=pathInBinding(e.name,target,[...path,{kind:'property',key}]);if(r)return r;}}return null;}
class QuickValueTracer{
  constructor(host,instant){this.host=host;this.instant=instant;this.cache=new Map();}
  source(file){file=path.resolve(file);let c=this.cache.get(file);const text=this.host.read(file);if(text==null)throw new FlowError('VALUE_FILE_UNAVAILABLE','Selected source file is unavailable.');if(c&&c.text===text)return c;const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,scriptKind(file));c={file,text,sf,doc:this.host.document(file)};this.cache.set(file,c);return c;}
  loc(file,start,end=start+1){const d=this.host.document(file),a=d.positionAt(start),b=d.positionAt(Math.max(start+1,end));return{uri:pathToFileURL(file).href,file:path.relative(this.host.root,file).replace(/\\/g,'/'),workspace:path.basename(this.host.root),line:a.line+1,column:a.character+1,endLine:b.line+1,endColumn:b.character+1};}
  snippet(c,node,exact=false){let n=node;if(!exact)for(let p=node;p;p=p.parent){if(ts.isStatement(p)||ts.isVariableDeclaration(p)||ts.isParameter(p)){n=p;break;}if(callable(p)){n=p;break;}}const start=n.getStart(c.sf),signature=exact&&callable(n)&&n.body&&ts.isBlock(n.body),end=Math.min(signature?n.body.getStart(c.sf)+1:n.end,start+1400),a=c.doc.positionAt(start);return{code:c.text.slice(start,end)+(signature?' …':''),sourceStartLine:a.line+1};}
  budget(graph){if(Date.now()>=graph.deadline){graph.cutoffs.add('timeBudget');throw new FlowError('VALUE_TRACE_LIMIT',`Value trace stopped after its ${graph.timeBudgetMs} ms budget; the graph is partial.`);}}
  add(graph,c,node,name,role='value',layer=0,meta={}){
    if(graph.nodeMap.size)this.budget(graph);
    const start=node.getStart(c.sf),id='qv:'+hash(c.file+':'+start+':'+name+':'+role);
    if(!graph.nodeMap.has(id)){
      if(graph.nodeMap.size>=graph.maxNodes){graph.cutoffs.add('maxNodes');throw new FlowError('VALUE_TRACE_LIMIT',`Value trace stopped at ${graph.maxNodes} nodes; the graph is partial.`);}
      const sn=this.snippet(c,node,['origin','condition','argument','callback'].includes(role)),selection=ts.isPropertyAccessExpression(node)?node.name:node;
      graph.nodeMap.set(id,{id,type:'value',role,name,location:this.loc(c.file,selection.getStart(c.sf),selection.end),code:sn.code,sourceStartLine:sn.sourceStartLine,layer,...valueContext(node),...meta});
    }
    return graph.nodeMap.get(id);
  }
  edge(graph,a,b,type,label=type){if(!a||!b||a.id===b.id)return;const id='qve:'+hash(a.id+'|'+b.id+'|'+type);if(!graph.edgeMap.has(id))graph.edgeMap.set(id,{id,from:a.id,to:b.id,type,label});}
  conditionUse(graph,c,parent,use,root,depth){
    if((ts.isPrefixUnaryExpression(parent)||ts.isPostfixUnaryExpression(parent))&&(parent.operator===ts.SyntaxKind.PlusPlusToken||parent.operator===ts.SyntaxKind.MinusMinusToken)&&parent.operand===use){const mutation=this.add(graph,c,parent,parent.getText(c.sf),'transformation',depth,{valueKind:'mutation'});this.edge(graph,root,mutation,'assign','updates value');return true;}
    const expression=ts.isIfStatement(parent)||ts.isWhileStatement(parent)||ts.isDoStatement(parent)||ts.isSwitchStatement(parent)?parent.expression:ts.isForStatement(parent)?parent.condition:null;
    if(!expression||use.getStart(c.sf)<expression.getStart(c.sf)||use.end>expression.end)return false;
    const condition=this.add(graph,c,expression,expression.getText(c.sf),'condition',depth,{valueKind:'condition'});
    this.edge(graph,root,condition,'condition','tests value');return true;
  }
  lexicalDecl(c,name,useOffset){
    if(!c.declarations){
      c.declarations=new Map();
      const visit=n=>{const names=(ts.isVariableDeclaration(n)||ts.isParameter(n)||ts.isBindingElement(n))?bindingNames(n.name):ts.isFunctionDeclaration(n)&&n.name?[n.name.text]:[];for(const key of names){if(!c.declarations.has(key))c.declarations.set(key,[]);c.declarations.get(key).push(n);}ts.forEachChild(n,visit);};visit(c.sf);
    }
    // Pattern bindings are indexed twice (the owning declaration and the binding
    // element). Canonicalize to the owner so a lookup at the declaration site and
    // one at a body use return the same node; otherwise === comparisons in
    // propagateName silently see zero uses.
    const ownerOf=d=>{let o=d;while(ts.isBindingElement(o)||ts.isObjectBindingPattern(o)||ts.isArrayBindingPattern(o))o=o.parent;return o||d;};
    const use=tokenAt(c.sf,useOffset),scopes=[];for(let p=use;p;p=p.parent)scopes.push(p);
    let best=null,bestRank=Infinity,bestAfter=true,bestDistance=Infinity;
    for(const decl of c.declarations.get(name)||[]){
      if(decl.name===use)return ownerOf(decl);
      let owner=decl;while(ts.isBindingElement(owner)||ts.isObjectBindingPattern(owner)||ts.isArrayBindingPattern(owner))owner=owner.parent;
      const functionScoped=ts.isVariableDeclaration(owner)&&!(owner.parent.flags&ts.NodeFlags.BlockScoped);let scope=owner.parent;
      while(scope&&!ts.isSourceFile(scope)&&!callable(scope)&&(functionScoped||!ts.isBlock(scope)&&!ts.isForStatement(scope)&&!ts.isForOfStatement(scope)&&!ts.isForInStatement(scope)&&!ts.isCatchClause(scope)))scope=scope.parent;
      const rank=scopes.indexOf(scope);if(rank<0)continue;
      const start=decl.name.getStart(c.sf),after=start>useOffset,distance=Math.abs(start-useOffset);
      if(rank<bestRank||rank===bestRank&&(after<bestAfter||after===bestAfter&&distance<bestDistance)){best=decl;bestRank=rank;bestAfter=after;bestDistance=distance;}
    }
    return best?ownerOf(best):null;
  }
  applyPath(expr,path){let n=expr;for(const p of path||[]){if(!n)break;if(p.kind==='index'){if(ts.isArrayLiteralExpression(n))n=n.elements[p.key];else return{node:n,label:`index [${p.key}]`,opaque:true};}else if(p.kind==='property'){if(ts.isObjectLiteralExpression(n)){const prop=n.properties.find(x=>ts.isPropertyAssignment(x)&&x.name.getText().replace(/^['"]|['"]$/g,'')===p.key||ts.isShorthandPropertyAssignment(x)&&x.name.text===p.key);n=ts.isPropertyAssignment(prop)?prop.initializer:prop?.name;}else return{node:n,label:`property .${p.key}`,opaque:true};}}return{node:n||expr,opaque:!n};}
  findReturns(fn){if(ts.isArrowFunction(fn)&&fn.body&&!ts.isBlock(fn.body))return[fn.body];const out=[];function v(n){if(n!==fn&&callable(n))return;if(ts.isReturnStatement(n)&&n.expression)out.push(n.expression);ts.forEachChild(n,v);}v(fn.body||fn);return out;}
  async callableDefinition(callee,currentFile){if(!callee)return null;let name=null,probe=callee;if(ts.isPropertyAccessExpression(callee)){name=callee.name.text;probe=callee.name;}else if(ts.isIdentifier(callee))name=callee.text;else return null;const current=this.source(currentFile);const local=this.lexicalDecl(current,name,probe.getStart(current.sf));if(local){let fn=local;if(ts.isVariableDeclaration(local)&&local.initializer&&callable(local.initializer))fn=local.initializer;if(callable(fn))return{c:current,fn};}
    try{const location=this.loc(currentFile,probe.getStart(current.sf),probe.end),defs=this.instant.definitions({name,location}).items||[];for(const d of defs.slice(0,4)){const file=fileURLToPath(d.uri),c=this.source(file),off=c.doc.offsetAt({line:d.line-1,character:d.column-1}),tok=tokenAt(c.sf,off);for(let p=tok;p&&p!==c.sf;p=p.parent){if(callable(p))return{c,fn:p};if(ts.isVariableDeclaration(p)&&p.initializer&&callable(p.initializer))return{c,fn:p.initializer};}}}catch{}return null;}
  async sourceExpr(graph,c,expr,child,depth,maxDepth,seen,valuePath=[],reuseChild=false){if(!expr)return;if(depth>maxDepth){graph.cutoffs.add('depth');return;}this.budget(graph);while(ts.isParenthesizedExpression(expr)||ts.isAsExpression(expr)||ts.isNonNullExpression(expr)||ts.isAwaitExpression(expr))expr=expr.expression;
    if(valuePath.length&&(ts.isObjectLiteralExpression(expr)||ts.isArrayLiteralExpression(expr))){const applied=this.applyPath(expr,valuePath);if(applied.opaque)return;if(applied.node!==expr)return this.sourceExpr(graph,c,applied.node,child,depth,maxDepth,seen,[],reuseChild);}
    const text=callable(expr)?this.snippet(c,expr,true).code:expr.getText(c.sf),n=reuseChild?child:this.add(graph,c,expr,text,'origin',-depth,{valueKind:ts.SyntaxKind[expr.kind]});this.edge(graph,n,child,'flows_to','flows to');
    if(ts.isIdentifier(expr)){
      const key=c.file+':'+expr.text+':'+expr.getStart(c.sf)+':'+JSON.stringify(valuePath);
      if(seen.has(key))return;seen.add(key);
      const decl=this.lexicalDecl(c,expr.text,expr.getStart(c.sf));
      if(decl){await this.sourceDecl(graph,c,decl,expr.text,n,depth+1,maxDepth,seen,valuePath);return;}
      let defs=[];try{defs=this.instant.definitions({name:expr.text,location:this.loc(c.file,expr.getStart(c.sf),expr.end)}).items||[];}catch{return;}
      for(const d of defs.slice(0,4)){
        let dc;try{dc=this.source(fileURLToPath(d.uri));}catch{continue;}
        const off=dc.doc.offsetAt({line:d.line-1,character:d.column-1});if(dc.file===c.file)continue;
        const dt=tokenAt(dc.sf,off);if(!ts.isIdentifier(dt))continue;
        const imported=this.lexicalDecl(dc,dt.text,off);if(imported)await this.sourceDecl(graph,dc,imported,dt.text,n,depth+1,maxDepth,seen,valuePath);
      }
      return;
    }
    if(ts.isPropertyAccessExpression(expr)){await this.sourceExpr(graph,c,expr.expression,n,depth,maxDepth,seen,[{kind:'property',key:expr.name.text},...valuePath]);return;}
    if(ts.isElementAccessExpression(expr)){await this.sourceExpr(graph,c,expr.expression,n,depth+1,maxDepth,seen);await this.sourceExpr(graph,c,expr.argumentExpression,n,depth+1,maxDepth,seen);return;}
    if(ts.isBinaryExpression(expr)){await this.sourceExpr(graph,c,expr.left,n,depth+1,maxDepth,seen);await this.sourceExpr(graph,c,expr.right,n,depth+1,maxDepth,seen);return;}
    if(ts.isConditionalExpression(expr)){const condition=this.add(graph,c,expr.condition,expr.condition.getText(c.sf),'condition',-depth-1,{valueKind:'condition'});this.edge(graph,condition,n,'condition','chooses branch');await this.sourceExpr(graph,c,expr.condition,condition,depth+1,maxDepth,seen,[],true);await this.sourceExpr(graph,c,expr.whenTrue,n,depth+1,maxDepth,seen,valuePath);await this.sourceExpr(graph,c,expr.whenFalse,n,depth+1,maxDepth,seen,valuePath);return;}
    if(ts.isObjectLiteralExpression(expr)){for(const p of expr.properties){if(ts.isPropertyAssignment(p))await this.sourceExpr(graph,c,p.initializer,n,depth+1,maxDepth,seen);else if(ts.isShorthandPropertyAssignment(p))await this.sourceExpr(graph,c,p.name,n,depth+1,maxDepth,seen);}return;}
    if(ts.isArrayLiteralExpression(expr)){for(const e of expr.elements.slice(0,20))await this.sourceExpr(graph,c,e,n,depth+1,maxDepth,seen);return;}
    if(ts.isCallExpression(expr)||ts.isNewExpression(expr)){for(const a of expr.arguments||[])await this.sourceExpr(graph,c,a,n,depth+1,maxDepth,seen);this.budget(graph);const resolved=await this.callableDefinition(expr.expression,c.file);if(resolved){const retNode=this.add(graph,resolved.c,resolved.fn,(resolved.fn.name?.getText(resolved.c.sf)||expr.expression.getText(c.sf))+' return','return',-depth-1);this.edge(graph,retNode,n,'call_return','returns');for(const r of this.findReturns(resolved.fn).slice(0,12))await this.sourceExpr(graph,resolved.c,r,retNode,depth+1,maxDepth,seen,valuePath);}return;}
  }
  async callbackParameterOrigins(graph,c,decl,name,child,depth,maxDepth,seen,valuePath=[]){this.budget(graph);let p=decl;while(p&&!ts.isParameter(p)&&p!==c.sf)p=p.parent;if(!p||!ts.isParameter(p))return false;const fn=containingFunction(p);if(!fn)return false;const paramIndex=fn.parameters.indexOf(p),bindPath=[...(pathInBinding(p.name,name)||[]),...valuePath];
    if((ts.isArrowFunction(fn)||ts.isFunctionExpression(fn))&&ts.isCallExpression(fn.parent)){const outer=fn.parent,argIndex=outer.arguments.indexOf(fn),resolved=await this.callableDefinition(outer.expression,c.file);if(resolved&&argIndex>=0){const cbParam=resolved.fn.parameters?.[argIndex];if(cbParam&&ts.isIdentifier(cbParam.name)){const cbName=cbParam.name.text;const calls=[];function scan(n){if(n!==resolved.fn&&callable(n))return;if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text===cbName)calls.push(n);ts.forEachChild(n,scan);}scan(resolved.fn.body||resolved.fn);for(const call of calls.slice(0,20)){const arg=call.arguments[paramIndex];if(!arg)continue;const applied=this.applyPath(arg,bindPath),bridge=this.add(graph,resolved.c,arg,`${cbName} callback argument #${paramIndex+1}`,'callback',-depth,{destructurePath:bindPath});this.edge(graph,bridge,child,'callback_argument','callback argument');await this.sourceExpr(graph,resolved.c,applied.node,bridge,depth+1,maxDepth,seen,applied.opaque?bindPath:[]);}if(calls.length)return true;}}}
    // Named function parameter: inspect call sites and map positional arguments.
    let fnName=fn.name?.text;if(!fnName&&ts.isVariableDeclaration(fn.parent)&&ts.isIdentifier(fn.parent.name))fnName=fn.parent.name.text;if(fnName){try{const fnLoc=this.loc(c.file,(fn.name||fn.parent.name).getStart(c.sf),(fn.name||fn.parent.name).end),refs=this.instant.references({name:fnName,location:fnLoc}).items||[];for(const r of refs.slice(0,80)){const rc=this.source(fileURLToPath(r.uri)),off=rc.doc.offsetAt({line:r.line-1,character:r.column-1}),tok=tokenAt(rc.sf,off);let call=null;for(let q=tok;q&&q!==rc.sf;q=q.parent)if(ts.isCallExpression(q)){call=q;break;}if(!call)continue;const arg=call.arguments[paramIndex];if(!arg)continue;const applied=this.applyPath(arg,bindPath),bridge=this.add(graph,rc,arg,`argument #${paramIndex+1} -> ${name}`,'argument',-depth);this.edge(graph,bridge,child,'argument','argument');await this.sourceExpr(graph,rc,applied.node,bridge,depth+1,maxDepth,seen,applied.opaque?bindPath:[]);}}catch(error){if(error.code==='VALUE_TRACE_LIMIT')throw error;}return true;}return false;
  }
  async sourceDecl(graph,c,decl,name,child,depth,maxDepth,seen,valuePath=[]){
    if(depth>maxDepth){graph.cutoffs.add('depth');return;}this.budget(graph);
    let variable=decl;while(ts.isBindingElement(variable)||ts.isObjectBindingPattern(variable)||ts.isArrayBindingPattern(variable))variable=variable.parent;
    const offset=child.location.uri===pathToFileURL(c.file).href?c.doc.offsetAt({line:child.location.line-1,character:child.location.column-1}):-1;
    const atBinding=variable.name&&child.name===name&&offset>=variable.name.getStart(c.sf)&&offset<variable.name.end;
    if(ts.isVariableDeclaration(variable)&&variable.initializer){
      const d=atBinding?child:this.add(graph,c,decl,`${name} declaration`,'declaration',-depth);
      this.edge(graph,d,child,'assign','declares');
      await this.sourceExpr(graph,c,variable.initializer,d,depth+1,maxDepth,seen,[...(pathInBinding(variable.name,name)||[]),...valuePath],true);return;
    }
    if(ts.isBindingElement(decl)||ts.isParameter(decl)){
      if(await this.callbackParameterOrigins(graph,c,decl,name,child,depth,maxDepth,seen,valuePath))return;
      let p=decl;while(p&&!ts.isParameter(p)&&p!==c.sf)p=p.parent;
      if(p&&ts.isParameter(p)){const d=atBinding?child:this.add(graph,c,p,`${name} parameter`,'parameter',-depth);this.edge(graph,d,child,'parameter','parameter');}
    }
  }
  containsName(node,name){let found=false;function v(n){if(found)return;if(ts.isIdentifier(n)&&n.text===name){found=true;return;}ts.forEachChild(n,v);}v(node);return found;}
  functionName(fn,c){if(fn?.name&&ts.isIdentifier(fn.name))return fn.name.text;if(fn?.parent&&ts.isVariableDeclaration(fn.parent)&&ts.isIdentifier(fn.parent.name))return fn.parent.name.text;return null;}
  async propagateCallReturn(graph,resolved,retNode,depth,maxDepth,seen){const fnName=this.functionName(resolved.fn,resolved.c);if(!fnName)return;if(depth>maxDepth){graph.cutoffs.add('depth');return;}let refs=[];try{const nameNode=resolved.fn.name||(ts.isVariableDeclaration(resolved.fn.parent)?resolved.fn.parent.name:null);if(!nameNode)return;refs=this.instant.references({name:fnName,location:this.loc(resolved.c.file,nameNode.getStart(resolved.c.sf),nameNode.end)}).items||[];}catch{}for(const r of refs.slice(0,80)){let rc;try{rc=this.source(fileURLToPath(r.uri));}catch{continue}const off=rc.doc.offsetAt({line:r.line-1,character:r.column-1}),tok=tokenAt(rc.sf,off);let call=null;for(let p=tok;p&&p!==rc.sf;p=p.parent){if(ts.isCallExpression(p)||ts.isNewExpression(p)){call=p;break;}if(callable(p))break;}if(!call)continue;const resultNode=this.add(graph,rc,call,`${fnName} return`,'return',depth);this.edge(graph,retNode,resultNode,'call_return','call return');const par=call.parent;if(ts.isVariableDeclaration(par)&&ts.isIdentifier(par.name)){const n=this.add(graph,rc,par,par.name.text,'destination',depth+1,{valueKind:'symbol'});this.edge(graph,resultNode,n,'assign','assigned result');await this.propagateName(graph,rc,par.name.text,containingFunction(par),n,depth+1,maxDepth,seen);}else if(ts.isBinaryExpression(par)&&par.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(par.left)){const n=this.add(graph,rc,par,par.left.text,'destination',depth+1,{valueKind:'symbol'});this.edge(graph,resultNode,n,'assign','assigned result');await this.propagateName(graph,rc,par.left.text,containingFunction(par),n,depth+1,maxDepth,seen);}else if(ts.isReturnStatement(par)){const n=this.add(graph,rc,par,'return','return',depth+1);this.edge(graph,resultNode,n,'return','return');}}}
  async propagateParameter(graph,resolved,index,fromNode,depth,maxDepth,seen,propName=null){if(depth>maxDepth){graph.cutoffs.add('depth');return;}const p=resolved.fn.parameters?.[index];if(!p)return;if(propName&&ts.isIdentifier(p.name)){const propertyNode=this.add(graph,resolved.c,p,`${this.functionName(resolved.fn,resolved.c)||'component'}.${propName}`,'parameter',depth,{valueKind:'symbol'});this.edge(graph,fromNode,propertyNode,'jsx_prop','JSX prop');await this.propagateProperty(graph,resolved.c,resolved.fn,p.name.text,propName,propertyNode,depth+1,maxDepth,seen);return;}let names=bindingNames(p.name,[]);if(propName&&ts.isObjectBindingPattern(p.name)){const el=p.name.elements.find(e=>ts.isBindingElement(e)&&(e.propertyName||e.name).getText(resolved.c.sf).replace(/^['"]|['"]$/g,'')===propName);if(el)names=bindingNames(el.name,[]);}for(const name of names){const n=this.add(graph,resolved.c,p,name,'parameter',depth,{valueKind:'symbol'});this.edge(graph,fromNode,n,propName?'jsx_prop':'argument',propName?'JSX prop':'argument');await this.propagateName(graph,resolved.c,name,resolved.fn,n,depth+1,maxDepth,seen);}}
  async propagateProperty(graph,c,fn,base,prop,root,depth,maxDepth,seen){if(depth>maxDepth){graph.cutoffs.add('depth');return;}const key=`prop:${c.file}:${fn.getStart(c.sf)}:${base}.${prop}`;if(seen.has(key))return;seen.add(key);const uses=[];function scan(n){if(n!==fn&&callable(n))return;if(ts.isPropertyAccessExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text===base&&n.name.text===prop)uses.push(n);ts.forEachChild(n,scan);}scan(fn.body||fn);for(const use of uses){const n=this.add(graph,c,use,`${this.functionName(fn,c)||'component'}.${prop}`,'value',depth,{valueKind:'property'});this.edge(graph,root,n,'property_read','property read');await this.propagateExpressionUse(graph,c,use,n,depth+1,maxDepth,seen);}}
  async propagateExpressionUse(graph,c,use,root,depth,maxDepth,seen){if(depth>maxDepth){graph.cutoffs.add('depth');return;}for(let p=use.parent;p&&p!==c.sf;p=p.parent){if(this.conditionUse(graph,c,p,use,root,depth))return;if(ts.isVariableDeclaration(p)&&p.initializer&&use.getStart(c.sf)>=p.initializer.getStart(c.sf)&&use.end<=p.initializer.end&&ts.isIdentifier(p.name)){const n=this.add(graph,c,p,p.name.text,'destination',depth,{valueKind:'symbol'});this.edge(graph,root,n,'assign','assignment');return this.propagateName(graph,c,p.name.text,containingFunction(p),n,depth+1,maxDepth,seen);}if(ts.isReturnStatement(p)){const fn=containingFunction(p),n=this.add(graph,c,p,(this.functionName(fn,c)||'function')+' return','return',depth);this.edge(graph,root,n,'return','return');if(fn)await this.propagateCallReturn(graph,{c,fn},n,depth+1,maxDepth,seen);return;}if(ts.isCallExpression(p)){const idx=p.arguments.findIndex(a=>use.getStart(c.sf)>=a.getStart(c.sf)&&use.end<=a.end);if(idx>=0){const resolved=await this.callableDefinition(p.expression,c.file);const n=this.add(graph,c,p.arguments[idx],`argument #${idx+1}`,'argument',depth,{callee:p.expression.getText(c.sf),resolvedCallee:!!resolved});this.edge(graph,root,n,'argument','argument');if(resolved)await this.propagateParameter(graph,resolved,idx,n,depth+1,maxDepth,seen);else graph.cutoffs.add('unresolvedCall');return;}}if(ts.isJsxAttribute(p)){return;}if(ts.isStatement(p))break;}}
  async jsxDestination(graph,c,attr,root,depth,maxDepth,seen){let opening=attr.parent?.parent;if(!opening||( !ts.isJsxOpeningElement(opening)&&!ts.isJsxSelfClosingElement(opening)))return;const tag=opening.tagName,tagName=tag.getText(c.sf).split('.')[0],prop=attr.name.getText(c.sf);let resolved=null;if(ts.isIdentifier(tag)){const defs=this.instant.definitions({name:tag.text,location:this.loc(c.file,tag.getStart(c.sf),tag.end)}).items||[];for(const d of defs.slice(0,3)){try{const cc=this.source(fileURLToPath(d.uri)),off=cc.doc.offsetAt({line:d.line-1,character:d.column-1}),tok=tokenAt(cc.sf,off);for(let q=tok;q&&q!==cc.sf;q=q.parent){if(callable(q)){resolved={c:cc,fn:q};break;}if(ts.isVariableDeclaration(q)&&q.initializer&&callable(q.initializer)){resolved={c:cc,fn:q.initializer};break;}}if(resolved)break;}catch{}}}if(!resolved)return;const bridge=this.add(graph,c,attr,`${tagName}.${prop}`,'destination',depth,{valueKind:'jsx-prop'});this.edge(graph,root,bridge,'jsx_prop','JSX prop');await this.propagateParameter(graph,resolved,0,bridge,depth+1,maxDepth,seen,prop);}
  async propagateName(graph,c,name,fn,root,depth,maxDepth,seen,useOffset=c.doc.offsetAt({line:root.location.line-1,character:root.location.column-1})){if(depth>maxDepth){graph.cutoffs.add('depth');return;}this.budget(graph);fn=fn||c.sf;const key=`name:${c.file}:${fn.getStart(c.sf)}:${name}`;if(seen.has(key))return;seen.add(key);const binding=this.lexicalDecl(c,name,useOffset),uses=[],tracer=this;function scan(n){if(n!==fn&&callable(n)&&fn!==c.sf)return;if(ts.isIdentifier(n)&&n.text===name&&tracer.lexicalDecl(c,name,n.getStart(c.sf))===binding)uses.push(n);ts.forEachChild(n,scan);}scan(fn.body||fn);for(const use of uses){if(ts.isPropertyAccessExpression(use.parent)&&use.parent.name===use||ts.isPropertyAssignment(use.parent)&&use.parent.name===use)continue;if(use.parent&&((ts.isParameter(use.parent)&&use.parent.name===use)||(ts.isVariableDeclaration(use.parent)&&use.parent.name===use)))continue;let handled=false;for(let p=use.parent;p&&p!==fn;p=p.parent){if(this.conditionUse(graph,c,p,use,root,depth)){handled=true;break;}if(ts.isJsxExpression(p)&&ts.isJsxAttribute(p.parent)){await this.jsxDestination(graph,c,p.parent,root,depth,maxDepth,seen);handled=true;break;}if(ts.isCallExpression(p)||ts.isNewExpression(p)){const idx=p.arguments.findIndex(a=>use.getStart(c.sf)>=a.getStart(c.sf)&&use.end<=a.end);if(idx>=0){const resolved=await this.callableDefinition(p.expression,c.file);const n=this.add(graph,c,p.arguments[idx],`argument #${idx+1}`,'argument',depth,{callee:p.expression.getText(c.sf),resolvedCallee:!!resolved});this.edge(graph,root,n,'argument','argument');if(resolved)await this.propagateParameter(graph,resolved,idx,n,depth+1,maxDepth,seen);else graph.cutoffs.add('unresolvedCall');handled=true;break;}}if(ts.isVariableDeclaration(p)&&p.initializer&&ts.isIdentifier(p.name)){const n=this.add(graph,c,p,p.name.text,'destination',depth,{valueKind:'symbol'});this.edge(graph,root,n,'assign','assignment');await this.propagateName(graph,c,p.name.text,containingFunction(p),n,depth+1,maxDepth,seen);handled=true;break;}if(ts.isBinaryExpression(p)&&p.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&p.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&p.right&&ts.isIdentifier(p.left)&&(use.getStart(c.sf)>=p.right.getStart(c.sf)&&use.end<=p.right.end||p.operatorToken.kind!==ts.SyntaxKind.EqualsToken&&use===p.left)){const n=this.add(graph,c,p,p.left.text,'destination',depth,{valueKind:'symbol'});this.edge(graph,root,n,'assign','assignment');await this.propagateName(graph,c,p.left.text,containingFunction(p),n,depth+1,maxDepth,seen);handled=true;break;}if(ts.isReturnStatement(p)){const owner=containingFunction(p),n=this.add(graph,c,p,(this.functionName(owner,c)||'function')+' return','return',depth);this.edge(graph,root,n,'return','return');if(owner)await this.propagateCallReturn(graph,{c,fn:owner},n,depth+1,maxDepth,seen);handled=true;break;}if(ts.isStatement(p))break;}if(!handled&&ts.isPropertyAccessExpression(use.parent)&&use.parent.expression===use){/* base object use handled by property tracing elsewhere */}}
  }
  async outgoing(graph,c,name,root,depth,maxDepth){
    this.budget(graph);
    const offset=c.doc.offsetAt({line:root.location.line-1,character:root.location.column-1}),decl=this.lexicalDecl(c,name,offset),fn=containingFunction(decl||tokenAt(c.sf,offset)),seen=new Set();
    if(fn)return this.propagateName(graph,c,name,fn,root,depth,maxDepth,seen);
    let refs=[];try{const result=this.instant.references({name,location:root.location});refs=result.items||[];if(result.coverage?.truncated||result.coverage?.indexing||refs.length>100)graph.cutoffs.add('references');}catch{graph.cutoffs.add('references');}
    const pending=[];
    for(const r of refs.slice(0,100)){
      this.budget(graph);let rc;try{rc=this.source(fileURLToPath(r.uri));}catch{continue;}
      const off=rc.doc.offsetAt({line:r.line-1,character:r.column-1}),tok=tokenAt(rc.sf,off);if(!ts.isIdentifier(tok))continue;
      const local=this.lexicalDecl(rc,tok.text,off);if(rc.file===c.file?local!==decl:local!==null)continue;
      if(ts.isPropertyAccessExpression(tok.parent)&&tok.parent.name===tok||ts.isPropertyAssignment(tok.parent)&&tok.parent.name===tok)continue;
      if((ts.isVariableDeclaration(tok.parent)||ts.isParameter(tok.parent))&&tok.parent.name===tok||ts.isExportSpecifier(tok.parent))continue;
      const access=(ts.isPropertyAccessExpression(tok.parent)||ts.isElementAccessExpression(tok.parent))&&tok.parent.expression===tok?tok.parent:null;
      if(access){
        if(ts.isBinaryExpression(access.parent)&&access.parent.left===access&&access.parent.operatorToken.kind===ts.SyntaxKind.EqualsToken||ts.isDeleteExpression(access.parent))continue;
        const indexed=ts.isElementAccessExpression(access),node=this.add(graph,rc,access,access.getText(rc.sf),'value',depth,{valueKind:indexed?'indexed-property':'property',...this.snippet(rc,access,true)});
        this.edge(graph,root,node,'property_read',indexed?'reads by key':'reads property');
        pending.push({c:rc,use:access,node});continue;
      }
      const owner=containingFunction(tok);
      pending.push({c:rc,use:tok,node:root,owner,offset:off});
    }
    for(const next of pending){this.budget(graph);if(next.owner)await this.propagateName(graph,next.c,next.use.text,next.owner,next.node,depth,maxDepth,seen,next.offset);else await this.propagateExpressionUse(graph,next.c,next.use,next.node,next.node===root?depth:depth+1,maxDepth,seen);}
  }
  async trace(target,{direction='both',depth=5,maxNodes=180,timeBudgetMs=2000}={}){
    const started=Date.now(),file=path.resolve(fileURLToPath(target.location.uri)),c=this.source(file),offset=c.doc.offsetAt({line:target.location.line-1,character:target.location.column-1});let tok=tokenAt(c.sf,offset);
    if(ts.isIdentifier(tok)&&ts.isPropertyAccessExpression(tok.parent)&&tok.parent.name===tok)tok=tok.parent;
    if(!ts.isIdentifier(tok)&&!ts.isPropertyAccessExpression(tok))throw new FlowError('VALUE_SYMBOL_NOT_FOUND','Select an identifier/property use to trace.');
    const name=tok.getText(c.sf),graph={nodeMap:new Map(),edgeMap:new Map(),maxNodes,timeBudgetMs,deadline:started+timeBudgetMs,cutoffs:new Set()},root=this.add(graph,c,tok,name,'root',0,{valueKind:ts.isPropertyAccessExpression(tok)?'property':'symbol'}),seen=new Set(),warnings=[];
    try{
      if(direction!=='outgoing'){const decl=ts.isIdentifier(tok)?this.lexicalDecl(c,name,offset):null;if(decl)await this.sourceDecl(graph,c,decl,name,root,1,depth,seen);else await this.sourceExpr(graph,c,tok,root,1,depth,seen,[],true);}
      if(direction!=='incoming'){if(ts.isPropertyAccessExpression(tok))await this.propagateExpressionUse(graph,c,tok,root,1,depth,new Set());else await this.outgoing(graph,c,name,root,1,depth);}
    }catch(error){if(error.code!=='VALUE_TRACE_LIMIT')throw error;warnings.push({stage:'Value flow',code:error.code,message:error.message});}
    if(graph.cutoffs.has('depth'))warnings.push({stage:'Value flow',code:'VALUE_TRACE_DEPTH',message:`Value trace reached depth ${depth}; increase codeFlowLens.valueTraceDepth to follow more steps.`});
    if(graph.cutoffs.has('unresolvedCall'))warnings.push({stage:'Value flow',code:'UNRESOLVED_CALL',message:'Argument destinations are shown, but some callees could not be resolved; propagation through those calls remains unknown.'});
    if(graph.cutoffs.has('references'))warnings.push({stage:'Value flow',code:'VALUE_TRACE_REFERENCES',message:'Reference discovery is partial or still indexing. Some uses may be missing; rerun Value Flow after indexing finishes.'});
    const nodes=[...graph.nodeMap.values()],ids=new Set(nodes.map(n=>n.id)),edges=[...graph.edgeMap.values()].filter(e=>ids.has(e.from)&&ids.has(e.to));
    return{schemaVersion:'4.0',kind:'value-flow',graphId:crypto.randomUUID(),rootId:root.id,selectedNodeId:root.id,target:{name,location:root.location},nodes,edges,analysis:{state:graph.cutoffs.size?'partial':'ready',busy:false,stale:false,pending:[],timings:{lastOperationMs:Date.now()-started},counts:{nodes:nodes.length,edges:edges.length},warnings,coverage:{kind:'ast-interprocedural-provenance',completeRepositoryAnalysis:false,cutoffs:[...graph.cutoffs],depth,timeBudgetMs}},limitations:['This tracer is compiler-free and LSP-free. It follows syntax, module definitions, positional arguments, callback invocations, returns, assignments, object properties and JSX props. Dynamic dispatch, reflection and runtime mutation remain conservative.']};
  }
}
module.exports={QuickValueTracer};
