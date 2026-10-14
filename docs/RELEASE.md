# Releases locais e manuais

VS Code, Zed e MCP compartilham uma versão do Code Flow Lens:

| Entrega | Arquivo | Requisitos |
| --- | --- | --- |
| VS Code / VSCodium | `code-flow-lens-VERSAO.vsix` | Editor compatível com o manifest. |
| Zed + MCP + instalador | `code-flow-lens-portable-VERSAO.zip` | Node.js 20+. Zed abre o grafo em um navegador local; o MCP serve qualquer agente compatível. O ZIP também contém o VSIX. |
| Fontes | `code-flow-lens-VERSAO-source.zip` | Git para manutenção/releases; dependências MCP são instaladas pelo gerador. |

Não há workflow, gatilho por commit ou publicação automática. O computador gera os arquivos e a CLI do GitHub os envia somente quando você executa o comando de publicação.

## Preparar uma versão

Use um clone Git, Node.js 20+, npm, Python 3.9+ e GitHub CLI autenticado com acesso de escrita ao repositório (`gh auth login`). Java não é necessário para empacotar.

1. Atualize `version` em `package.json`, `mcp/package.json` e os dois campos de versão do projeto em `mcp/package-lock.json`.
2. Adicione uma seção `## VERSAO` ao `CHANGELOG.md` e ajuste os exemplos de instalação se a versão mudou.
3. Faça commit dos arquivos públicos e `git push`. Planos, registros e relatórios locais ficam em `.local/`.

Para apenas gerar os arquivos:

```sh
npm run release
```

Para gerar e publicar explicitamente:

```sh
npm run release:publish
```

O gerador instala as dependências MCP pelo lockfile com scripts desabilitados, empacota os três arquivos, escreve SHA256SUMS e extrai as notas do changelog. Ele exige fontes sem alterações pendentes, versões sincronizadas e, na publicação, o mesmo commit já enviado ao `origin` informado em `package.json`.

A publicação cria a tag `vVERSAO` no commit exato da versão. Os arquivos são enviados para um rascunho; a release fica pública após a confirmação dos uploads. Falhas deixam o rascunho para repetir o mesmo comando. Uma release já publicada é recusada, e tags de outros commits são preservadas: nesse caso, use uma nova versão.

## Privacidade e integridade

O Git ignora `.local/`, configurações de agentes, `.env`, credenciais, chaves, dependências instaladas e artefatos. A distribuição dos fontes usa apenas arquivos rastreados, e o empacotador recusa caminhos privados. Isso não substitui revisar o conteúdo antes do commit: nunca coloque credenciais reais nos fontes ou exemplos.

Para conferir os downloads, coloque os três pacotes e SHA256SUMS na mesma pasta e execute `sha256sum -c code-flow-lens-VERSAO-SHA256SUMS.txt`. Os arquivos em `artifacts/` são locais e não entram nos commits.

O gerador não executa testes. A integridade dos ZIPs/VSIX e os uploads são conferidos; o funcionamento dos editores e das análises exige validação própria quando solicitada.

Referências: [releases pela GitHub CLI](https://cli.github.com/manual/gh_release_create) e [API de releases](https://docs.github.com/en/rest/releases/releases).
