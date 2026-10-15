# Code Flow Lens 0.13.6

Ferramenta de análise de código com extensão visual para VS Code, visualizador para Zed e servidor MCP para agentes de IA, voltada a responder quatro perguntas durante desenvolvimento e debugging:

1. **Quem usa este símbolo e o que ele usa?**
2. **De onde este valor pode vir e para onde ele pode ir?**
3. **Onde dois ou mais símbolos se encontram ou aparecem juntos?**
4. **Se eu assumir um valor para esta variável, como ele se propaga pelo código que conseguimos interpretar estaticamente?**

O backend padrão é o **Code Flow Lens Persistent Semantic Index**. Um Bloom index compacto por arquivo é construído incrementalmente em background e persistido no armazenamento da extensão; consultas normais usam esse índice para reduzir o conjunto de arquivos antes de abrir ASTs. O caminho crítico não espera a indexação completar. O parser/AST continua sendo usado para confirmar relações e aliases, sem depender de LSP. TypeScript, JavaScript, TSX e JSX usam o parser TypeScript empacotado em Worker isolado. O grafo normal **não cria TypeScript Program, TypeChecker ou Language Service**. Value Flow também usa o tracer AST/index próprio na 0.13. O mecanismo de precisão baseado no compilador fica isolado para Multi-Symbol Correlation nesta versão; a simulação usa o interpretador AST leve e bounded. Java usa um índice local leve para relações cross-file e o JDK para CFG/data-flow de método quando disponível.

A extensão é somente uma ferramenta do usuário dentro do VS Code. Ela não instala MCP, agentes, servidores globais ou configuração externa.

## Distribuições

