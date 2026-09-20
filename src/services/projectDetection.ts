import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import type { ProjectProvider } from '../types/project';

/**
 * Directories never descended into when searching for a nested project.
 * Hidden directories (`.git`, `.venv`, `.cache`, …) are skipped by name prefix.
 */
const PROJECT_SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dbt_packages', 'dbt_modules', 'target', 'dist', 'venv', 'site-packages',
]);

/**
 * Maximum directory depth (below a workspace folder) searched for a project.
 * Every candidate directory costs a few stats and, for a `config.yaml`, a YAML
 * parse — so the search stays shallow, as the dbt-only resolver always was.
 */
const PROJECT_SEARCH_MAX_DEPTH = 3;

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

/**
 * Resolve the project root from the workspace folder paths and the
 * `erdStudio.projectPath` / `erdStudio.provider` settings. Pure (no vscode
 * access) so it is unit-testable.
 *
 * Resolution order:
 *   1. `projectPath` setting — absolute, or relative to each workspace folder —
 *      when it holds a supported project.
 *   2. A workspace folder whose root holds a supported project.
 *   3. A depth-limited breadth-first search below each workspace folder
 *      (skipping hidden directories and {@link PROJECT_SEARCH_SKIP_DIRS}),
 *      returning the shallowest match; siblings are visited in name order so
 *      the answer is deterministic.
 */
export function resolveProjectRoot(folders: readonly string[], configured: string, preferred = 'auto', semanticDir = '.erd-studio'): string | undefined {
  const matches = (root: string) => !!detectProjectProvider(root, preferred, semanticDir);
  if (configured.trim()) {
    const candidates = path.isAbsolute(configured) ? [configured] : folders.map(f => path.resolve(f, configured));
    const found = candidates.find(matches);
    if (found) return found;
    console.warn(`ERD Studio: erdStudio.projectPath "${configured}" holds no supported project — falling back to auto-detection.`);
  }
  let frontier = [...folders];
  for (let depth = 0; depth <= PROJECT_SEARCH_MAX_DEPTH && frontier.length; depth++) {
    const found = frontier.find(matches);
    if (found) return found;
    if (depth === PROJECT_SEARCH_MAX_DEPTH) break;
    frontier = frontier.flatMap(dir => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && !PROJECT_SEARCH_SKIP_DIRS.has(e.name))
          .map(e => path.join(dir, e.name));
      } catch { return []; }
    });
  }
  return undefined;
}
