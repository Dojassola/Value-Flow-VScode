'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath, pathToFileURL } = require('node:url');
const ts = require('../vendor/typescript');
const { inside } = require('./scope');
const { FlowError } = require('./util');

const ASSIGN = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken
]);
const UNKNOWN = Symbol('unknown');
function hash(value){return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,20);}
function uniq(items,key=x=>x){const seen=new Set();return items.filter(item=>{const k=key(item);if(seen.has(k))return false;seen.add(k);return true;});}
function isFunctionNode(n){return !!n && (ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isArrowFunction(n)||ts.isMethodDeclaration(n)||ts.isConstructorDeclaration(n)||ts.isGetAccessorDeclaration(n)||ts.isSetAccessorDeclaration(n));}
function functionName(n,sf){if(!n)return 'function';if(n.name)return n.name.getText(sf);if(ts.isVariableDeclaration(n.parent)&&n.parent.name)return n.parent.name.getText(sf);if(ts.isPropertyAssignment(n.parent)&&n.parent.name)return n.parent.name.getText(sf);return 'anonymous';}
function nodeAt(sf,offset){let best=sf;function visit(n){if(n.getFullStart()<=offset&&offset<=n.end){if(n.end-n.getStart(sf)<=best.end-best.getStart(sf))best=n;ts.forEachChild(n,visit);}}visit(sf);return best;}
function containingFunction(n){for(let p=n;p;p=p.parent)if(isFunctionNode(p))return p;return null;}
function containingStatement(n){for(let p=n;p;p=p.parent)if(ts.isStatement(p)||ts.isVariableDeclaration(p)||isFunctionNode(p))return p;return n;}
function hasAncestor(node,ancestor){for(let p=node;p;p=p.parent)if(p===ancestor)return true;return false;}
function primitive(value){return value===null||['string','number','boolean','undefined'].includes(typeof value);}
function displayValue(v){if(v===UNKNOWN)return '<unknown>';try{const seen=new WeakSet();const s=JSON.stringify(v,(k,x)=>{if(x===UNKNOWN)return '<unknown>';if(x&&typeof x==='object'){if(seen.has(x))return '<cycle>';seen.add(x);}return x;});return s===undefined?String(v):s.length>180?s.slice(0,177)+'...':s;}catch{return '<unserializable>';}}
function cloneValue(value,seen=new Map()){if(value===UNKNOWN||primitive(value))return value;if(Array.isArray(value)){if(seen.has(value))return seen.get(value);const out=[];seen.set(value,out);for(const item of value)out.push(cloneValue(item,seen));return out;}if(value&&typeof value==='object'){if(seen.has(value))return seen.get(value);const out={};seen.set(value,out);for(const [k,v] of Object.entries(value))out[k]=cloneValue(v,seen);return out;}return UNKNOWN;}
function cloneEnv(env){const out=new Map();for(const [k,v] of env)out.set(k,cloneValue(v));return out;}
function sameValue(a,b,seen=new WeakMap()){if(Object.is(a,b))return true;if(a===UNKNOWN||b===UNKNOWN||!a||!b||typeof a!=='object'||typeof b!=='object')return false;if(seen.get(a)===b)return true;seen.set(a,b);if(Array.isArray(a)!==Array.isArray(b))return false;const ak=Object.keys(a),bk=Object.keys(b);if(ak.length!==bk.length)return false;for(const k of ak)if(!Object.prototype.hasOwnProperty.call(b,k)||!sameValue(a[k],b[k],seen))return false;return true;}