Baixe os arquivos em [GitHub Releases](https://github.com/Dojassola/Value-Flow-VScode/releases/latest):

| Arquivo | Uso |
| --- | --- |
| `.vsix` | Instalar a extensão no VS Code/VSCodium. |
| `portable.zip` | Zed + MCP + instalador + dependências + VSIX, em um único pacote. |
| `source.zip` | Fontes públicos para desenvolvimento. |
| `SHA256SUMS.txt` | Conferir a integridade dos downloads. |

As releases são [geradas e publicadas manualmente pelo computador](docs/RELEASE.md), sem workflow por commit. Planos e relatórios internos ficam em `.local/`, ignorada e excluída das distribuições.

## MCP e Zed

A versão 0.13.6 também oferece um servidor MCP separado, que compartilha os motores da extensão. Ele complementa Graft e Serena com proveniência de valores, transformações/condições, fluxo de controle, simulação, UML, dependências e correlação; a extensão do VS Code continua independente.

Use o pacote `code-flow-lens-portable-0.13.6.zip`, com Node.js 20 ou superior. Ele inclui um instalador que adiciona as tarefas do Zed ou instala a extensão no VS Code. A configuração dos agentes e os limites da análise estão em [MCP para agentes e grafo web](docs/MCP.md).

O pacote também inclui um [visualizador para o Zed](docs/ZED.md): tarefas e atalhos abrem o mesmo grafo no navegador local, com Value Flow, origem/destino, transformações/condições, simulação, Code Flow, UML, dependências e navegação de volta ao arquivo no editor. O visualizador funciona sem configurar o MCP. Com `--viewer`, qualquer agente MCP pode ler a seleção, refazer a análise e destacar evidências na interface.

## Redux

Value Flow também liga leituras de Redux aos reducers registrados na store: estado inicial, alterações, ações, dispatches e dados enviados às ações. Há suporte estático para Redux clássico com `switch`, `reduxsauce` e Redux Toolkit com `createSlice`/`createReducer` e `addCase`.

Selecione, por exemplo, `state.menu.collapsed`, uma variável de `useSelector`/`useAppSelector`, um campo do estado inicial ou uma propriedade no reducer, e abra **Value Flow**. Os cartões Redux mostram o caminho do estado, a store e o tipo da ação; as transformações e condições continuam no painel de detalhes. O mesmo resultado chega à IA pelo MCP, sem configuração adicional.

O grafo descreve alterações possíveis encontradas no código. Não reconstrói a sequência real de dispatches nem o valor atual da store. Middleware, thunks, persistência/rehidratação, reducers injetados, matchers e campos dinâmicos podem exigir análise manual; avisos indicam descobertas incompletas e operações não resolvidas.

## Instalação

Extraia o ZIP acima e, dentro da pasta extraída, escolha o editor:

```sh
node install.cjs zed
node install.cjs vscode
```

No Zed, o instalador copia os arquivos para `~/.code-flow-lens/0.13.6` e cria/atualiza somente as duas tarefas Code Flow Lens no arquivo global, com backup. As outras tarefas, comentários fora das tarefas atualizadas e atalhos são preservados. No VS Code, instala o VSIX incluído no pacote pela [CLI `code`](https://code.visualstudio.com/docs/configure/command-line); para VSCodium, use `node install.cjs vscode --code-command codium`. No Windows, instale o VSIX pela interface do editor.

Para instalar o VSIX manualmente:

1. Abra **Extensions** no VS Code.
2. Use **... > Install from VSIX...**.
3. Selecione `code-flow-lens-0.13.6.vsix`.
4. Execute **Developer: Reload Window**.

Atalho padrão:

- Windows/Linux: `Ctrl+Alt+C`
- macOS: `Cmd+Alt+C`

Use **Code Flow Lens: Configure Shortcut** para trocar a combinação.


## 0.13: Analyze Flow, provenance and UML

A barra principal agora separa **Analyze**, **Relations**, **Value flow**, **Inject value**, **Class / UML**, **Correlate**, **Code flow**, **React tree**, **Render React** e **Runtime**. O comando **Analyze Flow (Smart)** escolhe automaticamente uma vista útil para a posição atual, mas os modos especializados continuam disponíveis.

### Investigar um valor em qualquer uso

`Value flow` não exige mais que o cursor esteja na declaração. Ele pode começar em um uso como `quadra.properties.entidadeId`, procurar a declaração lexical e, quando o valor é parâmetro de um callback inline, seguir para a função que recebeu o callback e procurar onde esse callback é invocado. Assim padrões como `gerarLotesPorQuadra(async ([quadra]) => ...)` podem ser rastreados para trás sem LSP. O tracer é AST/index próprio e segue atribuições, argumentos, callbacks, retornos, destructuring, objetos e props JSX quando resolvíveis.

`Inject value` é diferente: ele responde uma pergunta hipotética. Você informa, por exemplo, `quadra = {"properties":{"entidadeId":42}}` e o interpretador estático tenta percorrer branches/operações a partir daquele ponto. Ele não executa o projeto. Se não houver declaração sintática clara, a 0.13 pode injetar o valor diretamente na ocorrência selecionada e marca essa aproximação no resultado.

`Code flow` continua sendo o CFG: ordem de statements, `if/else`, loops, joins, `return`, reads/writes. Portanto:

- **Code flow** = quais caminhos de controle existem;
- **Value flow** = de onde este dado pode vir e para onde pode ir;
- **Inject value** = o que o interpretador prevê se eu assumir este valor;
- **Analyze** = escolhe uma destas vistas de forma contextual.

### Analyze Class / UML

`Code Flow Lens: Analyze Class / UML Diagram` analisa o arquivo/classe/componente com AST local. O card UML mostra atributos, visibilidade, tipos, métodos, argumentos, retornos, hooks e métricas `fan-in`/`fan-out`. As relações incluem `extends`, `implements`, dependências de tipos/imports e, para React, `renders`/hooks. Imports externos podem aparecer como dependências sem fingir que são classes locais.

O objetivo é permitir tanto leitura de uma classe isolada quanto análise de acoplamento: classes/componentes com fan-out alto tendem a depender de muitos módulos; fan-in alto indica muitos consumidores. Isso é uma pista de modularidade, não um julgamento automático de design.

### React tree e props de preview

O React Tree ganhou fallback próprio por AST/imports/JSX quando a camada semântica não devolve arestas. `Render React` agora pré-preenche o JSON de props com valores seguros inferidos de interfaces/type literals, tipos primitivos e defaults de destructuring. Callbacks/funções não são inventados no JSON; props desconhecidas recebem `null` e continuam editáveis antes de renderizar.

### Runtime

`Runtime` é uma ferramenta opcional para observar uma aplicação realmente aberta no navegador: DOM, estado React best-effort, rede, screenshots e diferenças entre snapshots, sempre mediante autorização explícita. Ele serve para confirmar comportamento que análise estática não pode provar. Não é necessário para usar Relations/Code flow/Value flow/UML.

### URIs virtuais

A posição atual pode vir de um documento virtual do VS Code. A 0.13 deixa de falhar imediatamente com `UNSUPPORTED_URI` quando o documento virtual está aberto: análises puramente locais ao buffer podem funcionar. Relações cross-file do índice persistente continuam exigindo arquivos reais no workspace.

## Relações semânticas

Coloque o cursor sobre uma função, variável, classe, hook, método ou componente e execute **Show Symbol Flow**.

A vista combina definição/implementação consolidadas, referências agrupadas por arquivo, callers/callees, expansão incremental, `Trace owner + uses`, código-fonte nos cards e navegação para a posição real.

No modo `local`, TS/JS/React e Java não dependem das filas dos language servers do VS Code para essas relações.

## Value Flow: de onde vem / para onde vai

Selecione um símbolo e use **Code Flow Lens: Trace Value Flow** ou o botão **Value flow**.

O tracer interprocedural segue relações estáticas quando consegue resolvê-las:

```text
source
  │ assign
  ▼
local
  │ argument
  ▼
function(parameter)
  │ return
  ▼
result
```

Também reconhece:

- atribuições e aliases;
- argumentos -> parâmetros;
- `return` -> resultado do call site;
- destructuring;
- propriedades de objeto;
- objetos inline;
- props JSX;
- props React destructured e leituras comuns `props.nome`.

Use **Value origin** para olhar para trás e **Value destination** para olhar para frente.

Uma aresta significa **“este valor pode alimentar este destino segundo a análise estática”**. Ela não afirma que aquele caminho executará em runtime.

## Multi-Symbol Correlation

A correlação aceita de 2 a 8 símbolos e procura onde eles se relacionam.

### Forma rápida: múltiplos cursores

Crie dois ou mais cursores no mesmo editor sobre símbolos diferentes e execute:

**Code Flow Lens: Correlate Selected Symbols**

### Forma incremental

Em arquivos diferentes, use:

**Code Flow Lens: Add Symbol to Correlation**

em cada símbolo. O status bar mostra quantos símbolos estão no conjunto. Depois execute **Correlate Selected Symbols**. Para zerar, use **Clear Correlation Symbols**.

A análise distingue tipos concretos de relação, em vez de usar apenas um rótulo genérico “correlated”:

- `common_destination`: fluxos chegam ao mesmo destino;
- `common_origin`: fluxos compartilham uma origem;
- `shared_parameter`: valores alimentam o mesmo parâmetro;
- `shared_write_target`: valores podem escrever no mesmo símbolo;
- `shared_object_target`: valores entram no mesmo objeto/propriedade estrutural;
- `shared_function_scope`: símbolos aparecem dentro da mesma função;
- `shared_call_site`: os símbolos são usados juntos na mesma chamada;
- `common_caller`: o mesmo caller chama dois símbolos selecionados;
- `common_callee`: duas funções selecionadas chamam a mesma função;
- `direct_collision`: interseção direta que não cabe nas categorias mais específicas.

Os nós de interseção ficam destacados e o grafo tenta manter só os menores caminhos que conectam cada símbolo selecionado às interseções.

## Simulate Selected Value

Selecione uma variável ou parâmetro dentro de uma função e execute **Code Flow Lens: Simulate Selected Value**.

Digite um valor, por exemplo:

```text
42
true
"abc"
{"id":7,"active":true}
[1,2,3]
undefined
```

O Code Flow Lens injeta esse valor no símbolo selecionado e interpreta um subconjunto seguro do AST a partir da função que o contém.

Exemplo:

```ts
function normalize(value: number) {
  return value * 2;
}

function run(input: number) {
  let current = input + 1;

  if (current > 5) {
    current = current + 1;
  }

  return normalize(current);
}
```

Ao simular `current = 7`, a vista pode mostrar:

```text
inject current = 7
       ↓
if => true
       ↓
current = 8
       ↓
call normalize [8]
       ↓
return 16
```

A simulação suporta atualmente:

- parâmetros e variáveis locais;
- bindings destructured;
- literais, objetos e arrays;
- property/element access em valores conhecidos;
- operadores aritméticos, comparações e operadores lógicos comuns;
- atribuições e `+=`, `-=`, `*=`, `/=`, `%=`;
- `++`/`--`;
- `if` e expressão condicional;
- `switch`;
- loops simples com limite de iterações;
- chamadas diretas para funções/métodos do workspace quando o alvo é resolvido estaticamente;
- profundidade e número de passos limitados.

**Nenhum código do workspace é executado.** Não há `eval`, import dinâmico ou execução de módulos do projeto. APIs externas, dispatch dinâmico, async, getters/proxies, browser/framework runtime e chamadas não resolvidas viram `<unknown>`.

A simulação é útil para explorar cenários, não para substituir teste/runtime/debugger.

## Code flow

**Code flow** abre uma visão estilo CFG/disassembler da função ou método atual, com blocos de código reais.

Ela mostra controle (`next`, `true`, `false`, loops, returns etc.) e dependências locais de dados. **Walk path** permite percorrer o grafo; no CFG puro você escolhe branches manualmente.

## React

### React tree

Mostra hierarquia JSX estática entre componentes nomeados.

### Value flow por props

O Value Flow consegue atravessar padrões React comuns:

```tsx
<Child user={currentUser} />
```

para:

```tsx
function Child({ user }) { ... }
```

ou leituras como `props.user` em componentes funcionais, quando o componente e o símbolo são resolvidos pelo motor local.

### Render React

**Render React** renderiza o componente selecionado usando React/ReactDOM já instalados no projeto, após autorização do usuário e somente em workspace confiável.

## Runtime Observer

O botão **Runtime** continua disponível como ferramenta opcional para observar uma aplicação real em Chrome/Chromium: DOM, estado/props detectáveis, erros, requests, respostas JSON autorizadas, screenshots e comparação de snapshots.

Runtime observado é evidência temporal; não é automaticamente tratado como prova de causalidade.

## Motor semântico

Configuração padrão:

```json
{
  "codeFlowLens.semanticEngine": "local",
  "codeFlowLens.localEngineTimeoutMs": 3000,
  "codeFlowLens.localEngineStartupMs": 6000,
  "codeFlowLens.localEngineMaxFiles": 8000,
  "codeFlowLens.valueEngineTimeoutMs": 6000,
  "codeFlowLens.valueTraceDepth": 4,
  "codeFlowLens.valueTraceMaxNodes": 140,
  "codeFlowLens.simulationMaxSteps": 180,
  "codeFlowLens.simulationMaxDepth": 4
}
```

A navegação normal usa dois níveis bem separados:

```text
Persistent Bloom + AST index      Precision engine
-----------------------           ----------------
definition                         value trace
references                         correlation
callers/callees                    Value Trace / Correlation
implementations
owners
```

O **Instant Index não constrói um TypeScript Program**. A definição é resolvida a partir do AST atual, imports, exports, aliases, reexports e resolução de módulos. Referências e callers procuram somente candidatos no pacote atual dentro de um pequeno budget interno, parseiam os arquivos encontrados e reutilizam caches de AST, módulos, barrels e referências.

O Worker é pré-aquecido em background para o editor ativo (`onStartupFinished`). Assim o custo de carregar o parser TypeScript normalmente acontece antes do primeiro `Ctrl+Alt+C`. O startup continua focus-only: prewarm não percorre o monorepo.

Para símbolos extremamente comuns ou árvores enormes, o motor devolve o que encontrou dentro do budget e marca `query-candidate-budget`; ele não fica esperando um TypeChecker gigante até expirar. `localEngineTimeoutMs` permanece como watchdog catastrófico do Worker, não como mecanismo normal de latência.

Callers são priorizados antes dos grupos de referência, e o grafo reserva parte do node budget para não deixar centenas de arquivos de referência expulsarem todo o call graph.

O Instant Index resolve os padrões mais comuns de imports nomeados/default, aliases, path aliases suportados pelo tsconfig e barrels/reexports. Casos que dependem de overload resolution profunda, dispatch dinâmico, decorators/plugins do compilador ou tipos externos podem ficar parciais; para fluxo de valor explícito use o Precision Engine.

## Java

Definições/referências/callers/callees cross-file usam o índice Java leve da extensão. O **Code flow** de método pode usar JDK 11+ para parsing mais preciso.

O novo Value Tracer interprocedural, Multi-Symbol Correlation de valores e Static Simulation são, nesta versão, específicos de TypeScript/JavaScript/TSX/JSX. Java mantém relações semânticas e CFG/data-flow local já existentes.

## Navegação

- arraste o fundo com botão esquerdo para mover;
- botão do meio também move;
- `Ctrl`/`Cmd` + wheel faz zoom no cursor;
- **Fit** enquadra;
- **Center** centraliza o selecionado;
- **Origin / Destination** filtra direção;
- **Reset view** limpa filtros;
- **Details** abre/fecha o painel lateral.

## Limites importantes

O tracer é **bounded static analysis**, não um heap/alias/taint engine completo. Ele pode perder relações que dependem de reflection, proxies, mutações indiretas, callbacks/closures complexos, DI, bibliotecas externas ou dispatch dinâmico.

A correlação significa que uma relação estática foi encontrada dentro do budget. Ela não prova que os símbolos colidem em runtime. Da mesma forma, não encontrar interseção não prova independência.

A simulação não executa o aplicativo e valores desconhecidos permanecem explicitamente `<unknown>`.

Veja `docs/CODE_FLOW.md`, `docs/RUNTIME.md` e `docs/SECURITY.md` para detalhes.


### Lightweight value simulation (0.11.2)

`Simulate Selected Value` now uses the always-on syntax/index worker rather than the precision TypeScript worker. It has a small internal time/step budget and returns a partial graph when that budget is reached. Dynamic dispatch, unresolved library calls and runtime-only behavior are represented as `<unknown>` instead of forcing a workspace-wide semantic build.

```json
{
  "codeFlowLens.simulationMaxSteps": 180,
  "codeFlowLens.simulationTimeBudgetMs": 900,
  "codeFlowLens.simulationMaxDepth": 4
}
```
