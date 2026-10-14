#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { version } = require('./package.json');

function installZed() {
  const ts = require('./vendor/typescript');
  const directory = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Zed')
    : path.join(process.platform === 'linux' && process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'zed');
  const configuredFile = path.join(directory, 'tasks.json');
  const existed = fs.existsSync(configuredFile);
  const file = existed ? fs.realpathSync(configuredFile) : configuredFile;
  const original = existed ? fs.readFileSync(file, 'utf8') : '[\n]\n';
  const parse = text => {
    const source = ts.parseJsonText(file, text), errors = [...source.parseDiagnostics];
    const tasks = ts.convertToObject(source, errors), array = source.statements[0]?.expression;
    assert(errors.length === 0, `${file}: JSONC inválido; arquivo preservado.`);
    assert(Array.isArray(tasks) && array && ts.isArrayLiteralExpression(array), `${file} precisa conter um array de tarefas.`);
    assert(tasks.every(task => task && typeof task === 'object' && !Array.isArray(task)), `${file}: tarefa inválida.`);
    return { tasks, array, source };
  };
  const { tasks, array, source } = parse(original);
  const installDir = path.join(os.homedir(), '.code-flow-lens', version);
  const templates = require('./zed/tasks.example.json').map(task => ({
    ...task, command: process.execPath,
    args: [path.join(installDir, 'zed', 'viewer.cjs'), ...task.args.slice(1)]
  }));
  const labels = new Set(templates.map(task => task.label));
  const edits = [], missing = [];
  const format = task => JSON.stringify(task, null, 2).replace(/\n/g, '\n  ');
  for (const task of templates) {
    assert(tasks.filter(item => item.label === task.label).length <= 1, `Há tarefas duplicadas chamadas ${task.label}; arquivo preservado.`);
    const index = tasks.findIndex(item => item.label === task.label);
    if (index < 0) { missing.push(task); continue; }
    const element = array.elements[index];
    const replacement = format({ ...tasks[index], ...task });
    if (original.slice(element.getStart(source), element.end) !== replacement)
      edits.push({ start: element.getStart(source), end: element.end, text: replacement });
  }
  if (missing.length) {
    if (array.elements.length && !array.elements.hasTrailingComma) {
      const end = array.elements[array.elements.length - 1].end;
      edits.push({ start: end, end, text: ',' });
    }
    edits.push({ start: array.end - 1, end: array.end - 1, text: '\n  ' + missing.map(format).join(',\n  ') + '\n' });
  }
  let updated = original;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  const merged = parse(updated).tasks;
  assert.deepEqual(merged.filter(task => !labels.has(task.label)), tasks.filter(task => !labels.has(task.label)));
  for (const task of templates) assert(merged.filter(item => item.label === task.label).length === 1);

  const folders = ['lib', 'vendor', 'java', 'mcp', 'media', 'zed'];
  for (const entry of ['zed/viewer.cjs', 'mcp/analysis.cjs', 'mcp/node_modules/@modelcontextprotocol/server/package.json', 'mcp/node_modules/@modelcontextprotocol/core/package.json', 'mcp/node_modules/zod/package.json'])
    assert(fs.existsSync(path.join(__dirname, entry)), `Pacote incompleto: ${entry}`);
  if (path.resolve(__dirname) !== path.resolve(installDir)) {
    fs.mkdirSync(installDir, { recursive: true });
    for (const entry of [...folders, 'package.json', 'LICENSE', 'install.cjs'])
      fs.cpSync(path.join(__dirname, entry), path.join(installDir, entry), {
        recursive: true, filter: sourcePath => !['.bin', '__pycache__'].includes(path.basename(sourcePath))
      });
    fs.mkdirSync(path.join(installDir, 'docs'), { recursive: true });
    for (const doc of ['MCP.md', 'ZED.md']) fs.copyFileSync(path.join(__dirname, 'docs', doc), path.join(installDir, 'docs', doc));
  }
  if (updated !== original) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.cfl-' + crypto.randomUUID() + '.tmp';
    const backup = file + '.cfl-' + crypto.randomUUID() + '.bak';
    fs.writeFileSync(temporary, updated, { flag: 'wx', mode: existed ? fs.statSync(file).mode & 0o777 : 0o600 });
    try {
      assert(existed ? fs.readFileSync(file, 'utf8') === original : !fs.existsSync(file), 'As tarefas mudaram durante a instalação; execute novamente.');
      if (existed) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    if (existed) console.log(`Backup das tarefas: ${backup}`);
  }
  console.log(`Code Flow Lens ${version} instalado para o Zed.\nTarefas: ${configuredFile}\nArquivos: ${installDir}\nNo Zed: task: spawn → Code Flow Lens: Value Flow / Code Flow.`);
}

function installVSCode(command) {
  assert(['code', 'code-insiders', 'codium'].includes(command), 'Use --code-command code, code-insiders ou codium.');
  const name = `code-flow-lens-${version}.vsix`;
  const vsix = [path.join(__dirname, 'vsix', name), path.join(__dirname, 'artifacts', name)].find(file => fs.existsSync(file));
  assert(vsix, `VSIX ausente: ${name}. Use o pacote distribuído ou execute scripts/package.py --output artifacts.`);
  // shortcut: a CLI .cmd no Windows exige instalação manual do VSIX; ampliar ao oferecer um instalador Windows.
  const result = spawnSync(command, ['--install-extension', vsix, '--force'], { stdio: 'inherit' });
  if (result.error) throw new Error(`Não foi possível executar ${command}: ${result.error.message}. Instale a CLI ou use Extensions → Install from VSIX: ${vsix}`);
  assert(result.status === 0, `A instalação pelo ${command} falhou (status ${result.status}).`);
  console.log(`Code Flow Lens ${version} instalado pelo ${command}. Recarregue a janela do editor.`);
}

try {
  const { values, positionals } = parseArgs({ options: { help: { type: 'boolean' }, 'code-command': { type: 'string', default: 'code' } }, allowPositionals: true });
  if (values.help || !positionals.length) {
    console.log('Uso: node install.cjs zed\n     node install.cjs vscode [--code-command code|code-insiders|codium]\nRequer Node.js 20+. Zed: instala arquivos e mescla tarefas globais. VS Code: instala o VSIX.');
  } else {
    assert(Number(process.versions.node.split('.')[0]) >= 20, 'Use Node.js 20 ou superior.');
    assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), 'Versão do pacote inválida.');
    assert(positionals.length === 1 && ['zed', 'vscode'].includes(positionals[0]), 'Escolha zed ou vscode.');
    if (positionals[0] === 'zed') installZed(); else installVSCode(values['code-command']);
  }
} catch (error) { console.error(`Code Flow Lens: ${error.message}`); process.exitCode = 1; }
