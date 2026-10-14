'use strict';
/** Runs BEFORE the application in the main page. Returns only bounded data.
 * React Fiber observation is best-effort private-API introspection. SDK spans
 * are explicit app instrumentation; commits are NOT reported as effect runs. */
function installProbe(options){
  if(window!==window.top||window.__CODE_FLOW_RUNTIME__)return;
  const sensitive=/password|passwd|token|secret|authorization|cookie|session|credential|api.?key|access.?key|cpf|email/i;
  let events=[],seq=0,dropped=0,active=null;const roots=new Map(),fiberIds=new WeakMap();let fiberSeq=0;
  const safe=(value,depth=0,key='',seen=new WeakSet())=>{
    if(sensitive.test(key))return '[REDACTED]';if(value==null||typeof value==='boolean'||typeof value==='number')return value;
    if(typeof value==='string')return value.slice(0,600).replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[JWT]');
    if(typeof value!=='object')return '['+typeof value+']';if(depth>=3)return '[depth limit]';if(seen.has(value))return '[circular]';seen.add(value);
    if(value instanceof Element||value instanceof Node)return '[DOM]';const out=Array.isArray(value)?[]:{};let count=0;
    try{const desc=Object.getOwnPropertyDescriptors(value);for(const key of Object.keys(desc)){if(++count>30)break;if(['children','_owner','__proto__','constructor','prototype','ref'].includes(key))continue;out[key]=Object.hasOwn(desc[key],'value')?safe(desc[key].value,depth+1,key,seen):'[getter not invoked]';}}catch{return '[unreadable]';}return out;
  };
  const url=value=>{try{const u=new URL(value,location.href);return ['http:','https:'].includes(u.protocol)?u.origin+u.pathname:'['+u.protocol+']';}catch{return '[invalid URL]';}};
  const emit=(type,data={},cause=active)=>{const event={id:'p'+(++seq),type:String(type).slice(0,60),at:Date.now(),cause:cause||null,data:safe(data)};events.push(event);if(events.length>500){events.shift();dropped++;}return event.id;};
  const api={version:1,emit:(type,data)=>emit('probe.'+type,options.captureState?(sensitive.test(data?.label||'')?{...data,value:'[REDACTED]',next:'[REDACTED]'}:data):{label:data?.label,source:data?.source,values:'captureState disabled'}),
    begin(label,source){const previous=active;const id=emit('probe.span_start',{label,source},previous);active=id;return{id,previous};},
    end(span,outcome){emit('probe.span_end',{outcome},span.id);active=span.previous;},
    drain(){const result={events,dropped};events=[];return result;},safe,
    react(){const components=[];let visited=0;const seen=new Set();const walk=(f,parent=null)=>{
      if(!f||seen.has(f)||visited++>=2000||components.length>=120)return;seen.add(f);const isComponent=[0,1,2,11,14,15].includes(f.tag);let owner=parent;
      if(isComponent){let id=fiberIds.get(f)||fiberIds.get(f.alternate);if(!id)id='c'+(++fiberSeq);fiberIds.set(f,id);if(f.alternate)fiberIds.set(f.alternate,id);const t=f.elementType||f.type;const name=typeof t==='function'?(t.displayName||t.name):t?.displayName||t?.render?.displayName||t?.render?.name||t?.type?.name||'Anonymous';
        const component={id,parent,name:String(name).slice(0,120),tag:f.tag,source:f._debugSource?{file:f._debugSource.fileName,line:f._debugSource.lineNumber}:null};
        if(options.captureState){component.props=safe(f.memoizedProps);if(f.stateNode?.isReactComponent)component.state=safe(f.memoizedState);else{component.hooks=[];let h=f.memoizedState,i=0;const hs=new Set();while(h&&typeof h==='object'&&i<30&&!hs.has(h)){hs.add(h);if(h.queue&&typeof h.queue.dispatch==='function')component.hooks.push({slot:i,value:safe(h.memoizedState)});h=h.next;i++;}}}
        components.push(component);owner=id;}
      walk(f.child,owner);walk(f.sibling,parent);
    };for(const root of roots.values())walk(root.current);return{mode:'best-effort React Fiber (private API)',components,truncated:visited>=2000||components.length>=120,valuesIncluded:!!options.captureState,hookNamesAvailable:false};}
  };
  Object.defineProperty(window,'__CODE_FLOW_RUNTIME__',{value:api,configurable:true});
  let hook=window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if(!hook){let renderer=0;hook={supportsFiber:true,renderers:new Map(),inject(info){const id=++renderer;this.renderers.set(id,info);emit('react.renderer',{version:info.version});return id;},onCommitFiberRoot(){},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},checkDCE(){}};Object.defineProperty(window,'__REACT_DEVTOOLS_GLOBAL_HOOK__',{value:hook,configurable:true});}
  const oldCommit=hook.onCommitFiberRoot;hook.onCommitFiberRoot=function(id,root,...rest){try{if(root.current?.memoizedState?.element==null)roots.delete(root);else roots.set(root,root);emit('react.commit',{renderer:id,components:api.react().components.length,meaning:'commit, not effect execution'});}catch{}try{return oldCommit?.call(this,id,root,...rest);}catch{}};
  const originalFetch=window.fetch;
  window.fetch=function(input,init){const id=emit('fetch.start',{url:url(typeof input==='string'?input:input?.url),method:init?.method||input?.method||'GET'});let promise;try{promise=originalFetch.apply(this,arguments);}catch(e){emit('fetch.error',{message:String(e)},id);throw e;}
    promise.then(response=>{emit('fetch.response',{url:url(response.url),status:response.status},id);},error=>{emit('fetch.error',{message:String(error)},id);});return promise;};
  const originalOpen=XMLHttpRequest.prototype.open,originalSend=XMLHttpRequest.prototype.send;const xhrs=new WeakMap();
  XMLHttpRequest.prototype.open=function(method,requestUrl){xhrs.set(this,{method,url:url(requestUrl)});return originalOpen.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(){const id=emit('xhr.start',xhrs.get(this)||{});this.addEventListener('loadend',()=>emit('xhr.complete',{status:this.status,url:url(this.responseURL)},id),{once:true});return originalSend.apply(this,arguments);};
  document.addEventListener('click',e=>{const t=e.target?.closest?.('button,a,input,[role="button"]');if(t)emit('dom.click',{tag:t.tagName,id:t.id,role:t.getAttribute('role')});},true);
  let mutations=0,mutationTimer;
  new MutationObserver(list=>{mutations+=list.length;if(!mutationTimer)mutationTimer=setTimeout(()=>{emit('dom.mutations',{records:mutations});mutations=0;mutationTimer=null;},100);}).observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
  emit('probe.ready',{reactState:!!options.captureState});
}
module.exports={installProbe};
