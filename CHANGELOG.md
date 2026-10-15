# Changelog

## 0.13.6 - Redux value provenance

- Added shared static Redux tracing for VS Code, the Zed browser viewer and MCP, using the reducer registration path rather than a variable named `state`.
- Links initial/preloaded state, selector reads, reducer writes, actions, dispatches and action inputs. Recognizes classic switch reducers, reduxsauce Types/Creators/handlers and Redux Toolkit createSlice/createReducer with addCase.
- Follows imported aliases, destructured bindings, typed selector/dispatch hooks and statically resolvable custom hook returns. Toolkit writes include assignments, increments, deletes and common array mutations.
- Redux evidence carries state paths, store locations and action types in JSON and the inspector. Dynamic operations, ambiguous stores and incomplete discovery have explicit partial-analysis warnings.
- Discovery reserves time for graph construction, and records consumers/writers before expanding ordinary provenance.
- Validation is limited to source syntax and package integrity. No tests, application execution or editor/browser acceptance were run.

## 0.13.5 - Exported object usages

- Added manual local release generation/upload, GitHub repository metadata and a portable distribution for Zed/MCP/installer/VSIX. Private plans/reports and local configuration are excluded from Git and packages.
- Reference discovery prioritizes the selected module's directory and nearby files. Bloom matches are checked against source text before consuming the semantic candidate limit.
- Reference bridges include `export *` and use a barrel directory's name for `index` modules, while checking the original declaration location.
- Value Flow records property/indexed reads before expanding their downstream calls, with distinct source positions and expression snippets.
- Partial or indexing reference searches are not cached as complete results; Value Flow reports incomplete discovery explicitly.
- Source syntax and archive integrity only; no tests or live analysis/editor acceptance were run.

## 0.13.4 - Less repetition and editor installer

- Value flow reuses a selected binding as its declaration and shows initialization in that node. It avoids extra expression nodes for the same selected value and predicate; distinct source occurrences remain separate.
- Origin, condition and argument cards show their own expressions. Callback origins show signatures instead of repeating entire function bodies.
- Added `install.cjs zed` to copy the runtime to a versioned user directory and merge global Zed tasks by label, with absolute Node/viewer paths, JSONC validation and a backup. Existing unrelated tasks, comments and keybindings are preserved.
- Added `install.cjs vscode` to install the bundled VSIX through the editor CLI, with explicit VSCodium/Insiders support. The portable ZIP includes both installer and VSIX.
- No tests or editor/browser acceptance were run. Windows VSIX installation remains manual.

## 0.13.3 - Agent access to web graphs, transformations and diagrams

- Added MCP viewer mode for any compatible agent: discover connected graphs, read the selection, run bounded analysis and focus evidence in the browser.
- Added Codex and Antigravity configuration examples and a Copy for AI action in the web viewer; model/provider configuration remains in the agent.
- Value nodes now expose transformation expressions and syntactic path conditions. Tracing includes predicate uses, compound updates and increment/decrement destinations; unresolved argument destinations stay visible with partial-analysis warnings.
- Simulation edges label true/false branches and join the results of unknown branches without dropping the first branch's continuation.
- Exposed local UML/type/component diagrams and ES module import/re-export graphs in the web viewer and workspace MCP tools.
- Validation remains limited to source syntax and package integrity; no tests, MCP handshake or editor/browser acceptance were run.

## 0.13.2 - Visual graph integration with Zed

- Browser launch now waits for the graph page to connect, preserves launcher errors and exits unsuccessfully on failure so the task keeps its diagnostics visible.
- Added a local browser graph viewer for Zed tasks, reusing the existing graph interface and analysis engines.
- Supports Value Flow, incoming/outgoing provenance, JSON value simulation and Code Flow, with selected-edge highlighting and navigation back to Zed.
- Viewer sessions are reused per workspace, bound to loopback and authenticated; changed graph files block stale source navigation.
- Added task/keymap examples and included the viewer in the portable MCP package. Editor settings are not modified automatically.
- No automated tests or live editor/browser acceptance were run.

## 0.13.1 - Value flow, lifecycle fixes and MCP

