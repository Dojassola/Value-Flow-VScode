'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {buildPreview,bundleInWorker,validateLocalUrl,PreviewServer}=require('../lib/react-preview');
const {previewFixture}=require('./preview-fixture');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-preview-unit-'));const fixture=previewFixture(root);
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const request=(url,options={})=>new Promise((resolve,reject)=>{const r=http.request(url,options,res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});r.on('error',reject);r.end();});

test('preview bundle uses actual installed React, transpiles TS/JSX, path aliases and CSS without executing project imports',()=>{
 const result=buildPreview({...fixture,props:{name:'</script><script>neverInHost()</script>'},wrapper:path.join(root,'Wrapper.tsx')});
 assert.ok(result.moduleCount>=6);assert.ok(result.bundle.includes('Review lot'));assert.ok(result.bundle.includes('componentDidCatch'));
 const bad=path.join(root,'HostEffect.tsx');fs.writeFileSync(bad,'globalThis.CFL_WAS_EVALUATED=true;export function Card(){return <b>hello</b>}');
 buildPreview({...fixture,file:bad});assert.equal(globalThis.CFL_WAS_EVALUATED,undefined);
});
test('isolated preview rejects Node builtins, dynamic requires, CSS modules and traversal',()=>{
 const bad=path.join(root,'bad.tsx');
 for(const code of ["import fs from 'node:fs';export function Card(){return <b>{fs.readFileSync('secret')}</b>}","const lib=require(window.name);export function Card(){return <b>{lib}</b>}"]){fs.writeFileSync(bad,code);assert.throws(()=>buildPreview({...fixture,file:bad}),/builtin|Dynamic require/);}
 fs.writeFileSync(path.join(root,'x.module.css'),'.x{color:red}');fs.writeFileSync(bad,"import styles from './x.module.css';export function Card(){return <b className={styles.x}/>}");assert.throws(()=>buildPreview({...fixture,file:bad}),/CSS modules/);
 assert.throws(()=>buildPreview({...fixture,file:'/etc/passwd'}),/escapes/);
});
test('preview worker can build a real component and supports cancellation',async()=>{
 const result=await bundleInWorker(fixture);assert.ok(result.moduleCount>=5);
 const c=new AbortController();c.abort();await assert.rejects(bundleInWorker(fixture,c.signal),/cancel/);
});
test('preview server authenticates random path, restricts Host/Origin/method and sets network-blocking CSP',async()=>{
 const server=new PreviewServer(),url=await server.start({bundle:'/* fixture */'});
 try{const ok=await request(url);assert.equal(ok.status,200);assert.match(ok.headers['content-security-policy'],/connect-src 'none'/);assert.match(ok.headers['content-security-policy'],/form-action 'none'/);
 assert.equal((await request(url,{headers:{Host:'evil.invalid'}})).status,403);assert.equal((await request(url,{headers:{Origin:'https://evil.invalid'}})).status,403);
 assert.equal((await request(url,{method:'POST'})).status,403);assert.equal((await request(new URL('/unknown',url))).status,404);
 assert.equal((await request(url+'bundle.js')).body,'/* fixture */');
 }finally{await Promise.all([server.stop(),server.stop()]);}
});
test('only explicit loopback preview URLs accepted; no credentials or remote project fetching',()=>{
 assert.equal(validateLocalUrl('http://127.0.0.1:5173'), 'http://127.0.0.1:5173/');
 for(const x of ['https://example.com','file:///tmp/app','http://user:pass@localhost:10','https://localhost.evil.invalid'])assert.throws(()=>validateLocalUrl(x));
});
