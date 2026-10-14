# Graph schema

Code Flow Lens usa um grafo JSON serializável para separar análise e renderização.

## Nós

Tipos principais:

- `symbol`: função, variável, classe, método ou componente semântico;
- `referenceFile`: grupo de referências do mesmo símbolo em um arquivo;
- `referenceOccurrence`: ocorrência individual quando materializada;
- `codeBlock`: bloco de controle/dados de uma função ou método;
- `component`: componente React na hierarquia JSX.

Nós podem conter `location`, `roles`, `code`, `reads`, `writes`, `calls`, `references` e metadados de expansão.

## Arestas

Relações semânticas incluem `defines`, `implements`, `calls`, `referenced_in`, `used_inside` e `renders`.

Grafos `code-flow` também usam arestas de controle (`next`, `true`, `false`, `loop`, `return`, `break`, `continue`) e `dataEdges` para dependências locais de valores.

Grafos `runtime-timeline` usam `follows_observed`. Essa aresta significa ordem temporal observada, não causalidade.

## Localizações

Linhas e colunas são 1-based. Colunas seguem a convenção UTF-16 usada pelo VS Code.

Objetos de providers do editor não são serializados para a webview. O renderer recebe apenas dados simples do grafo.

## Limites

`analysis.coverage` e `analysis.warnings` indicam cortes por orçamento, timeouts, provider indisponível e limitações do tipo de análise. Ausência de aresta não prova ausência de comportamento em runtime.
