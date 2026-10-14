# Code Flow Lens MCP para agentes e grafo web

O servidor MCP compartilha os motores de análise do Code Flow Lens. Seu foco é seguir valores e explicar caminhos do código. Graft e Serena continuam úteis para localizar símbolos e obter definições/referências; use as posições encontradas como entrada para estas análises.

## Instalação

Extraia `code-flow-lens-portable-0.13.5.zip`. O pacote inclui o parser, o SDK oficial MCP, suas dependências e licenças. Requer Node.js 20 ou superior. Não precisa de Rust nem executa código da aplicação.

Para instalar a interface e as tarefas do Zed, execute `node install.cjs zed` na pasta extraída. O servidor fica em `~/.code-flow-lens/0.13.5/mcp/server.mjs`; use seu caminho absoluto na configuração do agente. `node install.cjs vscode` instala o VSIX incluído no pacote. O instalador não configura os agentes automaticamente.

## Codex, Antigravity e outros agentes

A IA fica no agente que você escolher. Este servidor oferece ferramentas e evidências, usando MCP padrão; não contém um modelo, chat próprio ou chave de API. Há dois modos:

- `--viewer`: conecta o agente aos grafos web abertos, inclusive à seleção atual. A análise solicitada pela IA aparece no navegador.
- `--workspace /projeto`: oferece análises de arquivos nesse projeto, mesmo sem abrir a interface visual.

Para usar o grafo web no Codex:

```sh
codex mcp add code-flow-lens -- node /caminho/absoluto/code-flow-lens/mcp/server.mjs --viewer
```

Também pode acrescentar [codex.example.toml](../mcp/codex.example.toml) à configuração do Codex, ajustando o caminho. Preserve os servidores existentes.

No Antigravity, abra **MCP Servers → Manage MCP Servers → View raw config** e acrescente a entrada de [antigravity.example.json](../mcp/antigravity.example.json) ao objeto `mcpServers`. O arquivo padrão atual é `~/.gemini/config/mcp_config.json`. Preserve as outras entradas e use caminho absoluto.

Com o grafo aberto, selecione um nó e clique em **Copy for AI**. Cole a instrução no Codex, Antigravity ou outro agente conectado. Exemplo: “Use o Code Flow Lens para explicar as transformações deste valor, as condições dos caminhos e destacar o ponto em que ele muda.” A mesma conexão permite pedir UML e dependências. O agente decide quais ferramentas chamar.

| Ferramenta no modo web | Uso |
| --- | --- |
| `list_open_graphs` | Descobrir os grafos conectados e seus workspaces. |
| `get_open_graph` | Ler o grafo, seleção, cartão de código e avisos. |
| `analyze_open_graph` | Refazer Value Flow, simulação, Code Flow, UML ou dependências na seleção atual. |
| `focus_graph_node` | Destacar e centralizar um nó já presente no navegador. |

O agente recebe identificadores de sessão, nunca os tokens locais. Só os visualizadores conectados aparecem na descoberta. Reexecute a tarefa do Zed após atualizar esta versão para carregar o novo servidor web. A conexão não altera arquivos nem executa a aplicação; alterações no código dependem das ferramentas e instruções do próprio agente.

