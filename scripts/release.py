"""Build locally; publish to GitHub only with --publish. No workflows or tests."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'artifacts'

def run(*command, capture=False):
    return subprocess.run(command, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout

def github(endpoint, missing=False, *fields):
    result = subprocess.run(['gh', 'api', endpoint, *fields], cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        if missing and 'HTTP 404' in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip() or 'GitHub request failed.')
    return json.loads(result.stdout)

def repository(url):
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([\w.-]+/[\w.-]+)', url)
    if not match:
        raise RuntimeError('Use an origin on github.com, without credentials in its URL.')
    return match[1].removesuffix('.git')

def find_release(repo, tag):
    release = github('repos/'+repo+'/releases/tags/'+tag, missing=True)
    if release:
        return release
    page = 1
    while True:
        releases = github(f'repos/{repo}/releases?per_page=100&page={page}')
        for release in releases:
            if release['tag_name'] == tag:
                return release
        if len(releases) < 100:
            return None
        page += 1

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish', action='store_true', help='Build, upload and publish this version explicitly.')
    args = parser.parse_args()
    if run('git', 'status', '--porcelain', capture=True).strip():
        raise RuntimeError('Commit public changes before generating a release; keep private notes in .local/.')
    commit = run('git', 'rev-parse', 'HEAD', capture=True).strip()
    package = json.loads((ROOT/'package.json').read_text())
    version = package['version']
    assert re.fullmatch(r'\d+\.\d+\.\d+(?:-[\w.-]+)?', version), 'Invalid package version.'
    mcp = json.loads((ROOT/'mcp/package.json').read_text())
    lock = json.loads((ROOT/'mcp/package-lock.json').read_text())
    assert version == mcp['version'] == lock['version'] == lock['packages']['']['version'], 'Keep VS Code/MCP/lock versions synchronized.'
    section = re.search(r'^## '+re.escape(version)+r'\b[^\n]*\n(.*?)(?=^## |\Z)', (ROOT/'CHANGELOG.md').read_text(), re.M | re.S)
    assert section and section[1].strip(), 'Add release notes for this version to CHANGELOG.md.'
    tag = 'v'+version
    repo = repository(package['repository']['url'])
    existing = None
    if args.publish:
        assert repository(run('git', 'remote', 'get-url', 'origin', capture=True).strip()).lower() == repo.lower(), 'origin differs from package.json repository.'
        branch = run('git', 'branch', '--show-current', capture=True).strip()
        assert branch, 'Publish from a branch, not a detached HEAD.'
        refs = run('git', 'ls-remote', 'origin', 'refs/heads/'+branch, 'refs/tags/'+tag, 'refs/tags/'+tag+'^{}', capture=True)
        remote = {line.split()[1]:line.split()[0] for line in refs.splitlines()}
        assert remote.get('refs/heads/'+branch) == commit, 'Push this commit to origin before publishing.'
        tagged = remote.get('refs/tags/'+tag+'^{}', remote.get('refs/tags/'+tag))
        assert tagged is None or tagged == commit, 'This tag already identifies another commit; use a new version.'
        existing = find_release(repo, tag)
        if existing:
            assert existing['draft'], 'This version is already published; use a new version.'
            assert existing['target_commitish'] == commit or tagged == commit, 'The draft identifies another commit.'

    run('npm', 'ci', '--prefix', 'mcp', '--ignore-scripts', '--no-audit', '--no-fund')
    run(sys.executable, str(ROOT/'scripts/package.py'), '--output', str(OUT))
    artifacts = [OUT/f'code-flow-lens-{version}.vsix', OUT/f'code-flow-lens-portable-{version}.zip', OUT/f'code-flow-lens-{version}-source.zip']
    hashes = {file.name:hashlib.sha256(file.read_bytes()).hexdigest() for file in artifacts}
    checksums = OUT/f'code-flow-lens-{version}-SHA256SUMS.txt'
    checksums.write_text(''.join(f'{digest}  {name}\n' for name,digest in hashes.items()), encoding='utf8')
    notes = OUT/f'code-flow-lens-{version}-release-notes.md'
    notes.write_text(f'''Code Flow Lens {version} — commit `{commit}`.

| Download | Conteúdo |
| --- | --- |
| `code-flow-lens-{version}.vsix` | Extensão visual para VS Code/VSCodium. |
| `code-flow-lens-portable-{version}.zip` | Visualizador para Zed, servidor MCP, instalador, dependências e VSIX. |
| `code-flow-lens-{version}-source.zip` | Fontes públicos, sem dependências instaladas, planos ou dados locais. |
| `code-flow-lens-{version}-SHA256SUMS.txt` | Checksums SHA-256 dos três arquivos. |

No pacote portátil, use Node.js 20+ e execute `node install.cjs zed` ou `node install.cjs vscode`.
O MCP pode conectar Codex, Antigravity e outros agentes ao grafo web, ou analisar um workspace sem UI.
Documentação: [README](https://github.com/{repo}/blob/{tag}/README.md), [MCP](https://github.com/{repo}/blob/{tag}/docs/MCP.md), [Zed](https://github.com/{repo}/blob/{tag}/docs/ZED.md).

## Alterações

{section[1].strip()}

As análises são estáticas e limitadas. Este gerador confere a integridade dos pacotes; não executa testes nem validação visual.
''', encoding='utf8')
    assert run('git', 'rev-parse', 'HEAD', capture=True).strip() == commit, 'HEAD changed during the build.'
    assert not run('git', 'status', '--porcelain', capture=True).strip(), 'Public sources changed during the build.'
    print(f'Generated {tag} in {OUT}.', flush=True)
    if not args.publish:
        print('Nothing uploaded. Publish explicitly with npm run release:publish.')
        return

    if not existing:
        existing = github('repos/'+repo+'/releases', False, '--method', 'POST',
                          '--field', 'tag_name='+tag, '--field', 'target_commitish='+commit,
                          '--field', 'name=Code Flow Lens '+version, '--field', 'body=@'+str(notes),
                          '--field', 'draft=true', '--field', 'prerelease='+str('-' in version).lower())
    assert existing['draft'], 'Only unpublished drafts may receive or replace assets.'
    files = [*artifacts, checksums]
    run('gh', 'release', 'upload', tag, *[str(file) for file in files], '--repo', 'github.com/'+repo, '--clobber')
    uploaded = github('repos/'+repo+'/releases/'+str(existing['id']))
    assets = {asset['name']:asset for asset in uploaded['assets']}
    for file in files:
        asset = assets.get(file.name)
        assert asset and asset['state'] == 'uploaded' and asset['size'] == file.stat().st_size, 'Incomplete upload: '+file.name
        if asset.get('digest'):
            assert asset['digest'] == 'sha256:'+hashlib.sha256(file.read_bytes()).hexdigest(), 'Upload digest mismatch: '+file.name
    published = github('repos/'+repo+'/releases/'+str(existing['id']), False, '--method', 'PATCH', '--field', 'draft=false')
    assert not published['draft'], 'GitHub did not confirm publication.'
    print(published['html_url'])

if __name__ == '__main__':
    try:
        main()
    except (AssertionError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print('Release failed: '+str(error), file=sys.stderr)
        sys.exit(1)
