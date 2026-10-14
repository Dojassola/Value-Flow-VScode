"""Build an unsigned local VSIX and source ZIP with Python's standard library.
No npm downloads are required. The publisher/id match the existing 0.1.x builds.
"""
import argparse
import json
from pathlib import Path
import subprocess
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', default=str(ROOT/'artifacts'))
args = parser.parse_args()
OUT = Path(args.output).resolve()
OUT.mkdir(parents=True, exist_ok=True)
pkg = json.loads((ROOT/'package.json').read_text())
version = pkg['version']
try:
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
except subprocess.CalledProcessError:
    raise SystemExit('Build from a Git checkout with the public source files tracked.')
private_dirs = {'.local','.serena','.codex','.gemini','.aws','.ssh','plans','implementation-plans','node_modules','artifacts','test-artifacts','__pycache__'}
private_suffixes = {'.pem','.key','.p12','.pfx','.log','.tmp','.bak','.pyc','.class','.zip','.vsix'}
def public_file(file, dependencies=False):
    relative = file.relative_to(ROOT)
    excluded = private_dirs - {'node_modules'} if dependencies else private_dirs
    return (not any(part in excluded for part in relative.parts)
            and file.name not in {'.npmrc','.netrc','TEST_REPORT.md','.package-lock.json'}
            and (not file.name.startswith('.env') or file.name == '.env.example')
            and not file.name.startswith(('credentials','secrets'))
            and file.suffix not in private_suffixes and not file.is_symlink())
source_files = sorted(ROOT/name for name in tracked if name)
if not source_files or any(not public_file(file) for file in source_files):
    raise SystemExit('Track only public sources; local plans, reports and sensitive files must remain ignored.')
for dependency in ['@modelcontextprotocol/server','@modelcontextprotocol/core','zod']:
    if not (ROOT/'mcp/node_modules'/dependency/'package.json').is_file():
        raise SystemExit('Install MCP dependencies first: npm ci --prefix mcp --ignore-scripts --no-audit --no-fund')
ns = 'http://schemas.microsoft.com/developer/vsx-schema/2011'
ET.register_namespace('', ns)
def element(parent, tag, attrib=None, text=None):
    node = ET.SubElement(parent, '{'+ns+'}'+tag, attrib or {})
    if text is not None:
        node.text = text
    return node
manifest = ET.Element('{'+ns+'}PackageManifest', {'Version':'2.0.0'})
metadata = element(manifest, 'Metadata')
element(metadata, 'Identity', {'Language':'en-US','Id':pkg['name'],'Version':version,'Publisher':pkg['publisher']})
element(metadata, 'DisplayName', text=pkg['displayName'])
element(metadata, 'Description', {'{http://www.w3.org/XML/1998/namespace}space':'preserve'}, pkg['description'])
element(metadata, 'Tags', text=','.join(pkg.get('keywords',[])))
element(metadata, 'Categories', text=','.join(pkg.get('categories',[])))
element(metadata, 'GalleryFlags', text='Public')
properties = element(metadata, 'Properties')
for key,value in {
    'Microsoft.VisualStudio.Code.Engine':pkg['engines']['vscode'],
    'Microsoft.VisualStudio.Code.ExtensionKind':'workspace',
    'Microsoft.VisualStudio.Code.ExecutesCode':'true',
    'Microsoft.VisualStudio.Code.EnabledApiProposals':'',
    'Microsoft.VisualStudio.Code.ExtensionDependencies':'',
    'Microsoft.VisualStudio.Code.ExtensionPack':''
}.items():
    element(properties, 'Property', {'Id':key,'Value':value})
installation = element(manifest, 'Installation')
element(installation, 'InstallationTarget', {'Id':'Microsoft.VisualStudio.Code'})
element(manifest, 'Dependencies')
assets = element(manifest, 'Assets')
for kind,file in [('Microsoft.VisualStudio.Code.Manifest','package.json'),('Microsoft.VisualStudio.Services.Content.Details','README.md'),('Microsoft.VisualStudio.Services.Content.Changelog','CHANGELOG.md'),('Microsoft.VisualStudio.Services.Content.License','LICENSE')]:
    element(assets, 'Asset', {'Type':kind,'Path':'extension/'+file,'Addressable':'true'})
