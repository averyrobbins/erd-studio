import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import type { ProjectProvider } from '../types/project';

export function isSqlmeshProject(root: string, semanticDir = '.erd-studio'): boolean {
  if (fs.existsSync(path.join(root, semanticDir, 'sqlmesh.json'))) return true;
  for (const filename of ['config.yaml', 'config.yml', 'config.py']) {
    try {
      const text = fs.readFileSync(path.join(root, filename), 'utf8');
      if (filename.endsWith('.py')) {
        if (/\b(?:from|import)\s+sqlmesh\b/.test(text)) return true;
      } else {
        const config = parse(text);
        if (config && typeof config === 'object' && !Array.isArray(config)
          && ('gateways' in config || 'model_defaults' in config || 'default_gateway' in config)) return true;
      }
    } catch { /* Detection never executes Python and tolerates mid-edit files. */ }
  }
  return false;
}

export function detectProjectProvider(root: string, preferred = 'auto', semanticDir = '.erd-studio'): ProjectProvider | undefined {
  if (preferred === 'sqlmesh') return isSqlmeshProject(root, semanticDir) ? 'sqlmesh' : undefined;
  if (preferred === 'dbt') return fs.existsSync(path.join(root, 'dbt_project.yml')) ? 'dbt' : undefined;
  // A SQLMesh dbt project retains dbt source conventions. Preserve its existing integration.
  if (fs.existsSync(path.join(root, 'dbt_project.yml'))) return 'dbt';
  return isSqlmeshProject(root, semanticDir) ? 'sqlmesh' : undefined;
}

export function resolveProjectRoot(folders: readonly string[], configured: string, preferred = 'auto', semanticDir = '.erd-studio'): string | undefined {
  const matches = (root: string) => !!detectProjectProvider(root, preferred, semanticDir);
  if (configured.trim()) {
    const candidates = path.isAbsolute(configured) ? [configured] : folders.map(f => path.resolve(f, configured));
    const found = candidates.find(matches);
    if (found) return found;
  }
  let frontier = [...folders];
  const skip = new Set(['node_modules', 'dbt_packages', 'dbt_modules', 'target', 'dist']);
  for (let depth = 0; depth <= 5 && frontier.length; depth++) {
    const found = frontier.find(matches);
    if (found) return found;
    frontier = frontier.flatMap(dir => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name))
          .map(e => path.join(dir, e.name));
      } catch { return []; }
    });
  }
  return undefined;
}
