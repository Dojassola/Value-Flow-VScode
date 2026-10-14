# Runtime Observer

Ferramenta opcional da extensão para observar uma aplicação real em Chrome/Chromium.

## Abrir

Use **Code Flow Lens: Open Runtime Observer** ou o botão **Runtime** no grafo.

Informe a URL local da aplicação. `localhost` e loopback são permitidos por padrão. Origens adicionais precisam ser configuradas explicitamente em `codeFlowLens.runtimeOrigins`.

## Capturas

Antes de iniciar, escolha o que pode ser coletado:

- **State**: props/estado React best-effort;
- **Bodies**: corpos JSON limitados de respostas;
- **Text**: texto de DOM/console/erros;
- **Visual**: screenshots.

Sem essas opções, o observador mantém apenas metadados mínimos.

## Fluxo de uso

1. Start observation.
2. Reproduza o comportamento manualmente na janela aberta.
3. Tire um snapshot antes/depois.
4. Use Compare last two.
5. Consulte Events ou Screenshot quando necessário.
6. Use Show observed flow para abrir uma timeline no grafo principal.
7. Stop ao terminar.

A timeline indica ordem observada. Ela não afirma que um evento causou outro e não é execução reversa.

## React

A leitura automática de componentes React usa estruturas internas do runtime e é best-effort. Para efeitos nomeados e estados específicos existe `runtime/react-probe.mjs`, que pode ser usado voluntariamente em ambiente de desenvolvimento.
