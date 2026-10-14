'use strict';
(() => {
  const token = location.hash.slice(1);
  const supported = new Set(['ready','selected','rendered','uiError','valueTrace','valueOrigin','valueDestination','simulateValue','codeFlow','classDiagram','dependencies','refresh','cancel','openNode','openCodeLine','copyNode','export','close']);
  let state, preferences = {}, events;
  const error = message => { const box = document.getElementById('error'); box.textContent = message + '\nClick to dismiss.'; box.hidden = false; };
  const request = async message => {
    const response = await fetch('/message', {method:'POST',headers:{'Content-Type':'application/json','x-cfl-token':token},body:JSON.stringify(message)});
    if (!response.ok) throw new Error((await response.json()).error || 'Viewer request failed.');
  };
  window.cflHost = {
    errorHint:'Save the source in Zed and refresh the graph.',
    supportsCommand:command => supported.has(command),
    getState:() => preferences,
    setState:value => { preferences = value; },
    postMessage:async message => {
      try {
        if (message.command === 'ready') {
          if (!/^[\w-]{43}$/.test(token)) throw new Error('Open the viewer using the Zed task. This page is missing its session token.');
          events = new EventSource('/events?token=' + encodeURIComponent(token));
          events.onmessage = event => { const message=JSON.parse(event.data);if(message.type==='flow:state'){state=message;dependencies.disabled=!!state.loading||!state.graph;copyAI.disabled=!!state.loading||!state.graph;}window.dispatchEvent(new MessageEvent('message', {data:message})); };
          events.onerror = () => error('The local viewer disconnected. Run the Zed task again to reconnect.');
          return;
        }
        if (message.command === 'rendered') return;
        if(message.command==='selected'&&state?.graph?.graphId===message.graphId)state.graph.selectedNodeId=message.nodeId;
        if (message.command === 'copyNode') {
          const node = state?.graph?.nodes.find(item => item.id === message.nodeId);
          if (node) await navigator.clipboard.writeText(JSON.stringify(node, null, 2)); return;
        }
        if (message.command === 'export') {
          if (!state?.graph) return;
          const url = URL.createObjectURL(new Blob([JSON.stringify(state.graph, null, 2)], {type:'application/json'}));
          const link = document.createElement('a'); link.href = url; link.download = 'code-flow-lens.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
        }
        if (message.command === 'simulateValue') {
          const value = window.prompt('Enter the hypothetical value as JSON (workspace code is not executed):', '42');
          if (value === null) return; message.value = JSON.parse(value);
        }
        await request(message);
        if (message.command === 'close') { events?.close(); document.getElementById('status').textContent = 'Viewer closed. Run the Zed task to open it again.'; }
      } catch (cause) { error(cause.message); }
    }
  };
  for (const id of ['analyzeSmart','relations','correlate','reactTree','previewReact','runtime','diagnostics','javaHelp','shortcut']) document.getElementById(id).hidden = true;
  document.getElementById('status').textContent = 'Connecting to the local analysis engine...';
  const close = document.createElement('button'); close.textContent = 'Close viewer';
  close.addEventListener('click', () => window.cflHost.postMessage({command:'close',epoch:state?.epoch}));
  document.querySelector('.actions').append(close);
  const dependencies=document.createElement('button');dependencies.textContent='Dependencies';dependencies.disabled=true;
  dependencies.addEventListener('click',()=>window.cflHost.postMessage({command:'dependencies',epoch:state?.epoch,graphId:state?.graph?.graphId,nodeId:state?.graph?.selectedNodeId||state?.graph?.rootId}));
  document.querySelector('.modes').append(dependencies);
  const copyAI=document.createElement('button');copyAI.textContent='Copy for AI';copyAI.disabled=true;
  copyAI.addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(`Use o MCP Code Flow Lens para investigar o grafo aberto. Chame get_open_graph com session_id "${state.sessionId}". Workspace: ${state.workspace}. Explique a seleção atual, suas transformações e condições de caminho. Consulte análise, avisos e limites antes de concluir. Use analyze_open_graph para seguir valores, simular entradas, obter UML ou dependências, e focus_graph_node para mostrar a evidência no navegador. Não edite arquivos sem meu pedido.`);}
    catch(cause){error(cause.message);}
  });
  document.querySelector('.actions').append(copyAI);
})();