- Value flow starts at the selected occurrence, preserves property/destructuring paths and enforces node/time budgets during exploration. Partial results report cutoffs.
- Selected nodes highlight incoming/outgoing arrows and labels. Origin/destination actions also remain available on property and identifier nodes.
- Lexical resolution respects scopes, parameters and local bindings shadowing imports. Exported variables participate in cross-file reference discovery.
- Configuration changes no longer reference an undefined cache directory. Source changes invalidate advanced graphs, and loading operations can be cancelled from the UI.
- Workers, React previews and runtime observation handle disposal during startup; runtime timelines remain frozen snapshots.
- Static simulation preserves short-circuit behavior and uncertainty, isolates nested branch data, handles arrow returns and avoids choosing a default switch case before a matching case.
- Added a separate local MCP server exposing `trace_value`, `code_flow`, `simulate_value` and `correlate_symbols`, with workspace restrictions, unsaved source buffers and native Zed configuration.
- MCP dependencies are separate from the VS Code extension. No editor configuration is modified automatically.
- Validation for these changes covers source syntax and package integrity. Automated tests and editor acceptance were not run.

## 0.13.0 - Provenance-first flow, UML and React improvements

- Added **Analyze Flow (Smart)** and **Analyze Class / UML Diagram** commands.
- Added local AST UML engine for TS/JS/React and lightweight Java declarations: attributes, visibility/types, methods/parameters/returns, extends/implements, imports/type dependencies, JSX render dependencies, hooks, fan-in/fan-out.
- Moved TS/JS **Value Flow** onto the fast AST/index worker; it no longer starts the precision LanguageService worker.
- Value origin can start from an arbitrary identifier use, including destructured callback parameters, and trace through callback invocation arguments when statically resolvable.
- Static value injection can fall back to the exact selected identifier occurrence when a declaration cannot be resolved, removing the common `SIMULATION_DECLARATION_REQUIRED` dead end.
- React preview pre-fills editable props JSON from declared prop types and destructuring defaults.
- React Tree gains an AST/import/JSX fallback when the previous hierarchy source returns no edges.
- Graph UI gains UML cards and clearer names/tooltips for Code Flow, Value Flow, Inject Value and Runtime.
- Open virtual documents no longer fail immediately with `UNSUPPORTED_URI`; buffer-local analysis is allowed where possible. Cross-file persistent-index analysis still requires filesystem-backed workspace files.
- Normal relations, UML, React fallback, CFG, simulation and value provenance use local algorithms/AST/index. Legacy precision machinery remains available for multi-symbol correlation in this release.

## 0.11.2

- Moved value simulation off the precision TypeScript worker and onto the lightweight syntax engine.
- Simulation no longer builds a workspace TypeScript Program or Language Service.
- Added an internal wall-clock budget that returns partial simulation evidence instead of `LOCAL_ENGINE_TIMEOUT` / worker restart.
- Direct same-file and quickly-resolved imported function calls can still be followed; unresolved/dynamic calls become `<unknown>`.
- Added `codeFlowLens.simulationTimeBudgetMs` (default 900 ms).
- Fixed the extension API version reported by `activate()`.


## 0.11.1 - Instant index AST safety fix

- Corrige crash `Cannot read properties of undefined (reading 'kind')` ao analisar `export { foo };` sem `from`.
- Trata listas de exportação local como exports reais para referências/callers entre arquivos.
- Adiciona guards defensivos para nós AST opcionais no Instant Index.
- Adiciona regressão cobrindo export local + alias de importação sem recorrer ao provider do VS Code.

## 0.11.0 - Instant AST/module index

