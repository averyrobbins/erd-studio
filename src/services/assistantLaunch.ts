/**
 * Helpers for launching an assistant CLI directly (no shell) for a native
 * SQLMesh source-edit plan. Pure: no vscode import, unit-tested.
 *
 * The dbt sync flow types `source .venv/bin/activate && claude` into a shell,
 * which both activates the project's Python environment and lets the shell
 * resolve `claude`. The native flow launches the executable itself, so it has
 * to do both jobs by hand: find the executable on PATH (VS Code does not
 * resolve a bare `shellPath` on every platform, and `claude` is `claude.cmd`
 * on Windows), and put the project's Python environment first on the PATH the
 * assistant inherits, so the `sqlmesh` it runs to validate is the project's.
 */
import * as fs from 'fs';
import * as path from 'path';

const VENV_CANDIDATES = ['.venv', 'venv', 'env'];

/**
 * Absolute path of `name` on `searchPath`, honouring PATHEXT on Windows, or
 * `undefined` when it is not there. An absolute `name` is returned as given
 * when it exists.
 */
export function resolveExecutable(
  name: string,
  searchPath: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT,
): string | undefined {
  const isFile = (file: string): boolean => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  };
  const extensions = platform === 'win32'
    ? ['', ...(pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())]
    : [''];
  if (path.isAbsolute(name)) {
    return extensions.map(ext => name + ext).find(isFile);
  }
  for (const dir of (searchPath ?? '').split(path.delimiter).filter(Boolean)) {
    const found = extensions.map(ext => path.join(dir, name + ext)).find(isFile);
    if (found) return found;
  }
  return undefined;
}

/**
 * The `bin` (or `Scripts`) directory of the project's Python environment, if
 * one of the conventional virtualenv folders exists, else `undefined`.
 */
export function findVenvBinDir(workspaceRoot: string, platform: NodeJS.Platform = process.platform): string | undefined {
  for (const dir of VENV_CANDIDATES) {
    const bin = path.join(workspaceRoot, dir, platform === 'win32' ? 'Scripts' : 'bin');
    try { if (fs.statSync(bin).isDirectory()) return bin; } catch { /* next candidate */ }
  }
  return undefined;
}

/**
 * Use one selected Python environment. Mixing a configured interpreter with a
 * different project's virtualenv can run validation with the wrong SQLMesh.
 * VS Code removes inherited variables whose override is null.
 */
export function assistantEnvironment(options: {
  workspaceRoot: string; pythonPath?: string; basePath?: string; platform?: NodeJS.Platform;
}): { PATH?: string; VIRTUAL_ENV?: string | null; PYTHONHOME?: null } {
  const platform = options.platform ?? process.platform;
  const base = options.basePath ?? process.env.PATH ?? '';
  const requested = options.pythonPath?.trim();
  const configured = requested && (path.isAbsolute(requested) ? requested
    : /[/\\]/.test(requested) ? path.resolve(options.workspaceRoot, requested)
    : resolveExecutable(requested, base, platform));
  if (requested && !configured) throw new Error(`Configured SQLMesh Python ${requested} was not found on PATH.`);
  const bin = configured ? path.dirname(configured) : findVenvBinDir(options.workspaceRoot, platform);
  if (!bin) return {};
  const root = path.dirname(bin);
  const virtualEnv = fs.existsSync(path.join(root, 'pyvenv.cfg')) ? root : null;
  return { PATH: [bin, base].filter(Boolean).join(path.delimiter), VIRTUAL_ENV: virtualEnv, PYTHONHOME: null };
}
