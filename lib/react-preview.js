'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {createRequire,builtinModules}=require('node:module');
const {Worker}=require('node:worker_threads');
function validateLocalUrl(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password)throw new Error('Preview URL must be http(s) on localhost/127.0.0.1/[::1], without credentials.');return u.toString();}
function projectRoot(file,workspaceRoots){let dir=path.dirname(file);while(workspaceRoots.some(root=>dir===root||dir.startsWith(root+path.sep))){if(fs.existsSync(path.join(dir,'package.json')))return dir;const parent=path.dirname(dir);if(parent===dir)break;dir=parent;}return path.dirname(file);}
/** Isolated browser bundle. Does NOT import/evaluate project modules in Node.
 * Uses project React, TS path aliases, CommonJS/ESM and plain CSS. Unsupported
 * build features fail explicitly; an existing dev-app URL is the alternative. */
function buildPreview({file,exportName,props={},wrapper,roots,maxModules=600,maxBytes=16_000_000}){
  const ts=require('../vendor/typescript');
  const root=projectRoot(file,roots),req=createRequire(path.join(root,'package.json'));
  const canonicalRoots=roots.map(r=>fs.realpathSync(r));
  const dependencyRoots=(req.resolve.paths('react')||[]).filter(r=>fs.existsSync(r)).map(r=>fs.realpathSync(r));
  const allowed=f=>[...canonicalRoots,...dependencyRoots].some(r=>f===r||f.startsWith(r+path.sep));
  const modules=[],byFile=new Map();let bytes=0;const notes=[];
  let options={};const cfg=ts.findConfigFile(path.dirname(file),ts.sys.fileExists,'tsconfig.json');
  if(cfg&&allowed(fs.realpathSync(cfg))){const config=ts.readConfigFile(cfg,ts.sys.readFile);if(!config.error)options=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(cfg)).options;}
  function locate(base){for(const candidate of [base,base+'.tsx',base+'.ts',base+'.jsx',base+'.js',base+'.mjs',base+'.cjs',path.join(base,'index.tsx'),path.join(base,'index.ts'),path.join(base,'index.jsx'),path.join(base,'index.js')])if(fs.existsSync(candidate)&&fs.statSync(candidate).isFile()&&!candidate.endsWith('.d.ts'))return fs.realpathSync(candidate);return null;}
  function resolve(spec,importer){
    if(builtinModules.includes(spec)||spec.startsWith('node:'))throw new Error('Browser preview cannot load Node builtin '+spec+'. Use the running-app URL for server-only components.');
    if(/^(https?:|data:|file:)/.test(spec))throw new Error('Remote or file-protocol import is not allowed in isolated preview: '+spec);
    let found=null;
    for(const [alias,targets]of Object.entries(options.paths||{})){
      const [left,right='']=alias.split('*');if(alias.includes('*')?spec.startsWith(left)&&spec.endsWith(right):alias===spec){const middle=alias.includes('*')?spec.slice(left.length,spec.length-right.length):'';for(const target of targets){found=locate(path.resolve(options.baseUrl||options.pathsBasePath||path.dirname(cfg),target.replace('*',middle)));if(found)break;}}
      if(found)break;
    }
    if(!found&&(spec.startsWith('.')||path.isAbsolute(spec)))found=locate(path.resolve(path.dirname(importer),spec));
    if(!found&&options.baseUrl)found=locate(path.resolve(options.baseUrl,spec));
    if(!found){try{found=fs.realpathSync(createRequire(importer).resolve(spec));}catch{throw new Error('Cannot resolve '+spec+' from '+path.basename(importer)+'. Install project dependencies or use the app/Storybook URL. Vite/webpack-only aliases are not auto-invented.');}}
    if(!allowed(found))throw new Error('Preview import escapes workspace/dependency roots: '+found);
    if(/(^|[\\/])(?:\.env(?:\.|$)|id_rsa|id_ed25519)|\.(pem|key)$/i.test(found))throw new Error('Secret file blocked');
    return found;
  }
  function compile(f){
    f=fs.realpathSync(f);if(!allowed(f))throw new Error('Preview module escapes allowed workspace/dependency roots');if(byFile.has(f))return byFile.get(f);
    if(modules.length>=maxModules)throw new Error('Preview module budget reached. Use your existing dev server URL.');
    const stat=fs.statSync(f);bytes+=stat.size;if(bytes>maxBytes)throw new Error('Preview source budget reached (16 MB). Use the running-app URL.');
    const id=modules.length;byFile.set(f,id);const record={id,file:path.relative(root,f),code:'',deps:{}};modules.push(record);
    let input=fs.readFileSync(f,'utf8');
    if(f.endsWith('.json'))record.code='module.exports=JSON.parse('+JSON.stringify(input)+');';
    else if(f.endsWith('.css')){
      if(f.endsWith('.module.css')||/@import\b|url\s*\(/i.test(input))throw new Error('CSS modules, @import and CSS url assets need the real app bundler. Use the app/Storybook URL.');
      record.code='var style=document.createElement("style");style.textContent='+JSON.stringify(input)+';document.head.append(style);module.exports={};';
    }else if(/\.(png|jpe?g|gif|webp|svg)$/i.test(f)){
      const mime={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml'}[path.extname(f).slice(1).toLowerCase()];record.code='module.exports='+JSON.stringify('data:'+mime+';base64,'+fs.readFileSync(f).toString('base64'))+';';
    }else{
      if(!/\.[cm]?[jt]sx?$/.test(f))throw new Error('Unsupported preview module '+path.extname(f)+'. Use the app/Storybook URL.');
      const result=ts.transpileModule(input,{fileName:f,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,moduleDetection:ts.ModuleDetectionKind.Force,esModuleInterop:true,allowJs:true,jsx:ts.JsxEmit.React,jsxFactory:'__CFLReact.createElement',jsxFragmentFactory:'__CFLReact.Fragment'},reportDiagnostics:true});
      if(result.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))throw new Error('Transpile error: '+ts.flattenDiagnosticMessageText(result.diagnostics[0].messageText,'\n'));
      record.code=result.outputText;if(record.code.includes('__CFLReact.'))record.code='var __CFLReact=require("react");\n'+record.code;
      const parsed=ts.createSourceFile(f,record.code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
      function walk(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='require'){
        if(n.arguments.length!==1||!ts.isStringLiteral(n.arguments[0]))throw new Error('Dynamic require is not supported in isolated preview. Use the running-app URL.');
        const spec=n.arguments[0].text;if(record.deps[spec]===undefined)record.deps[spec]=compile(resolve(spec,f));
      }ts.forEachChild(n,walk);}walk(parsed);
    }
    return id;
  }
  const selected=compile(file),react=compile(req.resolve('react'));let dom,modern=true;
  try{dom=compile(req.resolve('react-dom/client'));}catch(e){if(e.code==='MODULE_NOT_FOUND'||/Cannot find module 'react-dom\/client'/.test(e.message)){modern=false;dom=compile(req.resolve('react-dom'));}else throw e;}
  const wrapped=wrapper?compile(wrapper):null;
  const entry=`const React=load(${react}),DOM=load(${dom});const Component=load(${selected})[${JSON.stringify(exportName)}];
    if(!Component)throw new Error('Selected export was not found. Choose an exported component.');
    class Boundary extends React.Component {constructor(p){super(p);this.state={error:null};}componentDidCatch(error){this.setState({error:String(error.message||error)});}render(){return this.state.error?React.createElement('pre',{'data-cfl-error':'true'},'Component error: '+this.state.error):this.props.children;}}
    let element=React.createElement(Component,${JSON.stringify(props)});
    ${wrapped!==null?`element=React.createElement(load(${wrapped}).default,null,element);`:''}
    element=React.createElement(Boundary,null,element);
    ${modern?'DOM.createRoot(document.getElementById("root")).render(element);':'DOM.render(element,document.getElementById("root"));'}
    document.documentElement.dataset.cflRendered='true';`;
  const definitions=modules.map(m=>`${m.id}:[function(require,module,exports,__filename,__dirname){\n${m.code}\n},${JSON.stringify(m.deps)},${JSON.stringify(m.file)}]`).join(',\n');
  const bundle=`(function(){'use strict';const process={env:{NODE_ENV:'development'}},global=globalThis;const modules={${definitions}},cache={};
    function load(id){if(cache[id])return cache[id].exports;const row=modules[id];if(!row)throw new Error('Unknown preview module '+id);const module={exports:{}};cache[id]=module;row[0](s=>{if(row[1][s]===undefined)throw new Error('Unresolved runtime import '+s);return load(row[1][s]);},module,module.exports,row[2],row[2].split('/').slice(0,-1).join('/'));return module.exports;}
    try{${entry}}catch(error){const p=document.createElement('pre');p.dataset.cflError='true';p.textContent='Preview failed: '+error.message;document.getElementById('root').replaceChildren(p);}
  })();`;
  return{bundle,moduleCount:modules.length,bytes,notes,reactEntry:path.relative(root,req.resolve('react')),isolated:true};
}
function bundleInWorker(input,signal){return new Promise((resolve,reject)=>{
  const w=new Worker(path.join(__dirname,'preview-worker.js'),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:384}});let done=false;
  const end=(err,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);w.terminate();err?reject(err):resolve(result);};
  const abort=()=>end(new Error('Preview cancelled'));const timer=setTimeout(()=>end(new Error('Preview bundling timeout (30 s). Use the app URL.')),30000);
  signal?.addEventListener('abort',abort,{once:true});w.on('message',m=>m.ok?end(null,m.result):end(new Error(m.error)));w.on('error',e=>end(e));w.on('exit',c=>{if(!done)end(new Error('Preview worker exited: '+c));});if(signal?.aborted)abort();
});}
class PreviewServer{
  async start(result){this.result=result;this.token=crypto.randomBytes(24).toString('hex');this.nonce=crypto.randomBytes(24).toString('base64');
    this.server=http.createServer((req,res)=>{
      const host='127.0.0.1:'+req.socket.localPort;
      if(req.method!=='GET'||req.headers.host!==host||req.headers.origin&&req.headers.origin!=='http://'+host){res.writeHead(403);res.end('Forbidden');return;}
      const name=req.url?.split('?')[0];res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      if(name===`/${this.token}/bundle.js`){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(this.result.bundle);return;}
      if(name!==`/${this.token}/`){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${this.nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`);
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code Flow Lens React preview</title></head><body><div id="root"></div><script nonce="${this.nonce}" src="./bundle.js"></script></body></html>`);
    });await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});return`http://127.0.0.1:${this.server.address().port}/${this.token}/`;
  }
  async stop(){if(this.stopping)return this.stopping;const server=this.server;this.server=null;if(server){server.closeAllConnections?.();this.stopping=new Promise(resolve=>server.close(resolve));return this.stopping;}}
}
module.exports={validateLocalUrl,buildPreview,bundleInWorker,PreviewServer,projectRoot};