- Removido o `TypeScript Program/TypeChecker` do caminho normal de Definition/References/Calls/Implementations.
- Novo índice leve baseado em AST + imports/exports + resolução de módulos; o TypeChecker profundo fica reservado para Value Trace/Correlation/Simulation.
- Referências têm budget interno de varredura e retornam cobertura parcial (`query-candidate-budget`) em vez de depender de timeout/restart.
- ASTs, resolução de módulos, barrels/reexports, candidatos e referências são cacheados no Worker até o código mudar.
- Imports relativos usam resolução direta barata antes do resolver geral do TypeScript.
- Barrels/reexports com alias entram na descoberta de candidatos, inclusive consumidores que usam outro nome local.
- Call graph inicial é calculado antes dos grupos de referência e reserva parte do node budget para callers/callees.
- Worker rápido é pré-aquecido em background no editor ativo via `onStartupFinished`, sem crawl do workspace.
- Hard timeout do Worker rápido virou somente watchdog catastrófico (mínimo 12s); operações normais são bounded internamente e não devem chegar nele.
- Adicionadas regressões com barrel alias e pacote com 1.400+ arquivos sem TypeScript Program no grafo normal.

## 0.10.0 - Instant query-local semantic engine

- O grafo TS/JS/React normal deixa de usar um `TypeScript LanguageService` de workspace; relações são resolvidas por um `TypeChecker` real em um **Program query-local** limitado aos arquivos candidatos do símbolo.
- Definição, referências, implementações e call graph compartilham o mesmo Program quente para o símbolo selecionado.
- Arquivos candidatos são descobertos por busca lexical barata e ordenados por proximidade/pacote antes do parsing semântico.
- Bibliotecas padrão e `@types` são excluídas do Program de relacionamento (`noLib`/`types: []`), reduzindo muito o custo de construção sem perder resolução dos módulos do workspace.
- Abrir outro grafo não invalida mais o motor semântico automaticamente; caches sobrevivem até uma mudança real de código/configuração.
- Edição de um buffer ou mudança de conteúdo invalida somente os Programs/cache sem revarrer toda a árvore do monorepo. Criação/remoção de arquivos continua disparando redescoberta estrutural.
- O Worker rápido anuncia `ready` sem varrer o monorepo: startup registra apenas o arquivo selecionado e a descoberta do pacote acontece somente na primeira consulta que realmente precisa dela.
- Cancelar uma consulta normal ao clicar rapidamente em outro símbolo agora encerra imediatamente o Worker daquela consulta; a próxima seleção recebe um Worker novo e barato, em vez de ficar presa atrás de trabalho obsoleto. Hard timeout mantém a mesma garantia de não deixar consulta zumbi.
- Value Trace, Correlation e Simulation agora rodam em um **Worker de precisão separado**; análises pesadas não bloqueiam nem derrubam o motor rápido de relações.
- O conjunto semântico interativo é limitado a candidatos próximos/relevantes (240 por padrão interno); símbolos extremamente comuns recebem `query-candidate-budget` em vez de esperar um projeto gigante ou fingir cobertura total.
- Java também passou a descobrir o pacote sob demanda no primeiro uso; o Worker não precisa indexar todos os `.java` antes de abrir o grafo.
- Mantido o motor Java leve independente de `redhat.java`.

## 0.9.1 - Adaptive embedded semantics and timeout cascade fix

- Corrigido o efeito cascata em que `references` excedia 2500 ms, matava o Worker quente e fazia `prepare`/`implementations` recomeçarem frios e também expirarem.
- `localEngineTimeoutMs` passa a ser um budget-base; referências, implementações, call hierarchy e busca de símbolos recebem budgets adaptativos próprios.
- Adicionado **semantic prime** por arquivo: o programa TypeScript focado é construído uma vez e reutilizado pelas consultas seguintes enquanto os overlays não mudarem.
- Contextos TypeScript interativos muito grandes passam a usar uma fatia focada de até 1.800 arquivos próximos ao símbolo atual, com aviso explícito de cobertura parcial.
- Referências/incoming calls não instanciam mais Language Services de contextos que não contêm o arquivo selecionado.
- A análise inicial é progressiva e priorizada: definição -> referências -> chamadas -> implementações. Uma falha tardia não apaga relações já obtidas.
- Timeout continua sendo preemptivo: o Worker ativo é encerrado e não deixa consulta zumbi em background.
- Default do budget-base alterado de 2500 ms para 3000 ms; configurações antigas em 2500 ms continuam recebendo os budgets adaptativos para operações pesadas.
- Adicionadas regressões para budget adaptativo, kill real do Worker e pacote TypeScript com centenas de consumidores usando baseline de 2500 ms.

