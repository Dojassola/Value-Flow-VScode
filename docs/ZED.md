# Grafo visual no Zed

O visualizador usa a mesma interface do Code Flow Lens em um navegador local. O Zed envia a posição do cursor por uma tarefa; duplo clique em um nó ou o botão **Open source** abre sua linha no editor.

Inclui Value Flow, origem/destino, expressões de transformação e condições dos caminhos, simulação de um valor JSON, Code Flow, UML, dependências de módulos, seleção com destaque das setas, filtros, caminhada estática, cartões de código e exportação JSON. [O MCP conecta qualquer agente compatível ao grafo aberto](MCP.md), incluindo Codex e Antigravity. Relations, correlação, React preview e observação de runtime continuam na extensão VS Code; seus controles ficam ocultos neste visualizador.

## Instalação

1. Extraia `code-flow-lens-portable-0.13.6.zip`. O pacote inclui o visualizador, as dependências, o instalador e o VSIX; use Node.js 20 ou superior.
2. Dentro da pasta extraída, execute `node install.cjs zed`. Ele copia os arquivos para `~/.code-flow-lens/0.13.6` e adiciona/atualiza as duas tarefas globais pelo nome. Os caminhos do Node e do visualizador são absolutos. Tarefas existentes recebem backup antes da alteração; outras tarefas e atalhos são preservados. JSONC inválido é recusado sem sobrescrever o arquivo.
3. No Zed, execute **task: spawn** e escolha **Code Flow Lens: Value Flow** ou **Code Flow Lens: Code Flow**. Feche o grafo antigo antes de abrir a versão atualizada.

Os atalhos são opcionais: execute **zed: open keymap** e acrescente o objeto de [keymap.example.json](../zed/keymap.example.json), ajustando conflitos. No macOS, você pode trocar `ctrl-alt` por `cmd-alt`. O instalador preserva os atalhos personalizados.

Para configuração manual ou somente no projeto, use **zed: open tasks** / **zed: open project tasks** e acrescente [tasks.example.json](../zed/tasks.example.json), ajustando o caminho absoluto.

As tarefas salvam o arquivo atual antes da análise. Outros arquivos precisam estar salvos para que suas alterações participem do grafo. O instalador altera somente as tarefas; a configuração da IA permanece no agente escolhido.

Para VS Code, o mesmo pacote oferece `node install.cjs vscode`; para VSCodium, acrescente `--code-command codium`. O VSIX também pode ser instalado pela interface do editor, inclusive no Windows.

Para executar diretamente a partir destes fontes:

```sh
node /caminho/para/code-flow-lens/zed/viewer.cjs \
  --workspace /caminho/absoluto/do/projeto \
  --file /caminho/absoluto/do/projeto/src/arquivo.ts \
  --line 12 --column 8
```

Use `--mode code` para iniciar com Code Flow. Para Value Flow, coloque o cursor sobre a variável ou propriedade. Para simular uma propriedade, selecione a variável do objeto e forneça seu valor JSON.

## Uso

- **Ctrl+Alt+V**: abre Value Flow na posição atual.
- **Ctrl+Alt+F**: abre Code Flow na posição atual.
- **Value origin / Value destination**: refaz a análise a partir do nó selecionado.
- **Origin / Destination**: filtra os caminhos já presentes no grafo.
- **Inject value**: solicita um valor JSON e faz uma previsão estática limitada.
- **Class / UML**: mostra classes, interfaces, tipos e componentes nomeados com seus membros e relações visíveis no arquivo.
- **Dependencies**: mostra imports, reexports e import-equals de TS/JS. Os nós apontam para a declaração no arquivo atual. Imports dinâmicos, require comum e dependências transitivas do projeto não são inferidos.
- **Copy for AI**: copia uma instrução com o identificador do grafo para colar no seu agente com o MCP configurado. O chat e o modelo ficam no Codex, Antigravity ou cliente escolhido.
- **Refresh**: lê novamente os arquivos salvos e refaz a última análise. Use o atalho do editor para mudar a posição inicial.
- **Close viewer**: encerra o processo local deste projeto. Ele também termina após 90 segundos sem nenhuma aba conectada.

É necessário ter a CLI do Zed no PATH para abrir os nós no editor. Se sua distribuição usa `zeditor`, acrescente `"--zed", "zeditor"` aos argumentos das duas tarefas. No macOS, instale a CLI com **cli: install cli binary**. Também pode ser usado um caminho absoluto com `--zed`.

O processo é reutilizado por projeto e executável do Zed. Rodar novamente a tarefa atualiza o grafo nas abas conectadas e abre seu endereço no navegador padrão. O lançador aguarda a conexão da página por até 15 segundos antes de concluir. Se a abertura automática falhar, a tarefa termina com erro e seu terminal permanece aberto, mostrando a mensagem do navegador e o endereço para abrir manualmente. Use `"reveal": "always"` e `"hide": "on_success"` para esse comportamento.

## Limites

O servidor escuta somente em `127.0.0.1`, com porta atribuída pelo sistema e token temporário. Acesso a fontes continua limitado ao workspace, com exclusão de dependências, arquivos sensíveis e symlinks externos. Os dados não são enviados a serviços externos. Antes de seguir uma posição, o visualizador compara a data de modificação e o tamanho dos arquivos representados no grafo; alterações exigem Refresh.

A interface usa os arquivos salvos e não acompanha automaticamente o cursor ou a edição; rode novamente a tarefa para mudar o ponto de partida.

Nos detalhes dos nós, **Value transformation** mostra a expressão responsável pelo valor, e **Path conditions** lista as guardas sintáticas do local. Esses campos descrevem possibilidades estáticas. A simulação distingue arestas true/false e resultados reunidos de ramos desconhecidos, preservando os avisos de incerteza.

A interface fica em uma janela do navegador. A [API de extensões do Zed](https://zed.dev/docs/extensions/developing-extensions) ainda não oferece um painel HTML embutido; o pedido é acompanhado na [issue de webview](https://github.com/zed-industries/zed/issues/21208). A análise é estática e limitada, e não comprova resultados em runtime.

Referências: [tarefas e posição do cursor](https://zed.dev/docs/tasks), [CLI e navegação para linha/coluna](https://zed.dev/docs/reference/cli).

Esta implementação não foi executada no navegador ou no Zed, e nenhum teste foi executado.
