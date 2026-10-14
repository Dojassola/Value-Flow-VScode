'use strict';
const { VSCodeAdapter } = require('./vscode-adapter');
const { LocalLanguageClient } = require('./local-language-client');
const { checkAbort } = require('./util');
const LOCAL_LANGS = new Set(['typescript','typescriptreact','javascript','javascriptreact','java']);
class HybridAdapter extends VSCodeAdapter {
  constructor(vscode,{log=()=>{},providerTimeoutMs=4000,localEngineTimeoutMs=3000,valueEngineTimeoutMs=6000,localEngineStartupMs=6000,localEngineMaxFiles=8000,mode='local',cacheDir=null}={}){
    super(vscode,{log,timeoutMs:providerTimeoutMs});this.log=log;this.mode=mode;this.local=new LocalLanguageClient(vscode,{log,queryTimeoutMs:localEngineTimeoutMs,heavyTimeoutMs:valueEngineTimeoutMs,startupTimeoutMs:localEngineStartupMs,maxFiles:localEngineMaxFiles,cacheDir});this.semanticSource='code-flow-lens-local-engine';
  }
  localSupported(target){return LOCAL_LANGS.has(target?.languageId)||/\.(?:[cm]?[jt]sx?|java)$/i.test(target?.location?.file||target?.location?.uri||'');}
  useLocal(target){return this.mode!=='vscode'&&this.localSupported(target);}
  async localOrFallback(op,args,target,signal,fallback){
    if(!this.useLocal(target))return fallback();
    try{return await this.local.query(op,args,target,signal);}catch(error){checkAbort(signal);this.log(`Local engine ${op} failed: ${error.code||'ERROR'}: ${error.message}`);if(this.mode==='hybrid')return fallback();throw error;}
  }
  invalidate(options={}){super.invalidate();this.local.invalidate(options);}
  updateSettings({mode,providerTimeoutMs,localEngineTimeoutMs,valueEngineTimeoutMs,localEngineStartupMs,localEngineMaxFiles}){this.mode=mode||this.mode;if(providerTimeoutMs)this.cache.timeoutMs=providerTimeoutMs;this.local.updateSettings({queryTimeoutMs:localEngineTimeoutMs,heavyTimeoutMs:valueEngineTimeoutMs,startupTimeoutMs:localEngineStartupMs,maxFiles:localEngineMaxFiles});}
  async ensureLanguage(target,signal){
    if(this.useLocal(target)){
      if(target.languageId==='java')return ['Java semantic relations are served by the Code Flow Lens local index. It is fast and editor-independent, but overload/type resolution is conservative; local control/data flow still uses the JDK parser.'];
      return [];
    }
    return super.ensureLanguage(target,signal);
  }
  definitions(target,signal){return this.localOrFallback('definitions',{target},target,signal,()=>super.definitions(target,signal));}
  implementations(target,signal){return this.localOrFallback('implementations',{target},target,signal,()=>super.implementations(target,signal));}
  references(target,signal){return this.localOrFallback('references',{target},target,signal,()=>super.references(target,signal));}
  prepare(target,signal){return this.localOrFallback('prepare',{target},target,signal,()=>super.prepare(target,signal));}
  calls(item,direction,signal){const target={languageId:item?.opaque?.java?'java':undefined,location:item?.location};return this.localOrFallback('calls',{item,direction},target,signal,()=>super.calls(item,direction,signal));}
  containingSymbols(location,signal){const target={languageId:/\.java$/i.test(location.file||location.uri)?'java':undefined,location};return this.localOrFallback('containingSymbols',{location},target,signal,()=>super.containingSymbols(location,signal));}

  valueTrace(target,options,signal){if(/\.java$/i.test(target?.location?.file||target?.location?.uri||''))return Promise.reject(Object.assign(new Error('Value tracing currently supports TypeScript/JavaScript/JSX/TSX with the embedded engine.'),{code:'VALUE_TRACE_UNSUPPORTED'}));return this.local.query('valueTrace',{target,options},target,signal);}
  correlate(targets,options,signal){const target=targets?.[0];if(!target||targets.some(t=>/\.java$/i.test(t?.location?.file||t?.location?.uri||'')))return Promise.reject(Object.assign(new Error('Multi-symbol value correlation currently supports TypeScript/JavaScript/JSX/TSX.'),{code:'CORRELATION_UNSUPPORTED'}));return this.local.query('correlate',{targets,options},target,signal);}
  simulateValue(target,options,signal){if(/\.java$/i.test(target?.location?.file||target?.location?.uri||''))return Promise.reject(Object.assign(new Error('Static value simulation currently supports TypeScript/JavaScript/JSX/TSX.'),{code:'SIMULATION_UNSUPPORTED'}));return this.local.query('simulateValue',{target,options},target,signal);}

  findSymbols(args,signal){if(args.file&&/\.(?:[cm]?[jt]sx?|java)$/i.test(args.file)&&this.mode!=='vscode'){const target={languageId:/\.java$/i.test(args.file)?'java':'typescript',location:{uri:args.file.startsWith('file:')?args.file:this.vscode.Uri.file(args.file).toString(),file:args.file}};return this.localOrFallback('findSymbols',{args},target,signal,()=>super.findSymbols(args,signal));}return super.findSymbols(args,signal);}
  dispose(){this.local.dispose();}
}
module.exports={HybridAdapter};
