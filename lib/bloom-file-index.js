'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {inside}=require('./scope');
const TS_SOURCE=/\.[cm]?[jt]sx?$/i;
const BYTES=256; // 2048 bits/file: tiny, cache-friendly prefilter.
const WORD=/[$A-Za-z_][$\w]*/g;
function h1(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function h2(s){let h=0x9e3779b9;for(let i=0;i<s.length;i++)h=(Math.imul(h^s.charCodeAt(i),0x85ebca6b)+0x165667b1)>>>0;return h>>>0}
function add(buf,s){const a=h1(s),b=h2(s)|1,n=buf.length*8;for(let i=0;i<4;i++){const bit=(a+Math.imul(i,b))>>>0,pos=bit%n;buf[pos>>>3]|=1<<(pos&7)}}
function has(buf,s){const a=h1(s),b=h2(s)|1,n=buf.length*8;for(let i=0;i<4;i++){const bit=(a+Math.imul(i,b))>>>0,pos=bit%n;if(!(buf[pos>>>3]&(1<<(pos&7))))return false}return true}
function bloom(text){const b=Buffer.alloc(BYTES);let m;WORD.lastIndex=0;while((m=WORD.exec(text)))if(m[0].length<=96)add(b,m[0]);return b}
class BloomFileIndex{
  constructor(workspaceRoot,cacheDir,{log=()=>{}}={}){this.workspaceRoot=path.resolve(workspaceRoot);this.cacheDir=cacheDir||null;this.log=log;this.packages=new Map();this.building=new Map();}
  key(root){return crypto.createHash('sha1').update(path.resolve(root)).digest('hex')}
  cachePath(root){return this.cacheDir&&path.join(this.cacheDir,'search-index',this.key(root)+'.json')}
  load(root){root=path.resolve(root);if(this.packages.has(root))return this.packages.get(root);const state={root,files:new Map(),dirty:false,loaded:false,lastSave:0};this.packages.set(root,state);const cp=this.cachePath(root);if(cp)try{const raw=JSON.parse(fs.readFileSync(cp,'utf8'));if(raw?.v===1&&raw.root===root&&Array.isArray(raw.files))for(const row of raw.files){const f=path.resolve(root,row[0]);if(inside(this.workspaceRoot,f)&&TS_SOURCE.test(f))state.files.set(f,{size:row[1],mtime:row[2],b:Buffer.from(row[3],'base64')})}state.loaded=true}catch{}return state}
  cachedFiles(root){return [...this.load(root).files.keys()]}
  updateText(root,file,text,stat=null){const s=this.load(root);file=path.resolve(file);if(!inside(root,file)||!TS_SOURCE.test(file))return;const size=Buffer.byteLength(text),mtime=stat?.mtimeMs||0;s.files.set(file,{size,mtime,b:bloom(text)});s.dirty=true}
  candidates(root,terms,{limit=260,focusFile=null}={}){const s=this.load(root),wanted=[...new Set(terms.filter(Boolean))];if(!wanted.length)return[];const out=[];if(focusFile)out.push(path.resolve(focusFile));for(const [file,row] of s.files){if(out.length>=limit)break;if(focusFile&&path.resolve(file)===path.resolve(focusFile))continue;if(wanted.some(t=>has(row.b,t)))out.push(file)}return out}
  ensureBackground(root,files,read){root=path.resolve(root);const s=this.load(root);if(this.building.has(root))return;const queue=[];for(const f0 of files){const f=path.resolve(f0);let st;try{st=fs.statSync(f)}catch{continue}const old=s.files.get(f);if(!old||old.size!==st.size||old.mtime!==st.mtimeMs)queue.push([f,st])}if(!queue.length){this.prune(root,new Set(files));this.saveSoon(root);return}
    this.building.set(root,true);let i=0;const step=()=>{const end=Math.min(queue.length,i+24);for(;i<end;i++){const [f,st]=queue[i];let text;try{text=read(f)}catch{}if(text!==undefined)this.updateText(root,f,text,st)}if(i<queue.length)setImmediate(step);else{this.building.delete(root);this.prune(root,new Set(files));this.saveSoon(root)}};setImmediate(step)
  }

  discoverBackground(root,{maxFiles=8000,read,skipNames=[]}={}){root=path.resolve(root);const tag='discover:'+root;if(this.building.has(tag))return;const s=this.load(root),skip=new Set(['node_modules','.git','.next','.nuxt','dist','build','coverage','vendor','.turbo','out',...skipNames]);const dirs=[root],seenFiles=new Set(),self=this;let count=0;
    this.building.set(tag,true);
    const finish=()=>{self.building.delete(tag);self.saveSoon(root)};
    const step=()=>{let dirBudget=10;while(dirs.length&&dirBudget-->0&&count<maxFiles){const dir=dirs.shift();let ents;try{ents=fs.readdirSync(dir,{withFileTypes:true})}catch{continue}for(const ent of ents){if(count>=maxFiles)break;if(ent.isSymbolicLink()||skip.has(ent.name))continue;const full=path.join(dir,ent.name);if(ent.isDirectory()){dirs.push(full);continue}if(!ent.isFile()||!TS_SOURCE.test(full))continue;count++;const f=path.resolve(full);seenFiles.add(f);let st;try{st=fs.statSync(f)}catch{continue}const old=s.files.get(f);if(old&&old.size===st.size&&old.mtime===st.mtimeMs)continue;let text;try{text=read(f)}catch{}if(text!==undefined)self.updateText(root,f,text,st)}}if(dirs.length&&count<maxFiles)setImmediate(step);else finish()};setImmediate(step)
  }
  prune(root,allowed){const s=this.load(root);for(const f of s.files.keys())if(!allowed.has(f)){s.files.delete(f);s.dirty=true}}
  saveSoon(root){const s=this.load(root),cp=this.cachePath(root);if(!cp||!s.dirty)return;if(Date.now()-s.lastSave<1000){setTimeout(()=>this.saveSoon(root),1100);return}try{fs.mkdirSync(path.dirname(cp),{recursive:true});const rows=[];for(const [f,r] of s.files)rows.push([path.relative(root,f),r.size,r.mtime,r.b.toString('base64')]);const tmp=cp+'.tmp';fs.writeFileSync(tmp,JSON.stringify({v:1,root,files:rows}));fs.renameSync(tmp,cp);s.dirty=false;s.lastSave=Date.now()}catch(e){this.log('Search index cache write skipped: '+e.message)}}
  invalidateFile(file){file=path.resolve(file);for(const s of this.packages.values())if(s.files.delete(file))s.dirty=true}
  status(){let files=0;for(const s of this.packages.values())files+=s.files.size;return{packages:this.packages.size,indexedFiles:files,building:this.building.size}}
}
module.exports={BloomFileIndex};