class ValueEngine {
  constructor(host, tsAdapter){this.host=host;this.tsAdapter=tsAdapter;this.maxRefsPerSymbol=180;}
  contextForFile(file){
    const config=this.host.configFor(file), service=this.host.service(config), program=service.getProgram();
    const sf=program?.getSourceFile(file); if(!sf) throw new FlowError('VALUE_FILE_NOT_INDEXED','Selected file is not available in the focused TypeScript context.');
    return {config,service,program,sf,checker:program.getTypeChecker()};
  }
  location(file,start,end=start+1){const d=this.host.document(file),a=d.positionAt(start),b=d.positionAt(end);return{uri:pathToFileURL(file).href,file:path.relative(this.host.root,file).replace(/\\/g,'/'),workspace:path.basename(this.host.root),line:a.line+1,column:a.character+1,endLine:b.line+1,endColumn:b.character+1};}
  snippet(node,sf){const statement=containingStatement(node)||node;let text=statement.getText(sf);if(text.length>1400)text=text.slice(0,1397)+'...';return{code:text,sourceStartLine:sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line+1};}
  resolveAlias(symbol,checker){if(!symbol)return null;try{if(symbol.flags&ts.SymbolFlags.Alias)return checker.getAliasedSymbol(symbol)||symbol;}catch{}return symbol;}
  symbolFromNode(node,checker){
    if(!node)return null;
    let probe=node;
    if(ts.isIdentifier(node)&&ts.isShorthandPropertyAssignment(node.parent)&&node.parent.name===node){try{return this.resolveAlias(checker.getShorthandAssignmentValueSymbol(node.parent)||checker.getSymbolAtLocation(node),checker);}catch{}}
    if(ts.isPropertyAccessExpression(node))probe=node.name;
    else if(ts.isPropertyAssignment(node))probe=node.name;
    else if(ts.isShorthandPropertyAssignment(node)){try{return this.resolveAlias(checker.getShorthandAssignmentValueSymbol(node)||checker.getSymbolAtLocation(node.name),checker);}catch{probe=node.name;}}
    const symbol=checker.getSymbolAtLocation(probe)||checker.getSymbolAtLocation(node);
    return this.resolveAlias(symbol,checker);
  }
  declarationFor(symbol){return symbol?.valueDeclaration||symbol?.declarations?.find(d=>inside(this.host.root,d.getSourceFile().fileName))||symbol?.declarations?.[0]||null;}
  symbolEntity(symbol,checker,hintNode=null){
    symbol=this.resolveAlias(symbol,checker);const decl=this.declarationFor(symbol);if(!symbol||!decl)return null;
    const sf=decl.getSourceFile(),file=sf.fileName;if(!inside(this.host.root,file))return null;
    const nameNode=decl.name&&typeof decl.name.getStart==='function'?decl.name:hintNode&&hintNode.getSourceFile()===sf?hintNode:decl;
    const start=nameNode.getStart(sf),end=Math.max(start+1,nameNode.end);const snip=this.snippet(decl,sf);const key='sym:'+file+':'+start;
    return{key,kind:'symbol',symbol,name:symbol.getName()==='__function'?functionName(decl,sf):symbol.getName(),file,start,end,location:this.location(file,start,end),...snip};
  }
  returnEntity(fn){const sf=fn.getSourceFile(),file=sf.fileName,name=functionName(fn,sf),start=(fn.name||fn).getStart(sf),snip=this.snippet(fn,sf);return{key:'return:'+file+':'+fn.getStart(sf),kind:'return',fn,name:name+' return',file,start,end:start+Math.max(1,name.length),location:this.location(file,start,start+Math.max(1,name.length)),...snip};}
  literalEntity(node,sf){const text=node.getText(sf);return{key:'lit:'+sf.fileName+':'+node.getStart(sf)+':'+hash(text),kind:'literal',name:text,file:sf.fileName,start:node.getStart(sf),end:node.end,location:this.location(sf.fileName,node.getStart(sf),node.end),code:text,sourceStartLine:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,literal:this.literalValue(node,sf)};}
  pseudoEntity(name,node,sf,kind='value'){return{key:`${kind}:${sf.fileName}:${node.getStart(sf)}:${hash(name)}`,kind,name,file:sf.fileName,start:node.getStart(sf),end:node.end,location:this.location(sf.fileName,node.getStart(sf),Math.min(node.end,node.getStart(sf)+Math.max(1,name.length))),...this.snippet(node,sf)};}
  entityNode(entity,role='value',layer=0){return{id:'value:'+hash(entity.key),type:'value',role,roles:[role],name:entity.name,location:entity.location,code:entity.code,sourceStartLine:entity.sourceStartLine,layer,valueKind:entity.kind,entityKey:entity.key,...(entity.literal!==undefined?{literal:entity.literal}:{}),_entity:entity};}
  targetEntity(target){
    const file=fileURLToPath(target.location.uri),ctx=this.contextForFile(file),doc=this.host.document(file),offset=doc.offsetAt({line:target.location.line-1,character:target.location.column-1});let n=nodeAt(ctx.sf,offset);
    while(n&&![ts.SyntaxKind.SourceFile].includes(n.kind)){const s=this.symbolFromNode(n,ctx.checker);if(s){const e=this.symbolEntity(s,ctx.checker,n);if(e)return{entity:e,node:n,ctx};}n=n.parent;}
    throw new FlowError('VALUE_SYMBOL_NOT_FOUND','No traceable TypeScript/JavaScript symbol exists at the selected position.');
  }
  targetFromSpec(spec){return this.targetEntity(spec).entity;}
  async referencesFor(entity){
    if(entity.kind!=='symbol'||!entity.symbol)return[];
    const decl=this.declarationFor(entity.symbol);if(!decl)return[];const sf=decl.getSourceFile(),file=sf.fileName;
    const ctx=this.contextForFile(file),pos=(decl.name||decl).getStart(sf),items=[];
    const contexts=[ctx.config,...this.host.configs.filter(c=>c!==ctx.config)];
    for(const cfg of contexts){const ls=this.host.service(cfg);if(!ls.getProgram()?.getSourceFile(file))continue;for(const ref of ls.getReferencesAtPosition(file,pos)||[]){if(!inside(this.host.root,ref.fileName))continue;items.push({file:ref.fileName,start:ref.textSpan.start,length:ref.textSpan.length});if(items.length>=this.maxRefsPerSymbol)break;}if(items.length>=this.maxRefsPerSymbol)break;}
    return uniq(items,r=>r.file+':'+r.start);
  }
  sourceEntities(expr,ctx,depth=0){
    if(!expr||depth>8)return[];const sf=ctx.sf,checker=ctx.checker;
    while(ts.isParenthesizedExpression(expr)||ts.isAsExpression(expr)||ts.isTypeAssertionExpression(expr)||ts.isNonNullExpression(expr)||ts.isSatisfiesExpression?.(expr))expr=expr.expression;
    if(ts.isStringLiteralLike(expr)||ts.isNumericLiteral(expr)||[ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword,ts.SyntaxKind.NullKeyword].includes(expr.kind))return[this.literalEntity(expr,sf)];
    if(ts.isIdentifier(expr)||ts.isPropertyAccessExpression(expr)||ts.isElementAccessExpression(expr)){
      const sym=this.symbolFromNode(expr,checker),ent=this.symbolEntity(sym,checker,expr);return ent?[ent]:[this.pseudoEntity(expr.getText(sf),expr,sf,'external')];
    }
    if(ts.isCallExpression(expr)||ts.isNewExpression(expr)){
      const sig=checker.getResolvedSignature(expr),decl=sig?.getDeclaration();if(decl&&inside(this.host.root,decl.getSourceFile().fileName)&&isFunctionNode(decl))return[this.returnEntity(decl)];
      return[this.pseudoEntity(expr.expression.getText(sf)+'() result',expr,sf,'opaque-call-result')];
    }
    if(ts.isConditionalExpression(expr))return uniq([...this.sourceEntities(expr.whenTrue,ctx,depth+1),...this.sourceEntities(expr.whenFalse,ctx,depth+1)],e=>e.key);
    if(ts.isBinaryExpression(expr))return uniq([...this.sourceEntities(expr.left,ctx,depth+1),...this.sourceEntities(expr.right,ctx,depth+1)],e=>e.key);
    if(ts.isPrefixUnaryExpression(expr)||ts.isPostfixUnaryExpression(expr))return this.sourceEntities(expr.operand,ctx,depth+1);
    if(ts.isTemplateExpression(expr)){const out=[];for(const s of expr.templateSpans)out.push(...this.sourceEntities(s.expression,ctx,depth+1));return uniq(out,e=>e.key);}
    if(ts.isObjectLiteralExpression(expr)){
      const out=[];for(const p of expr.properties){if(ts.isPropertyAssignment(p))out.push(...this.sourceEntities(p.initializer,ctx,depth+1));else if(ts.isShorthandPropertyAssignment(p))out.push(...this.sourceEntities(p.name,ctx,depth+1));else if(ts.isSpreadAssignment(p))out.push(...this.sourceEntities(p.expression,ctx,depth+1));}return uniq(out,e=>e.key);
    }
    if(ts.isArrayLiteralExpression(expr))return uniq(expr.elements.flatMap(e=>this.sourceEntities(e,ctx,depth+1)),e=>e.key);
    const out=[];ts.forEachChild(expr,n=>{if(ts.isExpression(n))out.push(...this.sourceEntities(n,ctx,depth+1));});return uniq(out,e=>e.key);
  }
  bindingEntities(name,ctx){
    const out=[],checker=ctx.checker;
    const visit=n=>{if(ts.isIdentifier(n)){const e=this.symbolEntity(this.symbolFromNode(n,checker),checker,n);if(e)out.push(e);}else if(ts.isObjectBindingPattern(n)||ts.isArrayBindingPattern(n))for(const el of n.elements)if(ts.isBindingElement(el))visit(el.name);};visit(name);return uniq(out,e=>e.key);
  }
  objectOwner(objectLiteral,ctx){
    let p=objectLiteral.parent;
    if(ts.isVariableDeclaration(p)&&p.initializer===objectLiteral){const ents=this.bindingEntities(p.name,ctx);return ents[0]||null;}
    if(ts.isBinaryExpression(p)&&ASSIGN.has(p.operatorToken.kind)&&p.right===objectLiteral){const sym=this.symbolFromNode(p.left,ctx.checker);return this.symbolEntity(sym,ctx.checker,p.left);}
    const line=ctx.sf.getLineAndCharacterOfPosition(objectLiteral.getStart(ctx.sf)).line+1;
    return this.pseudoEntity(`object@${line}`,objectLiteral,ctx.sf,'object');
  }
  propertyEntity(owner,name,node,ctx){if(owner)return{...this.pseudoEntity(owner.name+'.'+name,node,ctx.sf,'property'),key:'prop:'+owner.key+':'+name,name:owner.name+'.'+name};const line=ctx.sf.getLineAndCharacterOfPosition(node.getStart(ctx.sf)).line+1;return this.pseudoEntity(`object@${line}.${name}`,node,ctx.sf,'property');}
  functionParamEntity(fn,index,ctx){const p=fn.parameters?.[index];if(!p)return null;if(ts.isIdentifier(p.name)){const sym=this.symbolFromNode(p.name,ctx.checker);return this.symbolEntity(sym,ctx.checker,p.name);}return this.pseudoEntity(functionName(fn,ctx.sf)+` arg#${index+1}`,p,ctx.sf,'parameter-pattern');}
  componentPropEntity(opening,propName,ctx){
    if(!opening?.tagName)return null;
    const componentSymbol=this.symbolFromNode(opening.tagName,ctx.checker),decl=this.declarationFor(componentSymbol);if(!decl)return null;
    let fn=isFunctionNode(decl)?decl:null;if(ts.isVariableDeclaration(decl)&&decl.initializer&&isFunctionNode(decl.initializer))fn=decl.initializer;
    if(!fn||!fn.parameters?.length||!inside(this.host.root,fn.getSourceFile().fileName))return null;
    const dctx=this.contextForFile(fn.getSourceFile().fileName),param=fn.parameters[0];
    if(ts.isObjectBindingPattern(param.name)){
      const match=param.name.elements.find(el=>ts.isBindingElement(el)&&((el.propertyName||el.name).getText(dctx.sf).replace(/^['"]|['"]$/g,'')===propName));
      if(match){const ents=this.bindingEntities(match.name,dctx);if(ents.length)return ents[0];}
    }
    if(ts.isIdentifier(param.name)){
      const componentName=functionName(fn,dctx.sf);const ent=this.pseudoEntity(`${componentName}.${propName}`,param.name,dctx.sf,'jsx-prop-binding');
      ent.fn=fn;ent.propsParam=this.symbolFromNode(param.name,dctx.checker);ent.propName=propName;return ent;
    }
    return null;
  }
  outgoingFromReference(entity,ref){
    const ctx=this.contextForFile(ref.file);const sf=ctx.sf;let token=nodeAt(sf,ref.start);const edges=[];const add=(to,type,label,site=token,meta={})=>{if(to&&to.key!==entity.key)edges.push({from:entity,to,type,label,location:this.location(ref.file,site.getStart(sf),site.end),expression:meta.expression||site.getText(sf),confidence:meta.confidence||'high'});};
    for(let p=token;p&&p!==sf;p=p.parent){
      const parent=p.parent;
      if(ts.isVariableDeclaration(parent)&&parent.initializer&&hasAncestor(token,parent.initializer)){
        for(const to of this.bindingEntities(parent.name,ctx))add(to,'assign','assigned to '+to.name,parent,{expression:parent.initializer.getText(sf)});break;
      }
      if(ts.isBinaryExpression(parent)&&ASSIGN.has(parent.operatorToken.kind)&&hasAncestor(token,parent.right)){
        const sym=this.symbolFromNode(parent.left,ctx.checker),to=this.symbolEntity(sym,ctx.checker,parent.left)||this.pseudoEntity(parent.left.getText(sf),parent.left,sf,'assignment-target');add(to,'assign','assigned to '+to.name,parent,{expression:parent.right.getText(sf)});break;
      }
      if(ts.isReturnStatement(parent)&&parent.expression&&hasAncestor(token,parent.expression)){const fn=containingFunction(parent);if(fn)add(this.returnEntity(fn),'return','returned from '+functionName(fn,sf),parent,{expression:parent.expression.getText(sf)});break;}
      if((ts.isCallExpression(parent)||ts.isNewExpression(parent))){const idx=parent.arguments?.findIndex(a=>hasAncestor(token,a))??-1;if(idx>=0){const sig=ctx.checker.getResolvedSignature(parent),decl=sig?.getDeclaration();if(decl&&inside(this.host.root,decl.getSourceFile().fileName)&&isFunctionNode(decl)){const dctx=this.contextForFile(decl.getSourceFile().fileName),param=this.functionParamEntity(decl,idx,dctx);add(param,'argument',`argument #${idx+1} -> ${param?.name||'parameter'}`,parent,{expression:parent.arguments[idx].getText(sf)});}else add(this.pseudoEntity(parent.expression.getText(sf)+` arg#${idx+1}`,parent.arguments[idx],sf,'call-argument'),'argument',`argument #${idx+1} to ${parent.expression.getText(sf)}`,parent,{confidence:'medium'});break;}}
      if(ts.isPropertyAssignment(parent)&&parent.initializer&&hasAncestor(token,parent.initializer)){
        const obj=parent.parent,owner=ts.isObjectLiteralExpression(obj)?this.objectOwner(obj,ctx):null,name=parent.name.getText(sf).replace(/^['"]|['"]$/g,''),prop=this.propertyEntity(owner,name,parent.name,ctx);add(prop,'object_property','property '+name,parent,{expression:parent.initializer.getText(sf)});if(owner)edges.push({from:prop,to:owner,type:'object_contains',label:`${owner.name} contains ${name}`,location:this.location(ref.file,parent.getStart(sf),parent.end),expression:obj.getText(sf),confidence:'high'});break;
      }
      if(ts.isShorthandPropertyAssignment(parent)){
        const obj=parent.parent,owner=ts.isObjectLiteralExpression(obj)?this.objectOwner(obj,ctx):null,name=parent.name.text,prop=this.propertyEntity(owner,name,parent.name,ctx);add(prop,'object_property','property '+name,parent);if(owner)edges.push({from:prop,to:owner,type:'object_contains',label:`${owner.name} contains ${name}`,location:this.location(ref.file,parent.getStart(sf),parent.end),expression:obj.getText(sf),confidence:'high'});break;
      }
      if(ts.isJsxExpression(parent)&&parent.parent&&ts.isJsxAttribute(parent.parent)){
        const attr=parent.parent,opening=attr.parent?.parent,propName=attr.name.getText(sf),bound=this.componentPropEntity(opening,propName,ctx),prop=bound||this.pseudoEntity((opening?.tagName?.getText(sf)||'Component')+'.'+propName,attr.name,sf,'jsx-prop');
        add(prop,'jsx_prop',bound?`JSX prop ${propName} -> ${prop.name}`:`prop ${propName}`,attr,{expression:parent.expression?.getText(sf)||'',confidence:bound?'high':'medium'});break;
      }
      if(ts.isExpressionStatement(parent)||ts.isIfStatement(parent)||ts.isWhileStatement(parent)||ts.isForStatement(parent)||isFunctionNode(parent))break;
    }
    return edges;
  }
  incomingForEntity(entity){
    const edges=[];if(entity.kind==='return'){
      const fn=entity.fn,sf=fn.getSourceFile(),ctx=this.contextForFile(sf.fileName);const visit=n=>{if(isFunctionNode(n)&&n!==fn)return;if(ts.isReturnStatement(n)&&n.expression){for(const src of this.sourceEntities(n.expression,ctx))edges.push({from:src,to:entity,type:'return',label:'returns '+src.name,location:this.location(sf.fileName,n.getStart(sf),n.end),expression:n.expression.getText(sf),confidence:'high'});}ts.forEachChild(n,visit);};if(fn.body)visit(fn.body);return edges;
    }
    if(entity.kind!=='symbol'||!entity.symbol)return edges;
    const decl=this.declarationFor(entity.symbol),sf=decl?.getSourceFile();if(!decl||!sf)return edges;const ctx=this.contextForFile(sf.fileName);
    if(ts.isVariableDeclaration(decl)&&decl.initializer){for(const src of this.sourceEntities(decl.initializer,ctx))if(src.key!==entity.key)edges.push({from:src,to:entity,type:'assign',label:'initializes '+entity.name,location:this.location(sf.fileName,decl.getStart(sf),decl.end),expression:decl.initializer.getText(sf),confidence:'high'});}
    if(ts.isBindingElement(decl)){
      const pattern=decl.parent;const vd=pattern.parent; if(ts.isVariableDeclaration(vd)&&vd.initializer){const prop=decl.propertyName?.getText(sf)||decl.name.getText(sf);const baseSources=this.sourceEntities(vd.initializer,ctx);for(const base of baseSources){const pe={...this.pseudoEntity(base.name+'.'+prop,decl,sf,'property'),key:'prop:'+base.key+':'+prop,name:base.name+'.'+prop};edges.push({from:pe,to:entity,type:'destructure',label:'destructure '+prop,location:this.location(sf.fileName,decl.getStart(sf),decl.end),expression:vd.initializer.getText(sf),confidence:'medium'});}}
    }
    if(ts.isParameter(decl)){
      const fn=decl.parent,idx=fn.parameters.indexOf(decl),nameNode=fn.name||fn;const fnSym=this.symbolFromNode(nameNode,ctx.checker);
      if(fnSym){const fnEnt=this.symbolEntity(fnSym,ctx.checker,nameNode);if(fnEnt){ /* caller refs handled below */ }}
      const fnSymbol=fn.name?this.symbolFromNode(fn.name,ctx.checker):ts.isVariableDeclaration(fn.parent)?this.symbolFromNode(fn.parent.name,ctx.checker):null;
      if(fnSymbol){const fd=this.declarationFor(fnSymbol);if(fd){const fctx=this.contextForFile(fd.getSourceFile().fileName),ls=this.host.service(fctx.config),pos=(fd.name||fd).getStart(fd.getSourceFile());for(const ref of (ls.getReferencesAtPosition(fd.getSourceFile().fileName,pos)||[]).slice(0,this.maxRefsPerSymbol)){const rctx=this.contextForFile(ref.fileName),tok=nodeAt(rctx.sf,ref.textSpan.start);let call=tok;while(call&&call!==rctx.sf&&!ts.isCallExpression(call)&&!ts.isNewExpression(call))call=call.parent;if(call&&(ts.isCallExpression(call)||ts.isNewExpression(call))&&call.arguments?.[idx])for(const src of this.sourceEntities(call.arguments[idx],rctx))edges.push({from:src,to:entity,type:'argument',label:`caller argument #${idx+1}`,location:this.location(ref.fileName,call.arguments[idx].getStart(rctx.sf),call.arguments[idx].end),expression:call.arguments[idx].getText(rctx.sf),confidence:'high'});}}}
    }
    return edges;
  }
  async outgoingForEntity(entity){
    if(entity.kind==='jsx-prop-binding'&&entity.fn&&entity.propsParam){
      const edges=[],sf=entity.fn.getSourceFile(),ctx=this.contextForFile(sf.fileName),wanted=this.resolveAlias(entity.propsParam,ctx.checker);const visit=n=>{if(isFunctionNode(n)&&n!==entity.fn)return;if(ts.isPropertyAccessExpression(n)&&n.name.text===entity.propName){const base=this.resolveAlias(this.symbolFromNode(n.expression,ctx.checker),ctx.checker);if(base===wanted)edges.push(...this.outgoingFromReference(entity,{file:sf.fileName,start:n.getStart(sf),length:n.end-n.getStart(sf)}));}else if(ts.isElementAccessExpression(n)&&ts.isStringLiteralLike(n.argumentExpression)&&n.argumentExpression.text===entity.propName){const base=this.resolveAlias(this.symbolFromNode(n.expression,ctx.checker),ctx.checker);if(base===wanted)edges.push(...this.outgoingFromReference(entity,{file:sf.fileName,start:n.getStart(sf),length:n.end-n.getStart(sf)}));}ts.forEachChild(n,visit);};if(entity.fn.body)visit(entity.fn.body);return uniq(edges,e=>e.from.key+'|'+e.to.key+'|'+e.type+'|'+(e.location?.line||0));
    }
    if(entity.kind==='return'){
      const edges=[],fn=entity.fn,sf=fn.getSourceFile(),ctx=this.contextForFile(sf.fileName);const nameNode=fn.name || (ts.isVariableDeclaration(fn.parent)?fn.parent.name:null);const fnSym=nameNode?this.symbolFromNode(nameNode,ctx.checker):null;if(!fnSym)return edges;const decl=this.declarationFor(fnSym),ls=this.host.service(ctx.config),pos=(decl.name||decl).getStart(sf);
      for(const ref of (ls.getReferencesAtPosition(sf.fileName,pos)||[]).slice(0,this.maxRefsPerSymbol)){const rctx=this.contextForFile(ref.fileName),tok=nodeAt(rctx.sf,ref.textSpan.start);let call=tok;while(call&&call!==rctx.sf&&!ts.isCallExpression(call)&&!ts.isNewExpression(call))call=call.parent;if(!call||!(ts.isCallExpression(call)||ts.isNewExpression(call)))continue;let p=call.parent;if(ts.isVariableDeclaration(p)&&p.initializer===call){for(const to of this.bindingEntities(p.name,rctx))edges.push({from:entity,to,type:'call_return',label:'call result -> '+to.name,location:this.location(ref.fileName,call.getStart(rctx.sf),call.end),expression:call.getText(rctx.sf),confidence:'high'});}else if(ts.isBinaryExpression(p)&&ASSIGN.has(p.operatorToken.kind)&&p.right===call){const to=this.symbolEntity(this.symbolFromNode(p.left,rctx.checker),rctx.checker,p.left)||this.pseudoEntity(p.left.getText(rctx.sf),p.left,rctx.sf,'assignment-target');edges.push({from:entity,to,type:'call_return',label:'call result -> '+to.name,location:this.location(ref.fileName,call.getStart(rctx.sf),call.end),expression:call.getText(rctx.sf),confidence:'high'});}else edges.push({from:entity,to:this.pseudoEntity(call.getText(rctx.sf),call,rctx.sf,'call-result'),type:'call_return',label:'returned to call site',location:this.location(ref.fileName,call.getStart(rctx.sf),call.end),expression:call.getText(rctx.sf),confidence:'medium'});}
      return edges;
    }
    if(entity.kind!=='symbol'||!entity.symbol)return[];const refs=await this.referencesFor(entity),edges=[];for(const ref of refs){try{edges.push(...this.outgoingFromReference(entity,ref));}catch{/* one bad reference must not kill the trace */}}return edges;
  }
  async relations(entity,direction){return direction==='incoming'?this.incomingForEntity(entity):this.outgoingForEntity(entity);}
  graphNodeFromEntity(entity,role,layer){const n=this.entityNode(entity,role,layer);delete n._entity;return n;}
  async trace(target,{direction='both',depth=4,maxNodes=120}={}){
    if(!['incoming','outgoing','both'].includes(direction))throw new FlowError('INVALID_ARGUMENT','direction must be incoming, outgoing or both.');
    depth=Math.max(1,Math.min(8,Number(depth)||4));maxNodes=Math.max(10,Math.min(300,Number(maxNodes)||120));
    const rootInfo=this.targetEntity(target),root=rootInfo.entity,nodes=new Map(),edges=new Map(),entities=new Map([[root.key,root]]),seen=new Map();
    const put=(ent,role='value',layer=0)=>{if(!ent||nodes.size>=maxNodes&&!nodes.has(ent.key))return null;entities.set(ent.key,ent);if(!nodes.has(ent.key))nodes.set(ent.key,this.entityNode(ent,role,layer));return nodes.get(ent.key);};
    put(root,'root',0);const queue=[{entity:root,level:0,layer:0}];
    while(queue.length){const item=queue.shift();if(item.level>=depth)continue;for(const dir of direction==='both'?['incoming','outgoing']:[direction]){const sk=item.entity.key+'|'+dir;if(seen.has(sk))continue;seen.set(sk,true);const rels=await this.relations(item.entity,dir);for(const r of rels){const from=put(r.from,r.from.key===root.key?'root':'value',item.layer+(r.from.key===item.entity.key?0:-1)),to=put(r.to,r.to.key===root.key?'root':'value',item.layer+(r.to.key===item.entity.key?0:1));if(!from||!to)continue;const id='vedge:'+hash(r.from.key+'|'+r.to.key+'|'+r.type+'|'+(r.location?.uri||'')+':'+(r.location?.line||0));if(!edges.has(id))edges.set(id,{id,from:from.id,to:to.id,type:r.type,label:r.label,location:r.location,expression:r.expression,confidence:r.confidence});const next=dir==='incoming'?r.from:r.to;if(next&&next.key!==item.entity.key&&item.level+1<depth)queue.push({entity:next,level:item.level+1,layer:item.layer+(dir==='incoming'?-1:1)});}}
    }
    const outNodes=[...nodes.values()].map(n=>{const x={...n};delete x._entity;return x;});const outEdges=[...edges.values()];const graphId=crypto.randomUUID();
    return{schemaVersion:'3.0',kind:'value-flow',graphId,rootId:'value:'+hash(root.key),selectedNodeId:'value:'+hash(root.key),target:{name:root.name,location:root.location},nodes:outNodes,edges:outEdges,
      analysis:{state:nodes.size>=maxNodes?'partial':'ready',busy:false,stale:false,pending:[],timings:{lastOperationMs:0},counts:{nodes:outNodes.length,edges:outEdges.length},warnings:[],coverage:{kind:'bounded-interprocedural-value-flow',depth,maxNodes,cutoffs:nodes.size>=maxNodes?['maxNodes']:[],completeRepositoryAnalysis:false}},
      limitations:['Static value provenance. Direct assignments, arguments, returns, destructuring, object properties and JSX props are traced when resolvable.','Dynamic dispatch, closures escaping their scope, heap aliasing, reflection, framework injection and arbitrary library behavior are conservative boundaries.','An edge means the source may feed the destination; it is not proof that a runtime path executes.']};
  }
  shortestPaths(graph,rootId,predicate){const adj=new Map();for(const e of graph.edges){if(!adj.has(e.from))adj.set(e.from,[]);adj.get(e.from).push(e);}const prev=new Map([[rootId,null]]),q=[rootId];let found=null;for(let i=0;i<q.length;i++){const id=q[i];if(id!==rootId&&predicate(id)){found=id;break;}for(const e of adj.get(id)||[])if(!prev.has(e.to)){prev.set(e.to,{from:id,edge:e});q.push(e.to);}}if(!found)return null;const nodes=[found],edges=[];let cur=found;while(prev.get(cur)){const p=prev.get(cur);edges.push(p.edge);cur=p.from;nodes.push(cur);}return{end:found,nodes:nodes.reverse(),edges:edges.reverse()};}
  async correlate(targets,{depth=4,maxNodes=180}={}){
    if(!Array.isArray(targets)||targets.length<2)throw new FlowError('CORRELATION_NEEDS_SYMBOLS','Select at least two symbols.');
    targets=targets.slice(0,8);depth=Math.max(1,Math.min(8,Number(depth)||4));maxNodes=Math.max(20,Math.min(300,Number(maxNodes)||180));
    const targetInfos=targets.map(t=>this.targetEntity(t)),rootEntities=targetInfos.map(x=>x.entity),traces=[];
    for(const t of targets)traces.push(await this.trace(t,{direction:'both',depth,maxNodes:Math.max(50,Math.floor(maxNodes/targets.length)*3)}));
    const nodeMap=new Map(),edgeMap=new Map(),roots=[];
    traces.forEach((g,i)=>{roots.push(g.rootId);for(const n of g.nodes){const old=nodeMap.get(n.id);if(old)old.originRoots=uniq([...(old.originRoots||[]),i]);else nodeMap.set(n.id,{...n,originRoots:[i]});}for(const e of g.edges)edgeMap.set(e.id,e);});
    if(new Set(roots).size<2)throw new FlowError('CORRELATION_SAME_SYMBOL','The selected positions resolve to the same semantic symbol. Choose at least two distinct symbols.');
    const correlations=[],corrByNode=new Map();
    const addCorrelation=(nodeId,type,indices)=>{indices=uniq(indices).sort((a,b)=>a-b);if(indices.length<2)return;let c=corrByNode.get(nodeId);if(!c){c={nodeId,types:[],roots:indices};corrByNode.set(nodeId,c);correlations.push(c);}c.types=uniq([...c.types,type]);c.roots=uniq([...c.roots,...indices]).sort((a,b)=>a-b);const n=nodeMap.get(nodeId);if(n){n.role='intersection';n.roles=uniq([...(n.roles||[]),'intersection']);n.correlation={...(n.correlation||{}),types:uniq([...(n.correlation?.types||[]),type]),roots:c.roots};}};
    const addStructuralNode=(entity)=>{const id='value:'+hash(entity.key);if(!nodeMap.has(id)){const n=this.entityNode(entity,'intersection',0);delete n._entity;nodeMap.set(id,n);}return id;};
    const addStructuralEdge=(rootIndex,to,type,label,location)=>{const from=roots[rootIndex],id='cedge:'+hash(from+'|'+to+'|'+type+'|'+(location?.uri||'')+':'+(location?.line||0));if(!edgeMap.has(id))edgeMap.set(id,{id,from,to,type,label,location,confidence:'high',structural:true});};

    // Value-flow reachability intersections.
    let adj=new Map(),rev=new Map();const rebuildAdj=()=>{adj=new Map();rev=new Map();for(const e of edgeMap.values()){if(!adj.has(e.from))adj.set(e.from,[]);adj.get(e.from).push(e.to);if(!rev.has(e.to))rev.set(e.to,[]);rev.get(e.to).push(e.from);}};rebuildAdj();
    const reach=(root,map)=>{const seen=new Set([root]),q=[root];for(let i=0;i<q.length&&seen.size<maxNodes*3;i++)for(const n of map.get(q[i])||[])if(!seen.has(n)){seen.add(n);q.push(n);}return seen;};
    let forward=roots.map(r=>reach(r,adj)),backward=roots.map(r=>reach(r,rev));
    for(const [id,node] of nodeMap){const f=forward.map((set,i)=>set.has(id)?i:-1).filter(i=>i>=0),b=backward.map((set,i)=>set.has(id)?i:-1).filter(i=>i>=0);if(f.length>=2)addCorrelation(id,'common_destination',f);if(b.length>=2)addCorrelation(id,'common_origin',b);}

    // Structural correlation: same enclosing function, same call site, common caller.
    const scopeMap=new Map(),callSiteMap=new Map(),callerMap=new Map();
    const addMap=(map,key,entity,index,location)=>{let x=map.get(key);if(!x){x={entity,indices:[],locations:[]};map.set(key,x);}x.indices.push(index);if(location)x.locations.push(location);};
    for(let i=0;i<rootEntities.length;i++){
      const entity=rootEntities[i],decl=this.declarationFor(entity.symbol);
      if(decl){const fn=containingFunction(decl);if(fn){const c=this.contextForFile(fn.getSourceFile().fileName),nameNode=fn.name||(ts.isVariableDeclaration(fn.parent)?fn.parent.name:fn),sym=this.symbolFromNode(nameNode,c.checker),fent=this.symbolEntity(sym,c.checker,nameNode)||this.pseudoEntity(functionName(fn,c.sf),fn,c.sf,'function');addMap(scopeMap,fent.key,fent,i,entity.location);}}
      for(const ref of await this.referencesFor(entity)){
        const c=this.contextForFile(ref.file),tok=nodeAt(c.sf,ref.start),fn=containingFunction(tok);
        if(fn){const nameNode=fn.name||(ts.isVariableDeclaration(fn.parent)?fn.parent.name:fn),sym=this.symbolFromNode(nameNode,c.checker),fent=this.symbolEntity(sym,c.checker,nameNode)||this.pseudoEntity(functionName(fn,c.sf),fn,c.sf,'function');addMap(scopeMap,fent.key,fent,i,this.location(ref.file,ref.start,ref.start+Math.max(1,ref.length||1)));}
        let call=tok;while(call&&call!==c.sf&&!ts.isCallExpression(call)&&!ts.isNewExpression(call))call=call.parent;
        if(call&&(ts.isCallExpression(call)||ts.isNewExpression(call))){const loc=this.location(ref.file,call.getStart(c.sf),call.end);if(call.arguments?.some(arg=>hasAncestor(tok,arg))){const ent=this.pseudoEntity('call '+call.expression.getText(c.sf),call,c.sf,'call-site');addMap(callSiteMap,ent.key,ent,i,loc);}if(hasAncestor(tok,call.expression)&&fn){const nameNode=fn.name||(ts.isVariableDeclaration(fn.parent)?fn.parent.name:fn),sym=this.symbolFromNode(nameNode,c.checker),fent=this.symbolEntity(sym,c.checker,nameNode)||this.pseudoEntity(functionName(fn,c.sf),fn,c.sf,'function');addMap(callerMap,fent.key,fent,i,loc);}}
      }
    }
    for(const entry of scopeMap.values()){const indices=uniq(entry.indices);if(indices.length<2)continue;const id=addStructuralNode(entry.entity);for(const i of indices)addStructuralEdge(i,id,'co_occurs_in','co-occurs in '+entry.entity.name,entry.locations[0]);addCorrelation(id,'shared_function_scope',indices);}
    for(const entry of callSiteMap.values()){const indices=uniq(entry.indices);if(indices.length<2)continue;const id=addStructuralNode(entry.entity);for(const i of indices)addStructuralEdge(i,id,'shared_call_site','used together at call site',entry.locations[0]);addCorrelation(id,'shared_call_site',indices);}
    for(const entry of callerMap.values()){const indices=uniq(entry.indices);if(indices.length<2)continue;const id=addStructuralNode(entry.entity);for(const i of indices)addStructuralEdge(i,id,'common_caller','called by '+entry.entity.name,entry.locations[0]);addCorrelation(id,'common_caller',indices);}

    // If selected symbols are functions, compare direct callees too.
    const calleeMap=new Map();
    for(let i=0;i<rootEntities.length;i++){
      const decl=this.declarationFor(rootEntities[i].symbol);let fn=isFunctionNode(decl)?decl:null;if(ts.isVariableDeclaration(decl)&&decl.initializer&&isFunctionNode(decl.initializer))fn=decl.initializer;if(!fn?.body)continue;
      const c=this.contextForFile(fn.getSourceFile().fileName);const visit=n=>{if(isFunctionNode(n)&&n!==fn)return;if(ts.isCallExpression(n)||ts.isNewExpression(n)){const sig=c.checker.getResolvedSignature(n),cd=sig?.getDeclaration();if(cd&&inside(this.host.root,cd.getSourceFile().fileName)&&isFunctionNode(cd)){const cc=this.contextForFile(cd.getSourceFile().fileName),nameNode=cd.name||(ts.isVariableDeclaration(cd.parent)?cd.parent.name:cd),sym=this.symbolFromNode(nameNode,cc.checker),cent=this.symbolEntity(sym,cc.checker,nameNode)||this.pseudoEntity(functionName(cd,cc.sf),cd,cc.sf,'function');addMap(calleeMap,cent.key,cent,i,this.location(c.sf.fileName,n.getStart(c.sf),n.end));}}ts.forEachChild(n,visit);};visit(fn.body);
    }
    for(const entry of calleeMap.values()){const indices=uniq(entry.indices);if(indices.length<2)continue;const id=addStructuralNode(entry.entity);for(const i of indices)addStructuralEdge(i,id,'common_callee','calls '+entry.entity.name,entry.locations[0]);addCorrelation(id,'common_callee',indices);}

    rebuildAdj();forward=roots.map(r=>reach(r,adj));backward=roots.map(r=>reach(r,rev));
    // Direct shared value targets get a more specific collision label.
    for(const c of correlations){const incoming=[...edgeMap.values()].filter(e=>e.to===c.nodeId&&!e.structural);const contributors=uniq(incoming.flatMap(e=>forward.map((set,i)=>set.has(e.from)?i:-1).filter(i=>i>=0)));if(contributors.length>=2&&incoming.length){const kinds=new Set(incoming.map(e=>e.type));const extra=kinds.size===1&&kinds.has('argument')?'shared_parameter':kinds.size===1&&kinds.has('assign')?'shared_write_target':kinds.size===1&&kinds.has('object_property')||kinds.size===1&&kinds.has('object_contains')?'shared_object_target':'direct_collision';addCorrelation(c.nodeId,extra,contributors);}}

    // Keep roots, intersections and shortest undirected connectors; if none intersect keep the merged neighborhoods.
    let keep=new Set(roots);const undirected=new Map();for(const e of edgeMap.values()){for(const [a,b] of [[e.from,e.to],[e.to,e.from]]){if(!undirected.has(a))undirected.set(a,[]);undirected.get(a).push({to:b,e});}}
    const pathBetween=(a,b)=>{const prev=new Map([[a,null]]),q=[a];for(let i=0;i<q.length;i++){if(q[i]===b)break;for(const x of undirected.get(q[i])||[])if(!prev.has(x.to)){prev.set(x.to,{from:q[i],edge:x.e});q.push(x.to);}}if(!prev.has(b))return null;const ns=[b],es=[];for(let cur=b;prev.get(cur);){const p=prev.get(cur);es.push(p.edge);cur=p.from;ns.push(cur);}return{nodes:ns,edges:es};};
    for(const c of correlations.slice(0,40)){keep.add(c.nodeId);for(const r of roots){const p=pathBetween(r,c.nodeId);if(p)for(const id of p.nodes)keep.add(id);}}
    if(correlations.length===0)keep=new Set([...nodeMap.keys()].slice(0,maxNodes));
    const nodes=[...nodeMap.values()].filter(n=>keep.has(n.id)).slice(0,maxNodes),ids=new Set(nodes.map(n=>n.id)),edges=[...edgeMap.values()].filter(e=>ids.has(e.from)&&ids.has(e.to));
    const dist=new Map(roots.map(r=>[r,0])),q=[...roots];for(let i=0;i<q.length;i++){for(const to of adj.get(q[i])||[])if(!dist.has(to)){dist.set(to,(dist.get(q[i])||0)+1);q.push(to);}for(const from of rev.get(q[i])||[])if(!dist.has(from)){dist.set(from,(dist.get(q[i])||0)-1);q.push(from);}}for(const n of nodes)n.layer=dist.get(n.id)||0;
    return{schemaVersion:'3.0',kind:'correlation',graphId:crypto.randomUUID(),rootId:roots[0],selectedNodeId:roots[0],target:{name:targets.map(t=>t.name).join(' × '),location:targets[0].location},roots:roots.map((id,i)=>({id,index:i,name:targets[i].name})),nodes,edges,correlations,
      analysis:{state:correlations.length?'ready':'partial',busy:false,stale:false,pending:[],timings:{lastOperationMs:0},counts:{nodes:nodes.length,edges:edges.length,correlations:correlations.length},warnings:correlations.length?[]:[{stage:'Correlation',code:'NO_INTERSECTION',message:`No common static value or structural relationship was found within depth ${depth}. The displayed neighborhoods are bounded.`}],coverage:{kind:'multi-symbol-static-correlation',depth,maxNodes,completeRepositoryAnalysis:false,cutoffs:[]}},
      limitations:['Correlation combines bounded value-flow intersections with static structural evidence such as shared function scope, call sites, callers and callees. It does not prove values meet at runtime.','No intersection within the current depth/budget does not prove the symbols are unrelated.','Shared writes and common destinations are collision candidates; aliasing through external libraries, heap mutation and dynamic dispatch can remain hidden.']};
  }
  literalValue(n,sf){if(ts.isStringLiteralLike(n))return n.text;if(ts.isNumericLiteral(n))return Number(n.text);if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(n.kind===ts.SyntaxKind.NullKeyword)return null;return UNKNOWN;}
  safeBinary(op,a,b){if(a===UNKNOWN||b===UNKNOWN)return UNKNOWN;try{switch(op){case ts.SyntaxKind.PlusToken:return a+b;case ts.SyntaxKind.MinusToken:return a-b;case ts.SyntaxKind.AsteriskToken:return a*b;case ts.SyntaxKind.SlashToken:return b===0?UNKNOWN:a/b;case ts.SyntaxKind.PercentToken:return a%b;case ts.SyntaxKind.AsteriskAsteriskToken:return a**b;case ts.SyntaxKind.EqualsEqualsToken:return a==b;case ts.SyntaxKind.EqualsEqualsEqualsToken:return a===b;case ts.SyntaxKind.ExclamationEqualsToken:return a!=b;case ts.SyntaxKind.ExclamationEqualsEqualsToken:return a!==b;case ts.SyntaxKind.LessThanToken:return a<b;case ts.SyntaxKind.LessThanEqualsToken:return a<=b;case ts.SyntaxKind.GreaterThanToken:return a>b;case ts.SyntaxKind.GreaterThanEqualsToken:return a>=b;case ts.SyntaxKind.AmpersandAmpersandToken:return a&&b;case ts.SyntaxKind.BarBarToken:return a||b;case ts.SyntaxKind.QuestionQuestionToken:return a??b;default:return UNKNOWN;}}catch{return UNKNOWN;}}
  async simulate(target,{value,maxSteps=180,maxDepth=4,maxLoopIterations=12}={}){
    maxSteps=Math.max(20,Math.min(500,Number(maxSteps)||180));maxDepth=Math.max(1,Math.min(8,Number(maxDepth)||4));maxLoopIterations=Math.max(1,Math.min(50,Number(maxLoopIterations)||12));
    const rootInfo=this.targetEntity(target),selected=rootInfo.entity,decl=this.declarationFor(selected.symbol),sf=decl?.getSourceFile();if(!decl||!sf)throw new FlowError('SIMULATION_DECLARATION_REQUIRED','Simulation requires a workspace variable, parameter or property declaration.');
    const fn=containingFunction(decl);if(!fn)throw new FlowError('SIMULATION_FUNCTION_REQUIRED','Select a variable or parameter inside a function/method. Module-level side effects are intentionally not simulated.');
    const ctx=this.contextForFile(sf.fileName),nodes=[],edges=[],warnings=[],steps={count:0},injectedKey=selected.key;let lastId=null;const addStep=(node,kind,label,val,meta={})=>{if(steps.count++>=maxSteps)throw Object.assign(new Error('Simulation step budget reached.'),{code:'SIMULATION_LIMIT'});const id='sim:'+steps.count+':'+hash(sf.fileName+':'+node.getStart(node.getSourceFile())+':'+kind+':'+steps.count),loc=this.location(node.getSourceFile().fileName,node.getStart(node.getSourceFile()),node.end),sn=this.snippet(node,node.getSourceFile());const n={id,type:'simulation',role:kind,name:label,location:loc,code:sn.code,sourceStartLine:sn.sourceStartLine,layer:steps.count,simulationValue:displayValue(val),rawValue:primitive(val)&&val!==UNKNOWN?val:undefined,...meta};nodes.push(n);if(lastId)edges.push({id:'simedge:'+edges.length,from:lastId,to:id,type:meta.edgeType||'next',label:meta.edgeLabel||'next'});lastId=id;return id;};
    const keyOf=(symbol,checker,node)=>{const e=this.symbolEntity(symbol,checker,node);return e?.key;};
    const bindName=(nameNode,val,env,checker,allowInjection=false)=>{if(ts.isIdentifier(nameNode)){const k=keyOf(this.symbolFromNode(nameNode,checker),checker,nameNode);const injected=!!(allowInjection&&k===injectedKey);if(k)env.set(k,injected?value:val);return injected;}let injected=false;if(ts.isObjectBindingPattern(nameNode)){for(const el of nameNode.elements){if(!ts.isBindingElement(el))continue;const prop=(el.propertyName||el.name).getText();const v=val!==UNKNOWN&&val&&typeof val==='object'?val[prop]:UNKNOWN;injected=bindName(el.name,v,env,checker,allowInjection)||injected;}}else if(ts.isArrayBindingPattern(nameNode)){nameNode.elements.forEach((el,i)=>{if(ts.isBindingElement(el))injected=bindName(el.name,Array.isArray(val)?val[i]:UNKNOWN,env,checker,allowInjection)||injected;});}return injected;};
    const evalExpr=async(expr,env,depth)=>{if(!expr)return undefined;while(ts.isParenthesizedExpression(expr)||ts.isAsExpression(expr)||ts.isTypeAssertionExpression(expr)||ts.isNonNullExpression(expr))expr=expr.expression;const sff=expr.getSourceFile(),c=this.contextForFile(sff.fileName),checker=c.checker;const lit=this.literalValue(expr,sff);if(lit!==UNKNOWN)return lit;
      if(ts.isIdentifier(expr)||ts.isPropertyAccessExpression(expr)){if(ts.isPropertyAccessExpression(expr)){const base=await evalExpr(expr.expression,env,depth);if(base!==UNKNOWN&&base!=null&&typeof base==='object')return Object.prototype.hasOwnProperty.call(base,expr.name.text)?base[expr.name.text]:UNKNOWN;}const k=keyOf(this.symbolFromNode(expr,checker),checker,expr);return k&&env.has(k)?env.get(k):UNKNOWN;}
      if(ts.isElementAccessExpression(expr)){const base=await evalExpr(expr.expression,env,depth),idx=await evalExpr(expr.argumentExpression,env,depth);if(base!==UNKNOWN&&idx!==UNKNOWN&&base!=null)try{return base[idx];}catch{return UNKNOWN;}return UNKNOWN;}
      if(ts.isObjectLiteralExpression(expr)){const o={};for(const p of expr.properties){if(ts.isPropertyAssignment(p))o[p.name.getText(sff).replace(/^['"]|['"]$/g,'')]=await evalExpr(p.initializer,env,depth);else if(ts.isShorthandPropertyAssignment(p))o[p.name.text]=await evalExpr(p.name,env,depth);else if(ts.isSpreadAssignment(p)){const v=await evalExpr(p.expression,env,depth);if(v!==UNKNOWN&&v&&typeof v==='object')Object.assign(o,v);}}return o;}
      if(ts.isArrayLiteralExpression(expr)){const a=[];for(const e of expr.elements)a.push(await evalExpr(e,env,depth));return a;}
      if(ts.isBinaryExpression(expr)){if(ASSIGN.has(expr.operatorToken.kind)){let rhs=await evalExpr(expr.right,env,depth);if(expr.operatorToken.kind!==ts.SyntaxKind.EqualsToken){const old=await evalExpr(expr.left,env,depth),op=expr.operatorToken.kind===ts.SyntaxKind.PlusEqualsToken?ts.SyntaxKind.PlusToken:expr.operatorToken.kind===ts.SyntaxKind.MinusEqualsToken?ts.SyntaxKind.MinusToken:expr.operatorToken.kind===ts.SyntaxKind.AsteriskEqualsToken?ts.SyntaxKind.AsteriskToken:expr.operatorToken.kind===ts.SyntaxKind.SlashEqualsToken?ts.SyntaxKind.SlashToken:expr.operatorToken.kind===ts.SyntaxKind.PercentEqualsToken?ts.SyntaxKind.PercentToken:null;rhs=op?this.safeBinary(op,old,rhs):UNKNOWN;}await assignTarget(expr.left,rhs,env,checker);return rhs;}const a=await evalExpr(expr.left,env,depth);if(expr.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken&&a!==UNKNOWN&&!a)return a;if(expr.operatorToken.kind===ts.SyntaxKind.BarBarToken&&a!==UNKNOWN&&a)return a;if(expr.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken&&a!==UNKNOWN&&a!==null&&a!==undefined)return a;const b=await evalExpr(expr.right,env,depth);return this.safeBinary(expr.operatorToken.kind,a,b);}
      if(ts.isPrefixUnaryExpression(expr)){if([ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(expr.operator)){const old=await evalExpr(expr.operand,env,depth);const next=old===UNKNOWN?UNKNOWN:(expr.operator===ts.SyntaxKind.PlusPlusToken?old+1:old-1);await assignTarget(expr.operand,next,env,checker);return next;}const v=await evalExpr(expr.operand,env,depth);if(v===UNKNOWN)return UNKNOWN;switch(expr.operator){case ts.SyntaxKind.ExclamationToken:return !v;case ts.SyntaxKind.PlusToken:return +v;case ts.SyntaxKind.MinusToken:return -v;case ts.SyntaxKind.TildeToken:return ~v;default:return UNKNOWN;}}
      if(ts.isPostfixUnaryExpression(expr)&&[ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(expr.operator)){const old=await evalExpr(expr.operand,env,depth);const next=old===UNKNOWN?UNKNOWN:(expr.operator===ts.SyntaxKind.PlusPlusToken?old+1:old-1);await assignTarget(expr.operand,next,env,checker);return old;}
      if(ts.isConditionalExpression(expr)){const cond=await evalExpr(expr.condition,env,depth);return cond===UNKNOWN?UNKNOWN:evalExpr(cond?expr.whenTrue:expr.whenFalse,env,depth);}
      if(ts.isTemplateExpression(expr)){let out=expr.head.text;for(const span of expr.templateSpans){const v=await evalExpr(span.expression,env,depth);if(v===UNKNOWN)return UNKNOWN;out+=String(v)+span.literal.text;}return out;}
      if(ts.isCallExpression(expr)||ts.isNewExpression(expr)){if(depth>=maxDepth)return UNKNOWN;const sig=checker.getResolvedSignature(expr),callee=sig?.getDeclaration();if(!callee||!inside(this.host.root,callee.getSourceFile().fileName)||!isFunctionNode(callee)||!callee.body)return UNKNOWN;const args=[];for(const a of expr.arguments||[])args.push(await evalExpr(a,env,depth));const before=lastId;addStep(expr,'call','call '+functionName(callee,callee.getSourceFile()),args,{edgeType:'call',edgeLabel:'call'});const result=await executeFunction(callee,args,depth+1);lastId=lastId||before;return result;}
      return UNKNOWN;};
    const assignTarget=async(left,val,env,checker)=>{if(ts.isIdentifier(left)){const k=keyOf(this.symbolFromNode(left,checker),checker,left);if(k)env.set(k,val);return;}if(ts.isPropertyAccessExpression(left)){const base=await evalExpr(left.expression,env,0);if(base!==UNKNOWN&&base&&typeof base==='object')base[left.name.text]=val;return;}if(ts.isElementAccessExpression(left)){const base=await evalExpr(left.expression,env,0),idx=await evalExpr(left.argumentExpression,env,0);if(base!==UNKNOWN&&idx!==UNKNOWN&&base&&typeof base==='object')base[idx]=val;}};
    const execStatement=async(st,env,depth,loopState)=>{const sfc=st.getSourceFile(),cx=this.contextForFile(sfc.fileName),checker=cx.checker;
      if(ts.isBlock(st)){for(const s of st.statements){const r=await execStatement(s,env,depth,loopState);if(r?.control)return r;}return null;}
      if(ts.isVariableStatement(st)){for(const d of st.declarationList.declarations){const v=d.initializer?await evalExpr(d.initializer,env,depth):undefined;const injected=bindName(d.name,v,env,checker,depth===0);if(injected)addStep(d,'inject',`inject ${selected.name} = ${displayValue(value)}`,value,{edgeType:'inject',edgeLabel:'injected value'});else addStep(d,'assign',`set ${d.name.getText(sfc)} = ${displayValue(v)}`,v,{edgeType:'assign',edgeLabel:'assign'});}return null;}
      if(ts.isExpressionStatement(st)){const e=st.expression;if(ts.isBinaryExpression(e)&&ASSIGN.has(e.operatorToken.kind)){let rhs=await evalExpr(e.right,env,depth);if(e.operatorToken.kind!==ts.SyntaxKind.EqualsToken){const old=await evalExpr(e.left,env,depth),op=e.operatorToken.kind===ts.SyntaxKind.PlusEqualsToken?ts.SyntaxKind.PlusToken:e.operatorToken.kind===ts.SyntaxKind.MinusEqualsToken?ts.SyntaxKind.MinusToken:e.operatorToken.kind===ts.SyntaxKind.AsteriskEqualsToken?ts.SyntaxKind.AsteriskToken:e.operatorToken.kind===ts.SyntaxKind.SlashEqualsToken?ts.SyntaxKind.SlashToken:null;rhs=op?this.safeBinary(op,old,rhs):UNKNOWN;}await assignTarget(e.left,rhs,env,checker);addStep(st,'assign',`${e.left.getText(sfc)} = ${displayValue(rhs)}`,rhs,{edgeType:'assign',edgeLabel:'write'});return null;}const v=await evalExpr(e,env,depth);addStep(st,'expression',`expression => ${displayValue(v)}`,v);return null;}
      if(ts.isIfStatement(st)){const cond=await evalExpr(st.expression,env,depth);addStep(st.expression,'condition',`if => ${displayValue(cond)}`,cond,{branch:cond===UNKNOWN?'unknown':!!cond});if(cond===UNKNOWN){warnings.push('A condition was unknown; simulation follows both branches independently and keeps the first concrete continuation.');const a=cloneEnv(env),b=cloneEnv(env);const baseLast=lastId;let ra=null,rb=null;lastId=baseLast;if(st.thenStatement)ra=await execStatement(st.thenStatement,a,depth,loopState);const lastA=lastId;lastId=baseLast;if(st.elseStatement)rb=await execStatement(st.elseStatement,b,depth,loopState);const lastB=lastId;lastId=lastB||lastA||baseLast;for(const [k,v] of a)if(b.has(k)&&sameValue(v,b.get(k)))env.set(k,v);else env.set(k,UNKNOWN);if(ra?.control&&rb?.control&&ra.control===rb.control)return Object.is(ra.value,rb.value)?ra:{control:ra.control,value:UNKNOWN};return null;}return execStatement(cond?st.thenStatement:st.elseStatement,env,depth,loopState);}
      if(ts.isReturnStatement(st)){const v=st.expression?await evalExpr(st.expression,env,depth):undefined;addStep(st,'return','return '+displayValue(v),v,{edgeType:'return',edgeLabel:'return'});return{control:'return',value:v};}
      if(ts.isThrowStatement(st)){const v=st.expression?await evalExpr(st.expression,env,depth):UNKNOWN;addStep(st,'throw','throw '+displayValue(v),v);return{control:'throw',value:v};}
      if(ts.isWhileStatement(st)||ts.isDoStatement(st)||ts.isForStatement(st)){let iterations=0;if(ts.isForStatement(st)&&st.initializer){if(ts.isVariableDeclarationList(st.initializer)){for(const d of st.initializer.declarations){const v=d.initializer?await evalExpr(d.initializer,env,depth):undefined;const injected=bindName(d.name,v,env,checker,depth===0);if(injected)addStep(d,'inject',`inject ${selected.name} = ${displayValue(value)}`,value,{edgeType:'inject',edgeLabel:'injected value'});else addStep(d,'assign',`set ${d.name.getText(sfc)} = ${displayValue(v)}`,v,{edgeType:'assign',edgeLabel:'loop init'});}}else await evalExpr(st.initializer,env,depth);}while(iterations++<maxLoopIterations){const expr=ts.isForStatement(st)?st.condition:st.expression;const cond=expr?await evalExpr(expr,env,depth):true;addStep(expr||st,'condition',`loop condition => ${displayValue(cond)}`,cond,{loopIteration:iterations});if(cond===UNKNOWN){warnings.push('Loop condition became unknown; loop stopped conservatively.');break;}if(!cond&&!(ts.isDoStatement(st)&&iterations===1))break;const body=await execStatement(st.statement,env,depth,{break:false,continue:false});if(body?.control==='return'||body?.control==='throw')return body;if(body?.control==='break')break;if(ts.isForStatement(st)&&st.incrementor)await evalExpr(st.incrementor,env,depth);}if(iterations>maxLoopIterations)warnings.push(`Loop iteration limit (${maxLoopIterations}) reached.`);return null;}
      if(ts.isBreakStatement(st))return{control:'break'};if(ts.isContinueStatement(st))return{control:'continue'};
      if(ts.isSwitchStatement(st)){const value=await evalExpr(st.expression,env,depth);addStep(st.expression,'condition','switch => '+displayValue(value),value);let matched=false;for(const cl of st.caseBlock.clauses){const cv=ts.isCaseClause(cl)?await evalExpr(cl.expression,env,depth):undefined;if(!matched&&(value===UNKNOWN||!ts.isCaseClause(cl)||Object.is(value,cv)))matched=true;if(matched)for(const s of cl.statements){const r=await execStatement(s,env,depth,loopState);if(r?.control==='break')return null;if(r?.control)return r;}}return null;}
      addStep(st,'opaque','opaque statement',UNKNOWN,{opaque:true});warnings.push('Unsupported statement summarized without execution: '+ts.SyntaxKind[st.kind]);return null;};
    const executeFunction=async(func,args,depth)=>{const sff=func.getSourceFile(),cx=this.contextForFile(sff.fileName),env=new Map();for(let i=0;i<func.parameters.length;i++){const p=func.parameters[i],v=i<args.length?args[i]:UNKNOWN;const injected=bindName(p.name,v,env,cx.checker,depth===0);if(injected)addStep(p,'inject',`inject ${selected.name} = ${displayValue(value)}`,value,{edgeType:'inject',edgeLabel:'injected value'});}
      addStep(func,'enter','enter '+functionName(func,sff),undefined,{edgeType:'call',edgeLabel:'enter'});const r=func.body?await execStatement(func.body,env,depth,{}):null;return r?.control==='return'?r.value:undefined;};
    const args=fn.parameters.map(()=>UNKNOWN);
    let result;try{result=await executeFunction(fn,args,0);}catch(e){if(e.code==='SIMULATION_LIMIT')warnings.push(e.message);else throw e;}
    if(!nodes.some(n=>n.role==='inject'))warnings.push('The selected symbol was not reached on the simulated root path, so its requested value could not be injected.');
    return{schemaVersion:'3.0',kind:'simulation',graphId:crypto.randomUUID(),rootId:nodes[0]?.id||'',selectedNodeId:nodes.find(n=>n.role==='inject')?.id||nodes[0]?.id||'',target:{name:selected.name,location:selected.location},input:{symbol:selected.name,value},result:displayValue(result),nodes,edges,
      analysis:{state:warnings.length?'partial':'ready',busy:false,stale:false,pending:[],timings:{lastOperationMs:0},counts:{nodes:nodes.length,edges:edges.length},warnings:uniq(warnings).map(message=>({stage:'Simulation',code:'CONSERVATIVE',message})),coverage:{kind:'safe-static-abstract-interpretation',maxSteps,maxDepth,maxLoopIterations,completeRepositoryAnalysis:false,cutoffs:steps.count>=maxSteps?['maxSteps']:[]}},
      limitations:['Simulation interprets a safe subset of JavaScript/TypeScript AST. It never evals or executes workspace code.','Unknown external calls, dynamic dispatch, async scheduling, getters/proxies, browser APIs and framework runtime behavior become unknown values.','Unknown branches may be explored conservatively; this is not deterministic runtime replay.']};
  }
}
module.exports={ValueEngine,UNKNOWN,displayValue};
