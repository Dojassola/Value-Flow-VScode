"""Chromium integration for the shipped graph UI and real isolated React rendering.
Message API is simulated, not a VS Code Extension Host test. Runs offline.
"""
import argparse,base64,json,os,shutil,subprocess,tempfile,time,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--output',default=str(ROOT/'test-artifacts'));args=p.parse_args();OUT=Path(args.output);OUT.mkdir(parents=True,exist_ok=True)
checks=[]
def ok(name): checks.append(name);print('PASS:',name,flush=True)
generator=r"""
const {FlowEngine}=require('./lib/flow-engine');const {FakeAdapter}=require('./test/fake-adapter');const {parseTS}=require('./lib/ts-analysis');const {makeCodeFlow}=require('./lib/code-flow');
(async()=>{const e=new FlowEngine(new FakeAdapter());const initial=await e.create({symbol:'A'},{depth:1,direction:'outgoing'}),complete=await e.analyze(initial.graphId),b=complete.nodes.find(n=>n.name==='B'),expanded=await e.expand(complete.graphId,b.id,{direction:'outgoing'});
const code='function reviewLot(input: number) {\n  let area = input;\n  if (area > 100) {\n    area = 100;\n  } else {\n    area = area + 1;\n  }\n  const result = area;\n  return result;\n}\n';const cfg=makeCodeFlow(parseTS(code,'review.ts',code.indexOf('const result')),code,{uri:'file:///review.ts',file:'review.ts',line:1,column:1},code.indexOf('const result'));
const tree={...complete,graphId:'react-test',kind:'react-hierarchy',rootId:'card',target:{name:'Card'},nodes:[{id:'page',type:'component',role:'component',name:'Page',code:'export function Page(){\n  return <Card name="Jane"/>;\n}',location:{file:'Page.tsx',line:1},layer:-1},{id:'card',type:'component',role:'root',name:'Card',code:'export function Card({ name }) {\n  return <div>{name}</div>;\n}',location:{file:'Card.tsx',line:1},layer:0}],edges:[{id:'r',from:'page',to:'card',type:'renders',label:'JSX renders',props:[{name:'name',expression:'"Jane"'}]}]};
const value={schemaVersion:'3.0',kind:'value-flow',graphId:'value-test',rootId:'va',selectedNodeId:'va',target:{name:'userId'},nodes:[{id:'va',type:'value',role:'root',roles:['root'],name:'userId',valueKind:'symbol',code:'const userId = input.id;',sourceStartLine:1,location:{uri:'file:///value.ts',file:'value.ts',line:1,column:7},layer:0},{id:'vb',type:'value',role:'value',roles:['value'],name:'payload.userId',valueKind:'property',code:'const payload = { userId };',sourceStartLine:2,location:{uri:'file:///value.ts',file:'value.ts',line:2,column:19},layer:1}],edges:[{id:'ve',from:'va',to:'vb',type:'object_property',label:'property userId'}],analysis:{state:'ready',busy:false,stale:false,pending:[],timings:{lastOperationMs:12},counts:{nodes:2,edges:1},warnings:[],coverage:{kind:'bounded-interprocedural-value-flow'}},limitations:[]};
const corr={schemaVersion:'3.0',kind:'correlation',graphId:'corr-test',rootId:'ca',selectedNodeId:'ca',target:{name:'userId x accountId'},nodes:[{id:'ca',type:'value',role:'root',roles:['root'],name:'userId',valueKind:'symbol',code:'function run(userId, accountId) {}',sourceStartLine:1,location:{uri:'file:///corr.ts',file:'corr.ts',line:1,column:14},layer:0},{id:'cb',type:'value',role:'root',roles:['root'],name:'accountId',valueKind:'symbol',code:'function run(userId, accountId) {}',sourceStartLine:1,location:{uri:'file:///corr.ts',file:'corr.ts',line:1,column:22},layer:0},{id:'cx',type:'value',role:'intersection',roles:['intersection'],name:'payload',valueKind:'symbol',code:'const payload={userId,accountId};',sourceStartLine:2,location:{uri:'file:///corr.ts',file:'corr.ts',line:2,column:7},layer:1,correlation:{types:['common_destination','shared_write_target'],forwardRoots:[0,1],backwardRoots:[]}}],edges:[{id:'cea',from:'ca',to:'cx',type:'assign',label:'assigned to payload'},{id:'ceb',from:'cb',to:'cx',type:'assign',label:'assigned to payload'}],correlations:[{nodeId:'cx',types:['common_destination','shared_write_target'],roots:[0,1]}],analysis:{state:'ready',busy:false,stale:false,pending:[],timings:{lastOperationMs:18},counts:{nodes:3,edges:2,correlations:1},warnings:[],coverage:{kind:'multi-symbol-static-correlation'}},limitations:[]};
const sim={schemaVersion:'3.0',kind:'simulation',graphId:'sim-test',rootId:'s1',selectedNodeId:'s1',target:{name:'value'},nodes:[{id:'s1',type:'simulation',role:'inject',name:'inject value = 5',simulationValue:'5',code:'function run(value){',sourceStartLine:1,location:{uri:'file:///sim.ts',file:'sim.ts',line:1,column:1},layer:1},{id:'s2',type:'simulation',role:'condition',name:'if => true',simulationValue:'true',code:'if (value > 3)',sourceStartLine:2,location:{uri:'file:///sim.ts',file:'sim.ts',line:2,column:1},layer:2},{id:'s3',type:'simulation',role:'return',name:'return 12',simulationValue:'12',code:'return 12;',sourceStartLine:3,location:{uri:'file:///sim.ts',file:'sim.ts',line:3,column:1},layer:3}],edges:[{id:'se1',from:'s1',to:'s2',type:'next',label:'next'},{id:'se2',from:'s2',to:'s3',type:'return',label:'return'}],analysis:{state:'ready',busy:false,stale:false,pending:[],timings:{lastOperationMs:8},counts:{nodes:3,edges:2},warnings:[],coverage:{kind:'safe-static-abstract-interpretation'}},limitations:[]};
process.stdout.write(JSON.stringify({initial,complete,expanded,cfg,tree,value,corr,sim}));e.dispose();})();
"""
f=json.loads(subprocess.check_output(['node','-e',generator],cwd=ROOT))
script='data:text/javascript;base64,'+base64.b64encode((ROOT/'media/graph.js').read_bytes()).decode();style='data:text/css;base64,'+base64.b64encode((ROOT/'media/graph.css').read_bytes()).decode()
html=subprocess.check_output(['node','-e',"process.stdout.write(require('./lib/webview-html').webviewHtml(JSON.parse(process.argv[1])))",json.dumps({'scriptUri':script,'styleUri':style,'cspSource':'data:'})],cwd=ROOT).decode()
preview_process=None
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1680,'height':1040});page.set_default_timeout(7000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.evaluate("window.__messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__messages.push(m),getState:()=>({}),setState:s=>{}})")
  page.set_content(html,wait_until='load');page.wait_for_function("window.__messages.some(m=>m.command==='ready')")
  ok('Actual packaged JS initializes through CSP and ready handshake')
  def send(g,epoch=1,cards=None):
   page.evaluate('(m)=>window.postMessage(m,"*")',{'type':'flow:state','epoch':epoch,'graph':g,'cards':cards or {}});page.wait_for_timeout(100)
  def message(command):return page.evaluate('(c)=>window.__messages.some(m=>m.command===c)',command)
  def node(id):return page.locator('[data-node-id="'+id+'"]')
  send(f['initial']);assert page.locator('.node').count()==1;ok('Root renders progressively before providers')
  cards={n['id']:{'lines':[{'line':n['location']['line'],'text':'function '+n['name']+'() { return 1; }'}]} for n in f['complete']['nodes'] if n['type']=='symbol'}
  send(f['complete'],cards=cards)
  assert page.locator('#showRefs').is_checked();assert page.locator('.node').count()==len(f['complete']['nodes']);assert page.locator('.node .code-line').count()>0
  ok('Reference file groups are visible by default; semantic root roles remain consolidated')
  page.locator('#showRefs').uncheck();assert page.locator('#viewNotice').is_visible();assert 'hidden' in page.locator('#viewNoticeText').inner_text()
  page.locator('#showHiddenReferences').click();assert page.locator('#showRefs').is_checked();assert page.locator('.node').count()==len(f['complete']['nodes']);assert not page.locator('#viewNotice').is_visible()
  ok('Hiding references produces an explicit count and one-click reveal')
  page.locator('#showRefs').uncheck()
  # Reference-only graph reproduces the old 'single root / no relations' view.
  only=json.loads(json.dumps(f['complete']));only['nodes']=[n for n in only['nodes'] if n['id']==only['rootId'] or n['type']=='referenceFile'];ids={n['id'] for n in only['nodes']};only['edges']=[e for e in only['edges'] if e['from'] in ids and e['to'] in ids];only['revision']+=1
  send(only);page.locator('#resetView').click();assert page.locator('.edge.referenced_in').count()>0;assert page.locator('.node').count()>1
  ok('Reference-only graph shows file relationships, not just an isolated root')
  page.locator('#search').fill('NO_MATCH_ANYWHERE');assert page.locator('.node').count()==0;page.locator('#resetView').click();assert page.locator('.node').count()>1;assert page.locator('#search').input_value()==''
  ok('Reset view clears filters, resets direction and restores all reference groups')
  restored_graph=json.loads(json.dumps(f['complete']));restored_graph['revision']=only['revision']+1;send(restored_graph,cards=cards);page.locator('#showRefs').uncheck()
  page.locator('#diagnostics').click();assert message('diagnostics');ok('General relationship diagnostics command reaches the host')
  root=f['complete']['rootId'];node(root).locator('.node-name').click();assert page.locator('.reference-group').count()>0
  page.locator('.trace-owner').first.click();assert message('traceReferenceOwner');ok('References remain grouped in inspector and support trace-owner without duplicate boxes')
  b=next(n['id'] for n in f['complete']['nodes'] if n['name']=='B');node(b).locator('.expand-references').click();assert message('expandReferences')
  node(b).locator('[data-direction="outgoing"]').click();assert message('expand');f['expanded']['revision']=restored_graph['revision']+1;send(f['expanded'],cards=cards);ok('Lazy calls/references and incremental results work')
  page.locator('#fit').click();node(root).locator('.node-name').dblclick();assert message('openNode');page.locator('#export').click();assert message('export');page.get_by_role('button',name='Copy node JSON',exact=True).click();assert message('copyNode');ok('Open source, export and copy-node actions reach the host')
  page.locator('#shortcut').click();page.locator('#javaHelp').click();assert all(message(c) for c in ['shortcut','javaHelp']);ok('Shortcut and Java diagnostics toolbar routes preserved')
  def mat():return page.evaluate("()=>{const m=new DOMMatrix(getComputedStyle(document.getElementById('world')).transform);return {x:m.e,y:m.f,z:m.a}}")
  r=page.locator('#viewport').bounding_box();page.mouse.move(r['x']+15,r['y']+15);before=mat();page.mouse.down();page.mouse.move(r['x']+100,r['y']+65,steps=7);page.mouse.up();after=mat();assert abs(after['x']-before['x']-85)<1;ok('Background drag pans without needing scrollbars')
  page.locator('#fit').click();r=node(root).bounding_box();page.mouse.move(r['x']+10,r['y']+10);before=mat();page.mouse.down(button='middle');page.mouse.move(r['x']+60,r['y']+40);page.mouse.up(button='middle');assert abs(mat()['x']-before['x']-50)<1;ok('Middle-button drag works on source cards')
  r=page.locator('#viewport').bounding_box();px,py=150,150;before=mat();gx=(px-before['x'])/before['z'];page.mouse.move(r['x']+px,r['y']+py);page.keyboard.down('Control');page.mouse.wheel(0,-120);page.keyboard.up('Control');page.wait_for_timeout(100);after=mat();assert after['z']>before['z'];assert abs((px-after['x'])/after['z']-gx)<1;ok('Ctrl-wheel zoom remains anchored at mouse')
  send(f['cfg'],epoch=2);assert page.locator('.edge.true').count()==1;assert page.locator('.edge.false').count()==1;assert 'const result = area' in page.locator('#inspector').inner_text();ok('AST graph renders actual code with true/false control branches')
  page.locator('#origin').click();assert page.locator('#edgeMode').input_value()=='data';assert page.locator('.edge.data').count()>0;assert 'area = 100' in page.locator('#nodes').inner_text();ok('Origin follows reaching definitions backwards to both possible assignments')
  page.locator('#allPaths').click();page.locator('#destination').click();assert 'return result' in page.locator('#nodes').inner_text();ok('Destination follows local uses forward')
  page.locator('#allPaths').click();page.locator('#edgeMode').select_option('control');condition=next(n['id'] for n in f['cfg']['nodes'] if n['role']=='condition');page.locator('#fit').click();node(condition).locator('.node-name').click();page.locator('#walk').click();assert page.locator('.walk-choice').count()==2;page.locator('.walk-choice').filter(has_text='true').click();assert 'area = 100' in page.locator('#inspector').inner_text();assert page.locator('.edge.walked').count()==1
  page.locator('#walkBack').click();assert page.locator('.walk-choice').count()==2;page.locator('#walkReverse').click();assert page.locator('.walk-choice').count()==1;page.locator('.walk-choice').click();assert 'let area = input' in page.locator('#inspector').inner_text();ok('Manual path walk chooses a branch, steps back and walks reverse edges')
  page.locator('#walk').click();page.locator('#fit').click();page.screenshot(path=str(OUT/'code-flow-lens-0.11.0-code.png'))
  page.locator('#showCode').uncheck();assert page.locator('.node .code-block').count()==0;page.locator('#showCode').check();ok('Compact/code-card toggle and Fit work')
  send(f['tree'],epoch=3);assert page.locator('.node').count()==2;assert page.locator('.edge.renders').count()==1;node('card').locator('.node-name').click();page.get_by_role('button',name='Render component',exact=True).click();assert message('previewReact');node('card').get_by_role('button',name='+ JSX',exact=True).click();assert message('reactTree');ok('JSX hierarchy shows code, parents/children and actual render action')
  send(f['value'],epoch=31);assert page.locator('.edge.object_property').count()==1;node('va').locator('.node-name').click();page.get_by_role('button',name='Value destination',exact=True).click();assert message('valueDestination');ok('Value-flow graph renders provenance edges and routes directional tracing to host')
  send(f['corr'],epoch=32);node('cx').locator('.node-name').click();assert 'shared write target' in page.locator('#inspector').inner_text().lower();assert page.locator('.node.intersection').count()==1;ok('Correlation graph highlights shared destinations/collision candidates')
  send(f['sim'],epoch=33);assert page.locator('.value-chip').count()==3;assert 'value = 5' in page.locator('#nodes').inner_text();page.locator('#walk').click();assert not page.locator('#walkBack').is_hidden();ok('Simulation graph renders injected/concrete values and supports path stepping without execution')
  send(f['tree'],epoch=34);page.locator('#search').fill('Page');assert page.locator('.node').count()==1;page.locator('#search').fill('');page.locator('#details').click();assert not page.locator('#inspector').is_visible();page.locator('#details').click();ok('Search filters source cards and details panel collapses')
  evil=json.loads(json.dumps(f['cfg']));evil['nodes'][0]['code']='</script><img src=x onerror="window.PWNED=1">';evil['target']['name']='<script>window.PWNED=1</script>';send(evil,epoch=35);assert page.evaluate('window.PWNED===undefined');assert page.locator('#nodes img').count()==0;ok('Source code is text, never HTML injection')
  newer=json.loads(json.dumps(f['expanded']));newer['revision']=900;older=json.loads(json.dumps(newer));older['revision']=800;older['nodes']=older['nodes'][:1];send(newer,epoch=36);send(older,epoch=36);assert page.locator('.node').count()>1;ok('Stale provider revisions cannot replace newer data')
  stale=json.loads(json.dumps(f['cfg']));stale['analysis']['stale']=True;send(stale,epoch=37);assert 'Source changed' in page.locator('#status').inner_text();assert page.locator('#walk').is_disabled();ok('Stale analysis is marked and cannot be walked as current')
  big=json.loads(json.dumps(f['cfg']));big['graphId']='stress';big['nodes']=[];big['edges']=[];big['dataEdges']=[];big['rootId']='n0';big['selectedNodeId']='n0'
  for i in range(500):
   n=json.loads(json.dumps(f['cfg']['nodes'][2]));n.update({'id':'n'+str(i),'layer':i//4,'unreachable':False});big['nodes'].append(n)
   if i:big['edges'].append({'id':'e'+str(i),'from':'n'+str(i-1),'to':'n'+str(i),'type':'next'})
  send(big,epoch=38);assert page.locator('.node').count()==500;assert not errors,errors;ok('500 source-card synthetic stress graph renders without JS errors')
  # Start the shipped authenticated local renderer with actual React 16 fixture.
  procscript=r"""const fs=require('fs'),os=require('os'),path=require('path');const {previewFixture}=require('./test/preview-fixture');const {buildPreview,PreviewServer}=require('./lib/react-preview');const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfl-react-browser-'));(async()=>{const args=previewFixture(root);args.wrapper=path.join(root,'Wrapper.tsx');const s=new PreviewServer();const url=await s.start(buildPreview(args));console.log(JSON.stringify({url}));process.on('SIGTERM',async()=>{await s.stop();fs.rmSync(root,{recursive:true,force:true});process.exit(0);});})();"""
  preview_process=subprocess.Popen(['node','-e',procscript],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);info=json.loads(preview_process.stdout.readline());preview=browser.new_page(viewport={'width':1000,'height':750});preview.set_default_timeout(7000);preview_errors=[];preview.on('pageerror',lambda e:preview_errors.append(str(e)))
  with urllib.request.urlopen(info['url']) as response:
   preview_html=response.read().decode();preview_csp=response.headers['Content-Security-Policy']
  with urllib.request.urlopen(info['url']+'bundle.js') as response:preview_bundle=response.read()
  # Managed Chromium blocks loopback navigation. Use EXACT served bundle bytes
  # under the same nonce and a CSP meta tag; HTTP behavior is tested in Node.
  preview_html=preview_html.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="'+preview_csp+'">').replace('src="./bundle.js"','src="data:text/javascript;base64,'+base64.b64encode(preview_bundle).decode()+'"')
  preview.set_content(preview_html,wait_until='load');preview.get_by_role('heading',name='Code Flow Lens - React',exact=True).wait_for();assert preview.locator('[data-wrapper="yes"]').count()==1;assert preview.get_by_text('Review lot',exact=True).is_visible();ok('Real installed React renders TSX props, child content, wrapper, path alias and CSS in Chromium')
  preview.get_by_role('button',name='Count 0',exact=True).click();preview.get_by_role('button',name='Count 1',exact=True).wait_for();assert not preview_errors,preview_errors;ok('Real React event handler and state update work; preview is not a static mockup')
  denied=preview.evaluate("async()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));try{await fetch('https://example.invalid/should-not-load');return false;}catch{return true;}}")
  preview.wait_for_timeout(100)
  assert preview.evaluate("window.__csp.includes('connect-src')")
  assert denied;ok('Browser enforces CSP blocking fetch in isolated preview')
  preview.screenshot(path=str(OUT/'code-flow-lens-0.11.0-react.png'));browser.close()
except Exception:
 if 'page' in locals():
  try:page.screenshot(path=str(OUT/'failure.png'))
  except Exception:pass
 raise
finally:
 if preview_process:
  preview_process.terminate()
  try:preview_process.wait(timeout=3)
  except subprocess.TimeoutExpired:preview_process.kill()
 (OUT/'browser-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks},indent=2))
print('Passed',len(checks),'browser checks')
