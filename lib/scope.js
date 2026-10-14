'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail } = require('./util');

const blockedSegments = new Set(['.git', '.hg', '.svn', 'node_modules', '.next', '.nuxt', 'dist', 'build', 'coverage']);
function blockedFile(file) {
  const parts = file.replace(/\\/g, '/').split('/');
  const basename = parts.at(-1).toLowerCase();
  return parts.some(part => blockedSegments.has(part)) || /^\.env(?:\.|$)/i.test(basename) ||
    /\.(pem|key|p12|pfx|p8|keystore)$/i.test(basename) ||
    ['.npmrc', '.netrc', '.pypirc', 'id_rsa', 'id_ed25519', 'id_ecdsa'].includes(basename);
}
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
class WorkspaceScope {
  constructor(roots) { this.roots = roots; this.realPaths = new Map(); }
  invalidate() { this.realPaths.clear(); }
  async realPath(file) {
    if (!this.realPaths.has(file)) {
      const p = fs.realpath(file).catch(error => { this.realPaths.delete(file); throw error; });
      this.realPaths.set(file, p);
      if (this.realPaths.size > 4000) this.realPaths.delete(this.realPaths.keys().next().value);
    }
    return this.realPaths.get(file);
  }
  async assert(file) {
    if (!path.isAbsolute(file)) fail('OUTSIDE_WORKSPACE', 'An absolute filesystem path is required internally.');
    const lexical = this.roots.find(root => inside(root.path, file));
    if (!lexical) fail('OUTSIDE_WORKSPACE', 'Only source files in the open workspace are accessible.');
    if (blockedFile(path.relative(lexical.path, file))) fail('EXCLUDED_FILE', 'This path is excluded (dependency, build output or common secret file).');
    let real, rootReal;
    try { [real, rootReal] = await Promise.all([this.realPath(file), this.realPath(lexical.path)]); }
    catch { fail('FILE_NOT_FOUND', 'The file is not available in this workspace.'); }
    if (!inside(rootReal, real)) fail('OUTSIDE_WORKSPACE', 'Symlinks escaping the workspace are not accessible.');
    if (blockedFile(path.relative(rootReal, real))) fail('EXCLUDED_FILE', 'The symlink target is excluded.');
    return lexical;
  }
  async allowed(file) { try { await this.assert(file); return true; } catch { return false; } }
  resolve(file, workspace) {
    if (typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0')) fail('INVALID_ARGUMENT', 'Provide a valid source file path.');
    if (path.isAbsolute(file)) return path.normalize(file);
    let roots = this.roots;
    if (workspace) roots = roots.filter(root => root.name === workspace || root.path === workspace);
    if (roots.length !== 1) fail('AMBIGUOUS_WORKSPACE', 'Use an absolute path or choose a workspace folder by name.', { workspaces: this.roots.map(root => root.name) });
    return path.resolve(roots[0].path, file);
  }
}
module.exports = { WorkspaceScope, blockedFile, inside };
