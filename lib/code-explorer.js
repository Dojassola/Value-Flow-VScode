'use strict';
const path=require('node:path');
const crypto=require('node:crypto');
const {Worker}=require('node:worker_threads');
const {spawn}=require('node:child_process');
const {fail,checkAbort,idFor,locKey}=require('./util');
const {makeCodeFlow,sliceData}=require('./code-flow');
function workerParse(input,signal){return new Promise((resolve,reject)=>{
  const worker=new Worker(path.join(__dirname,'analysis-worker.js'),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:256}});
  let done=false;const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();err?reject(err):resolve(result);};
  const abort=()=>finish(Object.assign(new Error('Analysis cancelled'),{code:'CANCELLED'}));
  const timer=setTimeout(()=>finish(new Error('AST parser exceeded 15 seconds. Select a smaller file.')),15000);
  signal?.addEventListener('abort',abort,{once:true});worker.on('message',m=>m.ok?finish(null,m.result):finish(new Error(m.error)));worker.on('error',e=>finish(e));
  worker.on('exit',code=>{if(!done)finish(new Error('Parser worker exited: '+code));});if(signal?.aborted)abort();
});}
function javaParse(input,command='java',signal){return new Promise((resolve,reject)=>{
  // Arguments are never concatenated into a shell command. Input source is stdin.
  const env={...process.env};delete env.JDK_JAVA_OPTIONS;delete env.JAVA_TOOL_OPTIONS;delete env._JAVA_OPTIONS;
  const child=spawn(command,['--source','11',path.join(__dirname,'../java/FlowAst.java'),String(input.offset||0)],{stdio:['pipe','pipe','pipe'],env,windowsHide:true});
  let output='',error='',done=false;const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(err)child.kill();err?reject(err):resolve(result);};
  const timer=setTimeout(()=>finish(new Error('Java AST timeout (20 s). Check codeFlowLens.javaCommand and a JDK 11+ installation.')),20000);
  const abort=()=>finish(Object.assign(new Error('Analysis cancelled'),{code:'CANCELLED'}));signal?.addEventListener('abort',abort,{once:true});
  child.on('error',e=>finish(new Error('Java AST needs a JDK 11+ executable (codeFlowLens.javaCommand). '+e.message)));
  child.stdout.on('data',b=>{output+=b;if(output.length>12_000_000)finish(new Error('Java AST output limit reached'));});child.stderr.on('data',b=>{error=(error+b).slice(-6000);});
  child.stdin.on('error',()=>{});child.on('close',code=>{if(code!==0)return finish(new Error('Java parser: '+(error||'exit '+code)));try{finish(null,JSON.parse(output));}catch(e){finish(new Error('Invalid Java parser response: '+e.message));}});
  child.stdin.end(input.text);if(signal?.aborted)abort();
});}
function at(text,offset,base){const before=text.slice(0,offset),last=before.lastIndexOf('\n');return{...base,line:before.split('\n').length,column:offset-last,endLine:before.split('\n').length,endColumn:offset-last+1};}
class CodeExplorer{
  constructor(adapter,{javaCommand=()=> 'java'}={}){this.adapter=adapter;this.javaCommand=javaCommand;this.cache=new Map();this.graphs=new Map();}
  invalidate(){this.cache.clear();for(const g of this.graphs.values())g.analysis.stale=true;}
  async source(location,signal){const doc=await this.adapter.document(this.adapter.vscode.Uri.parse(location.uri),signal);const text=doc.getText();if(Buffer.byteLength(text,'utf8')>2_000_000)fail('SOURCE_TOO_LARGE','AST source limit is 2 MB per file.');return{text,file:location.file||doc.uri.fsPath,language:doc.languageId,version:doc.version,dirty:doc.isDirty};}
  async parse(location,offset,signal){const source=await this.source(location,signal),key=location.uri+'|'+source.version+'|'+offset+'|'+crypto.createHash('sha256').update(source.text).digest('hex');
    if(this.cache.has(key))return this.cache.get(key);checkAbort(signal);
    let ir;if(source.language==='java'||/\.java$/.test(source.file))ir=await javaParse({...source,offset},this.javaCommand(),signal);
    else if(/\.[cm]?[jt]sx?$/.test(source.file))ir=await workerParse({...source,offset},signal);
    else fail('UNSUPPORTED_AST_LANGUAGE','Code flow supports JavaScript/TypeScript/JSX/TSX and Java. Semantic relationship graphs still use installed language providers.');
    checkAbort(signal);const value={...source,ir};this.cache.set(key,value);while(this.cache.size>24)this.cache.delete(this.cache.keys().next().value);return value;
  }
  async codeFlow(spec,{maxNodes=250,includeCode=true}={},signal){
    const started=Date.now();
    if(!Number.isInteger(maxNodes)||maxNodes<5||maxNodes>500)fail('INVALID_ARGUMENT','maxNodes must be 5..500');
    const target=await this.adapter.target(spec,signal),source=await this.source(target.location,signal);
    const lines=source.text.split('\n');let offset=0;for(let i=0;i<target.location.line-1;i++)offset+=lines[i].length+1;offset+=target.location.column-1;
    const parsed=await this.parse(target.location,offset,signal);checkAbort(signal);
    const graph=makeCodeFlow(parsed.ir,parsed.text,target.location,offset,maxNodes);graph.documentVersion=source.version;graph.dirty=source.dirty;graph.analysis.timings.lastOperationMs=Date.now()-started;
    this.graphs.set(graph.graphId,graph);while(this.graphs.size>16)this.graphs.delete(this.graphs.keys().next().value);
    return includeCode?graph:this.withoutCode(graph);
  }
  withoutCode(g){return JSON.parse(JSON.stringify(g,(k,v)=>['code','expression'].includes(k)?undefined:v));}
  async dataFlow(spec,options={},signal){const graph=await this.codeFlow(spec,{...options,includeCode:true},signal);const result=sliceData(graph,options.nodeId||graph.selectedNodeId,options.direction||'incoming');return options.includeCode?result:this.withoutCode(result);}
  async componentAt(location,signal){const data=await this.parse(location,0,signal);const offset=data.text.split('\n').slice(0,location.line-1).reduce((s,l)=>s+l.length+1,0)+location.column-1;
    const matches=data.ir.components.filter(c=>c.start<=offset&&offset<=c.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start));
    return{...data,component:matches[0],offset};}
  async componentHierarchy(spec,{depth=1,maxNodes=80,includeCode=true,direction='both'}={},signal){
    const started=Date.now();
    if(!Number.isInteger(maxNodes)||maxNodes<2||maxNodes>150)fail('INVALID_ARGUMENT','React maxNodes must be 2..150');
    if(!['incoming','outgoing','both'].includes(direction))fail('INVALID_ARGUMENT','Invalid direction');
    if(!Number.isInteger(depth)||depth<0||depth>3)fail('INVALID_ARGUMENT','React depth must be 0..3');
    const target=await this.adapter.target(spec,signal);let base=target.location,start=await this.componentAt(base,signal);
    if(!start.component || start.component.children.some(c=>c.start<=start.offset&&start.offset<c.end)){const defs=await this.adapter.definitions(target,signal);if(defs.items.length===1){base=defs.items[0];start=await this.componentAt(base,signal);}}
    if(!start.component)fail('NOT_A_COMPONENT','Select a named React component containing JSX, or its JSX usage. Anonymous/default expressions and server-only modules may require opening their named implementation.');
    const nodes=new Map(),edges=new Map(),warnings=[],queue=[];let referenceCut=false;
    const add=(c,data,base,layer)=>{const location=at(data.text,c.selection.start,base),id=idFor('component',locKey(location));if(nodes.has(id))return nodes.get(id);if(nodes.size>=maxNodes){referenceCut=true;return null;}const n={id,type:'component',role:'component',name:c.name,location,code:c.code,sourceStartLine:at(data.text,c.start,base).line,layer,componentExports:c.exports,reactExpand:true};nodes.set(id,n);return n;};
    const root=add(start.component,start,base,0);root.role='root';
    queue.push({node:root,data:start,component:start.component,base,remaining:depth});const seen=new Set();
    const connect=(parent,child,site,props)=>{if(!parent||!child)return;const id=idFor('renders',parent.id+'|'+child.id);let e=edges.get(id);if(!e){e={id,from:parent.id,to:child.id,type:'renders',label:'JSX renders',source:'jsx-ast+definition-provider',locations:[],props:[]};edges.set(id,e);}if(!e.locations.some(l=>locKey(l)===locKey(site))){e.locations.push(site);e.props.push(...props);}};
    for(let i=0;i<queue.length;i++){
      checkAbort(signal);const item=queue[i];if(item.remaining<=0||seen.has(item.node.id))continue;seen.add(item.node.id);
      if(direction!=='incoming')for(const child of item.component.children.slice(0,100)){
        const site=at(item.data.text,child.start,item.base);
        try{const defs=await this.adapter.definitions({name:child.name,location:site},signal);
          if(!defs.items.length){warnings.push('Unresolved JSX tag '+child.name+' at '+site.file+':'+site.line);continue;}
          for(const def of defs.items.slice(0,3)){const data=await this.componentAt(def,signal);if(!data.component){warnings.push('JSX target '+child.name+' has no named component AST in allowed source.');continue;}const n=add(data.component,data,def,item.node.layer+1);connect(item.node,n,site,child.props);if(n)queue.push({node:n,data,component:data.component,base:def,remaining:item.remaining-1});}
        }catch(e){checkAbort(signal);warnings.push(child.name+': '+e.message);}
      }
      if(direction!=='outgoing'){
        try{const refs=await this.adapter.references({name:item.node.name,location:item.node.location},signal);if(refs.items.length>100)referenceCut=true;
          for(const ref of refs.items.slice(0,100)){const data=await this.componentAt(ref,signal);if(!data.component)continue;
            const usage=data.component.children.find(c=>c.start<=data.offset&&data.offset<c.end);if(!usage)continue;
            // Reference provider links this exact JSX tag to the selected component.
            const n=add(data.component,data,ref,item.node.layer-1);connect(n,item.node,ref,usage.props);if(n)queue.push({node:n,data,component:data.component,base:ref,remaining:item.remaining-1});}
        }catch(e){checkAbort(signal);warnings.push('Parents: '+e.message);}
      }
    }
    const g={schemaVersion:'2.0',kind:'react-hierarchy',graphId:crypto.randomUUID(),rootId:root.id,target:{name:root.name,location:root.location},nodes:[...nodes.values()],edges:[...edges.values()],
      analysis:{state:warnings.length||referenceCut?'partial':'ready',busy:false,stale:false,pending:[],timings:{lastOperationMs:Date.now()-started},counts:{nodes:nodes.size,edges:edges.size},warnings:[...new Set(warnings)].map(message=>({stage:'React',code:'LIMITATION',message})),coverage:{kind:'static-jsx-hierarchy',completeRepositoryAnalysis:false,cutoffs:referenceCut?['reactBudget']:[],depth}},
      limitations:['Static JSX relationships, not the mounted runtime React tree. Conditional JSX and props are expressions, not observed runtime values.','React.createElement without JSX, routing configuration, dynamic component factories, render props and Context propagation are not inferred.']};
    this.graphs.set(g.graphId,g);while(this.graphs.size>16)this.graphs.delete(this.graphs.keys().next().value);return includeCode?g:this.withoutCode(g);
  }
}
module.exports={CodeExplorer,workerParse,javaParse};