Referências: [MCP no Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [MCP no Antigravity](https://antigravity.google/docs/mcp).

Ao trabalhar diretamente com os fontes, instale as dependências do servidor, separadas da extensão:

```sh
npm ci --prefix mcp --ignore-scripts --no-audit --no-fund
```

O cliente MCP deve iniciar o processo diretamente com Node:

```sh
node /caminho/para/code-flow-lens/mcp/server.mjs --workspace /caminho/para/seu/projeto
```

O workspace é obrigatório. Os caminhos relativos nas chamadas das ferramentas são resolvidos dentro dele. O servidor usa stdio; nenhuma porta de rede é aberta.

## Configuração no Zed

Em Settings → AI → MCP Servers, adicione um servidor local com o comando e argumentos acima. Também é possível adicionar a entrada de [zed/settings.example.json](../zed/settings.example.json) ao objeto `context_servers` das configurações, substituindo os dois caminhos de exemplo por caminhos absolutos reais. Preserve as entradas existentes de Graft e Serena.

Esta integração usa o Agent Panel do Zed; o MCP retorna grafos estruturados e evidências para o agente. Para usar a interface visual, configure o [visualizador por tarefas](ZED.md), que abre o grafo no navegador e recebe a posição do cursor do Zed. O servidor MCP não escolhe automaticamente o projeto ou a posição do cursor.

Referência: [MCP no Zed](https://zed.dev/docs/ai/mcp).

## Ferramentas no modo workspace

| Ferramenta | Pergunta que responde | Entrada |
| --- | --- | --- |
| `trace_value` | De onde este valor pode vir e para onde pode ir? | `file`, `line`, `column`; `direction` aceita `incoming`, `outgoing` ou `both`. |
| `code_flow` | Quais caminhos, leituras e escritas existem nesta função? | `file`, `line`, `column`. Retorna controle e dependências locais. |
| `simulate_value` | O que o interpretador prevê se eu assumir este valor? | `file`, `line`, `column`, `value` como JSON. Selecione variável/parâmetro; para propriedades, injete o objeto na variável base. |
| `correlate_symbols` | Onde estes símbolos se encontram? | `positions`: 2 a 8 objetos com `file`, `line`, `column`. Usa o motor de precisão e custa mais que um trace individual. |
| `class_diagram` | Quais classes, interfaces, tipos/componentes, membros e relações estão visíveis no arquivo? | `file`, `line`, `column`. |
| `module_dependencies` | Quais módulos são importados ou reexportados pelo arquivo? | `file`, `line`, `column`; TS/JS/JSX/TSX. |

Linhas e colunas começam em 1. A coluna deve apontar para o identificador selecionado. `trace_value` e correlação aceitam `depth` e `maxNodes`; a simulação aceita `maxSteps` e `maxDepth`. Os padrões e limites aparecem nos schemas MCP.

Cada posição pode fornecer `sourceText` com o buffer completo de um arquivo existente, limitado a 2 MB. Isso permite analisar alterações não salvas sem escrever no projeto. Sem esse campo, a análise usa os arquivos salvos. Buffers divergentes para o mesmo arquivo são rejeitados.

## Evidências e limites

Os resultados incluem nós, trechos de código, posições, arestas e `analysis`. Nós de valores/simulação também podem incluir `transformation` (expressão e operador) e `conditions` (guardas sintáticas, ramo e posição). Consulte `analysis.warnings`, `analysis.state` e `analysis.coverage.cutoffs` antes de concluir que uma origem/destino não existe. Valores desconhecidos permanecem desconhecidos.

Value Flow representa leituras por `.propriedade` ou `[chave]` em posições separadas antes de expandir as chamadas consumidoras. Referências atravessam reexports, incluindo `export *`. Se a busca estiver limitada ou o índice ainda estiver sendo construído, `VALUE_TRACE_REFERENCES` informa que outros usos podem estar ausentes; refaça a análise após a indexação.

Condições do Value Flow descrevem a estrutura do código; não são resolvidas simbolicamente nem provam que um ramo executou. A simulação interpreta as condições que consegue calcular e mantém alternativas incertas explícitas. Proveniência por nome/binding não é uma reconstrução completa de todas as versões do valor após cada escrita. UML e dependências descrevem o arquivo selecionado; não são um mapa transitivo completo do repositório.

O rastreamento segue relações sintáticas resolvíveis. Dispatch dinâmico, reflexão, mutações em runtime, frameworks e operações não implementadas podem interromper a análise. A simulação interpreta um subconjunto de TS/JS e não substitui execução ou debugging. Code flow em Java requer JDK 11 ou superior; os outros três modos usam TS/JS/JSX/TSX.

As ferramentas não editam arquivos, executam a aplicação, iniciam preview/runtime nem fazem buscas fora do workspace configurado. Os bloqueios de fontes sensíveis, dependências e symlinks externos são preservados.

Validação desta versão: conferência de sintaxe, API do SDK e integridade dos pacotes. Não houve execução de testes, handshake MCP ou validação nos editores.
