'use strict';
const fs=require('node:fs'),path=require('node:path');
const REACT_ROOT=process.env.CFL_TEST_REACT_DIR || '/opt/pyvenv/lib/python3.13/site-packages/nbclassic/static/components';
function previewFixture(root){
 for(const [name,source]of[['react',path.join(REACT_ROOT,'react/react.production.min.js')],['react-dom',path.join(REACT_ROOT,'react/react-dom.production.min.js')]]){
  if(!fs.existsSync(source))throw new Error('Browser test runtime fixture not found. Set CFL_TEST_REACT_DIR to the nbclassic components root or provide installed test dependencies.');
  fs.mkdirSync(path.join(root,'node_modules',name),{recursive:true});fs.copyFileSync(source,path.join(root,'node_modules',name,'index.js'));
  fs.writeFileSync(path.join(root,'node_modules',name,'package.json'),JSON.stringify({name,version:'16.0.0',main:'index.js'}));
 }
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'preview-fixture',version:'1.0.0'}));
 fs.writeFileSync(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@/*':['src/*']}}}));
 fs.mkdirSync(path.join(root,'src'),{recursive:true});
 fs.writeFileSync(path.join(root,'src','label.ts'),'export const caption="Review lot";');
 fs.writeFileSync(path.join(root,'style.css'),'body{font-family:system-ui;margin:40px;background:#f4f7fb} .card{border:1px solid #ddd;border-radius:12px;max-width:380px;padding:24px;background:white} button{font:inherit;padding:10px 16px;margin-top:10px;border-radius:6px;border:1px solid #bbc}');
 const code=`import React from 'react';
import {caption} from '@/label';
import './style.css';
export class Card extends React.Component<{name:string},{count:number}>{
  constructor(p:any){super(p);this.state={count:0};}
  render(){return <article className="card"><h1>{this.props.name}</h1><p>{caption}</p><button onClick={()=>this.setState({count:this.state.count+1})}>Count {this.state.count}</button></article>;}
}`;
 const file=path.join(root,'Card.tsx');fs.writeFileSync(file,code);
 fs.writeFileSync(path.join(root,'Wrapper.tsx'),"export default function Wrapper(p:any){return <section data-wrapper='yes'>{p.children}</section>}");
 return{file,exportName:'Card',props:{name:'Code Flow Lens - React'},roots:[root]};
}
module.exports={previewFixture};
