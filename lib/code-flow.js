'use strict';
const { idFor } = require('./util');
function makeCodeFlow(ir, text, location, selectedOffset = 0, maxNodes = 250) {
  const nodes = [], edges = [], warnings = [...ir.warnings]; let nextId = 0;
  const lineStarts = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  function position(offset) { offset = Math.max(0, Math.min(text.length, offset || 0)); let lo=0, hi=lineStarts.length;while(lo+1<hi){const mid=(lo+hi)>>1;if(lineStarts[mid]<=offset)lo=mid;else hi=mid;}return {line:lo+1,column:offset-lineStarts[lo]+1}; }
  function loc(a) { const p = position(a.start), end = position(a.end); return { ...location, ...p, endLine:end.line,endColumn:end.column }; }
  const blank = { start: ir.end, end: ir.end, code: '// end', reads: [], writes: [], calls: [] };
  function node(atom, kind) {
    if(nodes.length>=maxNodes) { const error = new Error('Function exceeds '+maxNodes+' code blocks. Select a smaller function or raise the code-flow limit.');error.code='CODE_FLOW_LIMIT';throw error; }
    const n={id:'block:'+nextId++, type:'codeBlock',role:kind,name:atom.name||kind,location:loc(atom),code:atom.code,
      start:atom.start,end:atom.end,reads:atom.reads||[],writes:(atom.writes||[]).map(w=>kind==='opaque'?{...w,maybe:true}:w),calls:atom.calls||[],layer:0};nodes.push(n);return n.id;
  }
  const edge=(from,to,type='next',label=type)=>{if(from&&to&&!edges.some(e=>e.from===from&&e.to===to&&e.type===type&&e.label===label))edges.push({id:idFor('edge',from+'|'+to+'|'+type+'|'+label),from,to,type,label,source:'ast-control-flow'});};
  const exit=node({...blank,name:'Exit'},'exit'), thrown=node({...blank,name:'Exceptional exit',code:'// explicit throw leaves this function'},'throwExit');
  function build(s, next, ctx={}) {
    if(!s)return next;
    if(s.kind==='block'){let head=next;for(let i=s.statements.length-1;i>=0;i--)head=build(s.statements[i],head,ctx);return head;}
    if(s.kind==='if'){const id=node(s.atom,'condition');edge(id,build(s.then,next,ctx),'true','true');edge(id,build(s.else,next,ctx),'false','false');return id;}
    if(s.kind==='loop'||s.kind==='do'){
      const test=node(s.atom,'condition');const update=build(s.update,test,ctx);
      const body=build(s.body,update,{...ctx,breakTo:next,continueTo:update});
      edge(test,body,'true',s.iteration?'next item':'true');if(!s.atom.always)edge(test,next,'false',s.iteration?'done':'false');
      return build(s.init,s.kind==='do'?body:test,ctx);
    }
    if(s.kind==='switch'){
      const id=node(s.atom,'switch');let head=next,hasDefault=false;
      for(let i=s.cases.length-1;i>=0;i--){const c=s.cases[i];head=build(c.body,c.fallthrough?head:next,{...ctx,breakTo:next});edge(id,head,'case',c.label);if(c.label==='default')hasDefault=true;}
      if(!hasDefault)edge(id,next,'default','no match');return id;
    }
    const id=node(s.atom,s.kind);
    if(s.kind==='return')edge(id,exit,'return');
    else if(s.kind==='throw')edge(id,thrown,'throw');
    else if(s.kind==='break')edge(id,ctx.breakTo||exit,'break');
    else if(s.kind==='continue')edge(id,ctx.continueTo||exit,'continue');
    else if(s.kind==='opaque'){edge(id,next,'unknown_control','unknown continuation');warnings.push('Opaque blocks may exit/throw or alter control; paths crossing them are not proven executable.');}
    else edge(id,next);
    return id;
  }
  const body=build(ir.body,exit),entry=node(ir.entry,'entry');edge(entry,body);
  const reachable=new Set([entry]),queue=[entry];for(let i=0;i<queue.length;i++)for(const e of edges)if(e.from===queue[i]&&!reachable.has(e.to)){reachable.add(e.to);queue.push(e.to);}
  // Fixed point reaching definitions over statement-level CFG; overwrite kills
  // previous local definitions, branch joins and loops union possible producers.
  const byId=new Map(nodes.map(n=>[n.id,n])), outs=new Map(nodes.map(n=>[n.id,new Map()]));
  const ins=new Map();let changed=true,iterations=0;
  const signature=m=>[...m].sort().map(([key,set])=>key+':'+[...set].sort().join(',')).join('|');
  while(changed&&iterations++<200){changed=false;for(const n of [...nodes].reverse()){
    if(!reachable.has(n.id))continue;const input=new Map();
    for(const e of edges.filter(e=>e.to===n.id&&reachable.has(e.from)))for(const [key,set]of outs.get(e.from)||[]){if(!input.has(key))input.set(key,new Set());for(const id of set)input.get(key).add(id);}
    const output=new Map([...input].map(([key,set])=>[key,new Set(set)]));for(const w of n.writes)output.set(w.id,new Set([...(w.maybe?[...(output.get(w.id)||[])]:[]),n.id]));
    if(signature(output)!==signature(outs.get(n.id))){outs.set(n.id,output);changed=true;}ins.set(n.id,input);
  }}
  if(changed)warnings.push('Data-flow fixed point hit iteration budget; reaching definitions may be incomplete.');
  const dataEdges=[], external=new Map();let externalCut=false;
  for(const n of [...nodes]){
    n.unreachable=!reachable.has(n.id);if(n.unreachable)continue;
    for(const r of n.reads){const producers=ins.get(n.id)?.get(r.id);
      let from=producers?[...producers]:[];
      if(!from.length){
        if(!external.has(r.id)){
          if(nodes.length>=maxNodes){externalCut=true;continue;}
          const ext={id:idFor('input',r.id),type:'codeBlock',role:r.boundary||'external',name:r.name,code:r.boundary?'// Opaque return: '+r.name:'// External / not defined on this path: '+r.name,
            location:loc(r),start:r.start,end:r.end,reads:[],writes:[r],calls:[],layer:-1};external.set(r.id,ext);nodes.push(ext);byId.set(ext.id,ext);
        }from=[external.get(r.id).id];
      }
      for(const id of from){const e={id:idFor('data',id+'|'+n.id+'|'+r.id),from:id,to:n.id,type:'data',label:r.name,bindingId:r.id,source:'local-reaching-definitions'};if(!dataEdges.some(old=>old.id===e.id))dataEdges.push(e);}
    }
  }
  if(externalCut)warnings.push('Boundary node budget reached; some external data sources are omitted.');
  const distances=new Map([[entry,0]]);const q=[entry];for(let i=0;i<q.length;i++)for(const e of edges)if(e.from===q[i]&&!distances.has(e.to)){distances.set(e.to,distances.get(q[i])+1);q.push(e.to);}
  for(const n of nodes)if(n.role!=='external'&&n.role!=='opaque-call-result')n.layer=distances.get(n.id)||0;
  const candidates=nodes.filter(n=>n.type==='codeBlock'&&n.start<=selectedOffset&&selectedOffset<=n.end&&n.role!=='entry'&&!['external','opaque-call-result'].includes(n.role));
  candidates.sort((a,b)=>(a.end-a.start)-(b.end-b.start));const selected=candidates[0]||byId.get(entry);
  const binding=[...selected.reads,...selected.writes].find(r=>r.start<=selectedOffset&&selectedOffset<=r.end);
  return { schemaVersion:'2.0',graphId:idFor('code',location.uri+'|'+ir.start+'|'+text),kind:'code-flow',rootId:entry,selectedNodeId:selected.id,selectedBinding:binding?.id,
    target:{name:ir.entry.name,location:byId.get(entry).location},nodes,edges,dataEdges,
    analysis:{state:warnings.length?'partial':'ready',busy:false,stale:false,counts:{nodes:nodes.length,edges:edges.length},timings:{},pending:[],warnings:[...new Set(warnings)].map(message=>({stage:'AST',code:'LIMITATION',message})),
      coverage:{kind:'intraprocedural-statement-cfg-and-reaching-definitions',parser:ir.parser,completeRepositoryAnalysis:false,cutoffs:[...(changed?['dataflowIterations']:[]),...(externalCut?['externalNodeBudget']:[])],maxNodes}},
    limitations:['Static possible paths, not execution or concrete values. Conditions are chosen by the user, not evaluated.',
      'No interprocedural value propagation, complete heap/alias analysis, implicit exceptions, async scheduling or framework side effects.',
      'Data dependencies are statement-level; multiple writes in one statement can over-approximate dependencies. Indexed properties are conservative.',
      'try/finally and other opaque control blocks are summarized with an unknown-continuation edge.'] };
}
function sliceData(graph, nodeId, direction='incoming'){
  if(!graph.nodes.some(n=>n.id===nodeId))throw new Error('Unknown code block');
  const seen=new Set([nodeId]),queue=[nodeId];for(let i=0;i<queue.length;i++)for(const e of graph.dataEdges||[]){let next;if(direction!=='outgoing'&&e.to===queue[i])next=e.from;if(direction!=='incoming'&&e.from===queue[i])next=e.to;if(next&&!seen.has(next)){seen.add(next);queue.push(next);}}
  return {...graph,rootId:nodeId,originalRootId:graph.rootId,nodes:graph.nodes.filter(n=>seen.has(n.id)),dataEdges:(graph.dataEdges||[]).filter(e=>seen.has(e.from)&&seen.has(e.to)),edges:(graph.dataEdges||[]).filter(e=>seen.has(e.from)&&seen.has(e.to)),slice:{direction,nodeId,kind:'possible-statement-data-dependencies'}};
}
module.exports={makeCodeFlow,sliceData};
