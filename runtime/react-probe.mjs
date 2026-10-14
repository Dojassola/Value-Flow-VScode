/** Optional source instrumentation: explicit names, committed state, actual
 * effect setup/cleanup and synchronous causal spans. Uses PUBLIC React hooks.
 * No network/transport; inert unless a Code Flow Lens runtime session is active.
 * Copy this file into development code; never necessary in production. */
const bridge=()=>typeof window==='undefined'?null:window.__CODE_FLOW_RUNTIME__;
function emit(type,data){try{return bridge()?.emit(type,data);}catch{}}
function span(label,source,fn){const p=bridge();if(!p)return fn();const token=p.begin(label,source);try{const value=fn();p.end(token,'returned');return value;}catch(error){p.end(token,'threw');emit('error',{label,error:String(error),source});throw error;}}
export function createReactProbe(React){
  function useState(label,initial,source){
    const [value,setValue]=React.useState(initial);
    React.useEffect(()=>{emit('state.commit',{label,value,source});},[label,value]);
    const set=React.useCallback(next=>{emit('state.request',{label,next:typeof next==='function'?'[updater]':next,source});return setValue(next);},[label]);
    return [value,set];
  }
  function effect(hook,label,setup,deps,source){hook(()=>span(label,source,()=>{
    emit('effect.setup',{label,source});let cleanup;
    try{cleanup=setup();}catch(e){emit('effect.error',{label,error:String(e),source});throw e;}
    if(typeof cleanup==='function')return()=>span(label+':cleanup',source,()=>{emit('effect.cleanup',{label,source});return cleanup();});
    return cleanup;
  }),deps);}
  function useEffect(label,setup,deps,source){return effect(React.useEffect,label,setup,deps,source);}
  function useLayoutEffect(label,setup,deps,source){return effect(React.useLayoutEffect,label,setup,deps,source);}
  function useValue(label,value,source){React.useEffect(()=>{emit('value.commit',{label,value,source});},[label,value]);return value;}
  function onRender(id,phase,actualDuration,baseDuration,startTime,commitTime){emit('profiler.commit',{label:id,phase,actualDuration,baseDuration,startTime,commitTime});}
  return {useState,useEffect,useLayoutEffect,useValue,onRender,span};
}
export function recordValue(label,value,source){emit('value',{label,value,source});}