## 0.9.0 - Value tracing, correlation and static simulation

- Adicionado **Value Flow** interprocedural para TypeScript/JavaScript/TSX/JSX.
- O tracer segue, quando resolvível, atribuições, argumentos -> parâmetros, retornos -> call sites, destructuring, propriedades de objetos e props JSX.
- Props JSX agora atravessam parâmetros destructured e o padrão comum `props.nome`, permitindo continuar o fluxo dentro do componente.
- Adicionado **Multi-Symbol Correlation** para 2 a 8 símbolos.
- Correlação identifica convergência de valores, origem/destino comum, parâmetro compartilhado, escrita compartilhada, objeto compartilhado, mesmo escopo de função, mesmo call site, caller comum e callee comum.
- Símbolos podem ser correlacionados com múltiplos cursores ou adicionados um por um a um conjunto de correlação persistente na sessão do VS Code.
- Adicionado **Simulate Selected Value**: o usuário fornece um valor JSON/primitivo e o Code Flow Lens interpreta estaticamente um subconjunto seguro do AST.
- A simulação acompanha variáveis locais e parâmetros, destructuring, objetos/arrays, operadores comuns, condições, loops limitados, switch e chamadas diretas para funções do workspace.
- Valores desconhecidos aparecem como `<unknown>` em vez de serem inventados.
- A simulação não usa `eval`, não importa módulos do projeto e não executa código do workspace.
- Injeção em variável local agora substitui corretamente o inicializador no caminho simulado; bindings destructured também podem receber valor diretamente.
- Branches desconhecidos clonam o ambiente antes de simular alternativas, evitando vazamento de mutações entre caminhos.
- Correlação estrutural complementa a correlação de valores para responder “onde esses símbolos aparecem juntos?” mesmo quando os valores não convergem.
- A UI ganhou modos **Value flow**, **Correlate** e **Simulate**, chips de valor/interseção, raízes de correlação destacadas e navegação Origin/Destination.
- Operações pesadas de valor usam budget próprio e continuam executando no worker local preemptivo da extensão.

## 0.8.1 - Focus-first monorepo indexing

- Corrigido `File not indexed within this compilation context or discovery budget` em monorepos grandes.
- O arquivo TS/JS selecionado agora tem prioridade absoluta e é indexado sob demanda mesmo quando ficou fora de `localEngineMaxFiles`.
- Quando um projeto caiu fora do limite inicial de 16 contextos, o motor procura `tsconfig/jsconfig` do diretório atual até a raiz e recria um contexto focado.
- O contexto focado prioriza arquivos próximos e o `package.json` mais próximo, sem aumentar a varredura global do workspace.
- Diagnóstico do motor passa a consultar o estado atual do worker, incluindo contextos focados criados depois da inicialização.
- Mantido o worker preemptivo: timeout continua encerrando o worker em vez de deixar consultas zumbis.

## 0.8.0 - Embedded local language engine

- TS/JS/TSX/JSX deixam de depender do language server do VS Code no modo padrão.
- Adicionado motor semântico embutido baseado no TypeScript Language Service empacotado, executado em Worker separado do Extension Host.
- Adicionados overlays dos documentos TS/JS abertos: alterações não salvas participam de referências e call hierarchy.
- Timeout local passa a ser preemptivo: ao exceder o orçamento, o worker é terminado; não fica uma consulta antiga rodando em background.
- Consultas ao worker são serializadas por workspace para que consultas paralelas do grafo não expirem apenas por estarem esperando na fila.
- Adicionado índice Java local leve para definições, referências, owners e callers/callees sem depender de `redhat.java`.
- Mantido parser JDK para CFG/data-flow local de métodos Java.
- Adicionado `codeFlowLens.semanticEngine`: `local` (padrão), `hybrid` e `vscode`.

## 0.7.0 - VS Code only

- Produto simplificado para ser somente uma extensão interativa do VS Code.
- Removidas integrações externas, servidores auxiliares, instaladores globais e configuração de agentes.
- Mantidos grafo semântico, Code flow, React tree, Render React e Runtime Observer.
