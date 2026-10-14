'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Analysis}=require('../mcp/analysis.cjs');

test('MCP analysis preserves unknown branches, accepts source buffers and restricts the workspace',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-mcp-'));
  const source='export function run(value:number, condition:boolean){if(condition)return value;return value+1;}';
  fs.writeFileSync(path.join(root,'flow.ts'),source);
  const analysis=new Analysis(root),position={file:'flow.ts',line:1,column:source.indexOf('value')+1};
  try{
    const simulated=await analysis.run('simulate_value',{...position,value:2,maxSteps:40,maxDepth:2});
    assert.equal(simulated.result,'<unknown>');assert.equal(simulated.analysis.state,'partial');
    const buffer='const input={id:42}; const result=input.id;';
    const trace=await analysis.run('trace_value',{...position,column:buffer.lastIndexOf('id')+1,sourceText:buffer,direction:'incoming',depth:6,maxNodes:30});
    assert.ok(trace.nodes.some(node=>node.name==='42'));assert.equal(fs.readFileSync(path.join(root,'flow.ts'),'utf8'),source);
    await assert.rejects(analysis.run('trace_value',{...position,file:path.join(root,'..','outside.ts'),direction:'incoming',depth:4,maxNodes:20}),{code:'OUTSIDE_WORKSPACE'});
  }finally{analysis.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
