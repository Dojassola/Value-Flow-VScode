'use strict';
const ts=require('../vendor/typescript');

function scriptKind(file){return /\.tsx$/i.test(file)?ts.ScriptKind.TSX:/\.jsx$/i.test(file)?ts.ScriptKind.JSX:/\.[cm]?js$/i.test(file)?ts.ScriptKind.JS:ts.ScriptKind.TS;}
function literalFromTypeNode(node,sf){
  if(!node)return undefined;
  if(ts.isLiteralTypeNode(node)){
    const l=node.literal;
    if(ts.isStringLiteralLike(l))return l.text;
    if(ts.isNumericLiteral(l))return Number(l.text);
    if(l.kind===ts.SyntaxKind.TrueKeyword)return true;
    if(l.kind===ts.SyntaxKind.FalseKeyword)return false;
  }
  if(ts.isUnionTypeNode(node)){
    for(const t of node.types){const v=literalFromTypeNode(t,sf);if(v!==undefined)return v;}
    if(node.types.some(t=>t.kind===ts.SyntaxKind.StringKeyword))return 'example';
    if(node.types.some(t=>t.kind===ts.SyntaxKind.NumberKeyword))return 1;
    if(node.types.some(t=>t.kind===ts.SyntaxKind.BooleanKeyword))return true;
  }
  switch(node.kind){
    case ts.SyntaxKind.StringKeyword:return 'example';
    case ts.SyntaxKind.NumberKeyword:return 1;
    case ts.SyntaxKind.BooleanKeyword:return true;
    case ts.SyntaxKind.BigIntKeyword:return 1;
    case ts.SyntaxKind.ObjectKeyword:return {};
    case ts.SyntaxKind.AnyKeyword:case ts.SyntaxKind.UnknownKeyword:return null;
  }
  if(ts.isArrayTypeNode(node))return [];
  if(ts.isTupleTypeNode(node))return node.elements.map(t=>literalFromTypeNode(t,sf)??null);
  if(ts.isTypeLiteralNode(node)){
    const out={};for(const m of node.members){if(ts.isPropertySignature(m)&&m.name){const k=m.name.getText(sf).replace(/^['"]|['"]$/g,'');const v=literalFromTypeNode(m.type,sf);if(v!==undefined||!m.questionToken)out[k]=v===undefined?null:v;}}return out;
  }
  if(ts.isFunctionTypeNode(node))return undefined;
  if(ts.isTypeReferenceNode(node)){
    const n=node.typeName.getText(sf);
    if(/^(Array|ReadonlyArray|Set)$/i.test(n))return [];
    if(/^(Record|Map)$/i.test(n))return {};
    if(/^(Date)$/i.test(n))return new Date(0).toISOString();
    if(/^(React\.ReactNode|ReactNode|JSX\.Element|ReactElement)$/i.test(n))return 'Preview';
  }
  return undefined;
}
function valueFromInitializer(node,sf){
  if(!node)return undefined;
  if(ts.isStringLiteralLike(node))return node.text;
  if(ts.isNumericLiteral(node))return Number(node.text);
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true;if(node.kind===ts.SyntaxKind.FalseKeyword)return false;if(node.kind===ts.SyntaxKind.NullKeyword)return null;
  if(ts.isArrayLiteralExpression(node))return node.elements.map(e=>valueFromInitializer(e,sf)??null);
  if(ts.isObjectLiteralExpression(node)){const out={};for(const p of node.properties){if(ts.isPropertyAssignment(p)){const k=p.name.getText(sf).replace(/^['"]|['"]$/g,'');out[k]=valueFromInitializer(p.initializer,sf)??null;}else if(ts.isShorthandPropertyAssignment(p))out[p.name.text]=null;}return out;}
  return undefined;
}
function findTypeDecl(sf,name){for(const st of sf.statements){if((ts.isInterfaceDeclaration(st)||ts.isTypeAliasDeclaration(st))&&st.name.text===name)return st;}return null;}
function propsFromType(type,sf,notes,seen=new Set()){
  if(!type)return {};
  if(ts.isTypeLiteralNode(type)){
    const out={};for(const m of type.members){if(!ts.isPropertySignature(m)||!m.name)continue;const k=m.name.getText(sf).replace(/^['"]|['"]$/g,'');if(m.type&&ts.isFunctionTypeNode(m.type)){notes.push(`${k}: callback omitted from JSON preview props`);continue;}let v=literalFromTypeNode(m.type,sf);if(v===undefined&&!m.questionToken)v=null;if(v!==undefined)out[k]=v;}return out;
  }
  if(ts.isTypeReferenceNode(type)){
    const name=type.typeName.getText(sf);if(seen.has(name))return {};seen.add(name);const decl=findTypeDecl(sf,name);if(ts.isInterfaceDeclaration(decl)){const fake=ts.factory.createTypeLiteralNode(decl.members);return propsFromType(fake,sf,notes,seen);}if(ts.isTypeAliasDeclaration(decl))return propsFromType(decl.type,sf,notes,seen);
  }
  if(ts.isIntersectionTypeNode(type))return Object.assign({},...type.types.map(t=>propsFromType(t,sf,notes,seen)));
  return {};
}
function findComponent(sf,name){let found=null;function visit(n){if(found)return;if((ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n))&&n.name?.text===name)found=n;else if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text===name)found=n;else ts.forEachChild(n,visit);}visit(sf);return found;}
function inferReactProps(text,file,componentName){
  const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,scriptKind(file)),component=findComponent(sf,componentName),notes=[];if(!component)return{props:{},notes:['Component declaration was not found for prop inference.'],confidence:'none'};
  let fn=component;if(ts.isVariableDeclaration(component))fn=component.initializer;
  const out={};
  const applyBinding=(nameNode,typeNode,initializer)=>{
    if(ts.isObjectBindingPattern(nameNode))for(const el of nameNode.elements){if(!ts.isBindingElement(el))continue;const key=(el.propertyName||el.name).getText(sf).replace(/^['"]|['"]$/g,'');let v=valueFromInitializer(el.initializer,sf);if(v===undefined&&typeNode){const typed=propsFromType(typeNode,sf,notes);if(Object.prototype.hasOwnProperty.call(typed,key))v=typed[key];}if(v===undefined)v=null;out[key]=v;}
    else if(ts.isIdentifier(nameNode)&&typeNode)Object.assign(out,propsFromType(typeNode,sf,notes));
  };
  if(fn&&ts.isFunctionLike(fn)&&fn.parameters?.length){const p=fn.parameters[0];if(p.type)Object.assign(out,propsFromType(p.type,sf,notes));applyBinding(p.name,p.type,p.initializer);}
  if(ts.isClassDeclaration(component)){
    const heritage=component.heritageClauses?.flatMap(h=>h.types)||[];for(const h of heritage){if(!/Component|PureComponent/.test(h.expression.getText(sf))||!h.typeArguments?.[0])continue;Object.assign(out,propsFromType(h.typeArguments[0],sf,notes));}
  }
  // Infer property usage when explicit types are missing: props.foo -> null.
  if(fn){let propsName=null;if(ts.isFunctionLike(fn)&&fn.parameters?.[0]&&ts.isIdentifier(fn.parameters[0].name))propsName=fn.parameters[0].name.text;function scan(n){if(propsName&&ts.isPropertyAccessExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text===propsName&&!Object.prototype.hasOwnProperty.call(out,n.name.text))out[n.name.text]=null;ts.forEachChild(n,scan);}scan(fn);}
  return{props:out,notes,confidence:Object.keys(out).length?'inferred':'empty'};
}
module.exports={inferReactProps};
