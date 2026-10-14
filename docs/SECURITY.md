# Segurança

Code Flow Lens 0.11.1 funciona dentro do VS Code e não instala serviços globais, MCPs, agents ou configurações de ferramentas externas.

## Motor estático local

O modo padrão usa um Worker da própria extensão para TypeScript/JavaScript/React e um índice leve para Java. O motor lê arquivos do workspace local e overlays de documentos abertos. Ele não executa scripts de `package.json`, plugins de TypeScript, tarefas de build ou instalação de dependências.

Timeout ou cancelamento de uma consulta ativa encerram o Worker local, evitando que uma análise abandonada continue ocupando a fila.

## Value Flow e correlação

Value Flow e Multi-Symbol Correlation são análises estáticas. Eles leem AST, símbolos e referências; não executam módulos do projeto.

Os grafos podem conter código-fonte, caminhos e expressões. Trate exportações JSON como material potencialmente sensível.

## Static Simulation

`Simulate Selected Value` é um interpretador limitado do AST, não `eval`.

Ele:

- não importa o módulo selecionado;
- não chama funções externas não resolvidas;
- não executa browser APIs ou framework runtime;
- limita passos, profundidade de chamadas e iterações de loops;
- representa comportamento fora do subconjunto conhecido como `<unknown>`.

O valor informado pelo usuário permanece dentro da extensão/worker durante a simulação, salvo se o usuário exportar/copiar o grafo.

## React preview

A prévia React é diferente da simulação: o componente selecionado realmente roda no navegador da prévia. Por isso exige workspace confiável. O modo isolado aplica CSP para bloquear conexões de rede; aplicações com ambiente completo podem exigir a opção de página local existente.

## Runtime Observer

O Runtime Observer abre Chrome/Chromium com perfil temporário separado e pode causar efeitos reais simplesmente ao carregar a aplicação.

Capturas de estado, texto, corpos JSON e imagens começam desabilitadas e exigem autorização explícita. Redação de campos sensíveis é best-effort, não garantia de anonimização.

## Código-fonte

Cards, clipboard e exports podem conter trechos de código e caminhos locais. Revise antes de compartilhar.