manifest_bytes = ET.tostring(manifest, encoding='utf-8', xml_declaration=True)
ctns = 'http://schemas.openxmlformats.org/package/2006/content-types'
content_types = ET.Element('Types', {'xmlns':ctns})
for ext,kind in [('json','application/json'),('js','application/javascript'),('css','text/css'),('md','text/markdown'),('png','image/png'),('txt','text/plain'),('java','text/plain'),('py','text/x-python'),('sh','text/plain'),('bat','text/plain'),('cjs','application/javascript'),('mjs','application/javascript'),('ts','text/plain'),('typed','text/plain'),('vsixmanifest','text/xml')]:
    ET.SubElement(content_types, 'Default', {'Extension':ext,'ContentType':kind})
ET.SubElement(content_types, 'Override', {'PartName':'/extension/LICENSE','ContentType':'text/plain'})
content_bytes = ET.tostring(content_types, encoding='utf-8', xml_declaration=True)
files = [file for file in source_files if file.name in ['package.json','extension.js','README.md','CHANGELOG.md','LICENSE'] and file.parent == ROOT
         or file.relative_to(ROOT).parts[0] in ['lib','media','docs','vendor','java','runtime']]
vsix = OUT/f'code-flow-lens-{version}.vsix'
with zipfile.ZipFile(vsix, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('extension.vsixmanifest', manifest_bytes)
    z.writestr('[Content_Types].xml', content_bytes)
    for file in files:
        z.write(file, 'extension/'+file.relative_to(ROOT).as_posix())
mcp_package = OUT/f'code-flow-lens-portable-{version}.zip'
portable_root = f'code-flow-lens-portable-{version}/'
mcp_files = [file for file in source_files if file.relative_to(ROOT).as_posix() in ['package.json','LICENSE','install.cjs','README.md','CHANGELOG.md','docs/MCP.md','docs/ZED.md']
             or file.relative_to(ROOT).parts[0] in ['lib','vendor','java','mcp','media','zed']]
mcp_files += sorted(file for file in (ROOT/'mcp/node_modules').rglob('*') if file.is_file() and '.bin' not in file.parts and public_file(file, dependencies=True))
with zipfile.ZipFile(mcp_package, 'w', zipfile.ZIP_DEFLATED) as z:
    for file in mcp_files:
        z.write(file, portable_root+file.relative_to(ROOT).as_posix())
    z.write(vsix, portable_root+'vsix/'+vsix.name)
source = OUT/f'code-flow-lens-{version}-source.zip'
with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as z:
    for file in source_files:
        z.write(file, 'code-flow-lens-'+version+'/'+file.relative_to(ROOT).as_posix())
with zipfile.ZipFile(vsix) as z:
    assert z.testzip() is None
    assert json.loads(z.read('extension/package.json'))['version'] == version
    ET.fromstring(z.read('extension.vsixmanifest'))
    ET.fromstring(z.read('[Content_Types].xml'))
    for file in ['extension.js','lib/flow-engine.js','lib/vscode-adapter.js','lib/code-explorer.js','lib/webview-html.js','media/graph.js','media/graph.css','runtime/manager.js']:
        assert 'extension/'+file in z.namelist(), file
with zipfile.ZipFile(mcp_package) as z:
    assert z.testzip() is None
    names = z.namelist()
    for file in ['install.cjs','vsix/'+vsix.name,'mcp/server.mjs','mcp/analysis.cjs','mcp/viewer.cjs','mcp/codex.example.toml','mcp/antigravity.example.json','lib/value-context.js','mcp/node_modules/@modelcontextprotocol/server/package.json','mcp/node_modules/@modelcontextprotocol/core/package.json','mcp/node_modules/zod/package.json','zed/viewer.cjs','zed/browser.js','zed/tasks.example.json','zed/keymap.example.json','media/graph.js','media/graph.css','docs/ZED.md']:
        assert portable_root+file in names, file
for archive in [vsix,mcp_package,source]:
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        assert all(not any(part in private_dirs-{'node_modules'} for part in Path(name).parts) for name in z.namelist())
print(vsix)
print(mcp_package)
print(source)
print(f'VSIX validated: {len(files)} extension files; archive CRC and XML parse OK.')
