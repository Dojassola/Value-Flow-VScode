'use strict';
/** Minimal Chrome DevTools transport over inherited pipes. No listening port and
 * never connects to the user's daily browser/profile. Only preset operations
 * exposed by RuntimeManager may call it. */
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
class CDP extends EventEmitter {
  constructor(child){super();this.child=child;this.next=1;this.pending=new Map();this.buffer=Buffer.alloc(0);this.closed=false;this.stderr='';
    child.stderr.on('data',d=>{this.stderr=(this.stderr+d).slice(-3000);});
    child.stdio[4].on('data',d=>{this.buffer=Buffer.concat([this.buffer,d]);let n;while((n=this.buffer.indexOf(0))>=0){const line=this.buffer.subarray(0,n).toString();this.buffer=this.buffer.subarray(n+1);let m;try{m=JSON.parse(line);}catch{continue;}if(m.id){const job=this.pending.get(m.id);if(job){clearTimeout(job.timer);this.pending.delete(m.id);m.error?job.reject(new Error(m.error.message)):job.resolve(m.result||{});}}else this.emit('event',m);}if(this.buffer.length>16*1024*1024)this.kill();});
    const exit=e=>{if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Browser disconnected: '+(e?.message||this.stderr.slice(-1000))));}this.pending.clear();this.emit('closed');};
    child.on('error',exit);child.on('exit',exit);child.stdio[3].on('error',exit);child.stdio[4].on('error',exit);
  }
  send(method,params={},sessionId,timeout=10000){if(this.closed)return Promise.reject(new Error('Browser closed'));const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Browser timed out: '+method));},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
  kill(){this.child.kill();}
  async close(){if(!this.closed)try{await this.send('Browser.close',{},undefined,1500);}catch{}if(!this.closed){this.kill();await new Promise(r=>{const t=setTimeout(r,1000);this.child.once('exit',()=>{clearTimeout(t);r();});});}}
}
async function detectBrowser(explicit){
  const candidates=explicit?[explicit]:[process.env.CFL_CHROME_PATH,
    ...(process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium']:[]),
    ...(process.platform==='win32'?[path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe'),path.join(process.env.LOCALAPPDATA||'','Google/Chrome/Application/chrome.exe'),path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft/Edge/Application/msedge.exe')]:[]),
    ...['google-chrome','google-chrome-stable','chromium','chromium-browser'].flatMap(n=>(process.env.PATH||'').split(path.delimiter).map(d=>path.join(d,n)))];
  for(const p of candidates.filter(Boolean))try{if(!path.isAbsolute(p))continue;const s=await fs.stat(p);if(s.isFile()){await fs.access(p,process.platform==='win32'?0:1);return p;}}catch{}
  throw new Error('Chrome/Chromium not found. Install a browser, or set CFL_CHROME_PATH to its absolute executable path. Static tools still work.');
}
async function launch({executable,headless=false,unsafeTestNoSandbox=false}={}){
  const chrome=await detectBrowser(executable),profile=await fs.mkdtemp(path.join(os.tmpdir(),'cfl-runtime-'));await fs.chmod(profile,0o700);
  // Test-only escape hatch for sandboxed CI containers; never exposed in the user interface.
  const args=['--remote-debugging-pipe','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--disable-component-update','--disable-default-apps','--disable-popup-blocking','--disable-breakpad','--disable-dev-shm-usage',...(headless?['--headless=new']:[]),...(unsafeTestNoSandbox?['--no-sandbox']:[]),'about:blank'];
  const child=spawn(chrome,args,{stdio:['ignore','ignore','pipe','pipe','pipe'],windowsHide:headless});const client=new CDP(child);
  try{const version=await client.send('Browser.getVersion',{},undefined,15000);return{client,profile,chrome,version,async close(){await client.close();await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});}};}
  catch(e){await client.close();await fs.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});throw e;}
}
module.exports={CDP,detectBrowser,launch};
