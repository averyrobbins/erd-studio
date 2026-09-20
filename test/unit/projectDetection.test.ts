import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProjectProvider, isSqlmeshProject, resolveProjectRoot } from '../../src/services/projectDetection';

describe('resolveProjectRoot', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-project-root-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeDbtProject(rel: string): string {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dbt_project.yml'), 'name: x\n');
    return dir;
  }

  function makeSqlmeshProject(rel: string): string {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'gateways:\n  local:\n    connection:\n      type: duckdb\nmodel_defaults:\n  dialect: duckdb\n');
    return dir;
  }

  it('returns undefined when no folders are given', () => {
    expect(resolveProjectRoot([], '')).toBeUndefined();
  });

  it('returns undefined when nothing holds a supported project', () => {
    fs.mkdirSync(path.join(root, 'src'));
    expect(resolveProjectRoot([root], '')).toBeUndefined();
  });

  it('returns the workspace folder itself when it holds dbt_project.yml', () => {
    makeDbtProject('.');
    expect(resolveProjectRoot([root], '')).toBe(root);
  });

  it('returns the workspace folder itself when it holds a native SQLMesh config', () => {
    makeSqlmeshProject('.');
    expect(resolveProjectRoot([root], '')).toBe(root);
  });

  it('honours a relative erdStudio.projectPath before auto-detection', () => {
    makeDbtProject('.');
    const nested = makeDbtProject('analytics');
    expect(resolveProjectRoot([root], 'analytics')).toBe(nested);
  });

  it('honours an absolute erdStudio.projectPath', () => {
    const nested = makeDbtProject('deep/analytics');
    expect(resolveProjectRoot([root], nested)).toBe(nested);
  });

  it('falls back to auto-detection when projectPath holds no project', () => {
    makeDbtProject('.');
    expect(resolveProjectRoot([root], 'missing')).toBe(root);
  });

  it('finds a nested project one level down (monorepo)', () => {
    const nested = makeDbtProject('analytics');
    fs.mkdirSync(path.join(root, 'app'));
    expect(resolveProjectRoot([root], '')).toBe(nested);
  });

  it('returns the shallowest match when several nested projects exist', () => {
    makeDbtProject('a/b/deep_project');
    const shallow = makeDbtProject('zzz_shallow');
    expect(resolveProjectRoot([root], '')).toBe(shallow);
  });

  it('visits siblings in name order so the answer is deterministic', () => {
    makeSqlmeshProject('beta');
    const alpha = makeDbtProject('alpha');
    expect(resolveProjectRoot([root], '')).toBe(alpha);
  });

  it('skips node_modules, dbt_packages, target, dist, venv and every hidden directory', () => {
    for (const skip of ['node_modules', 'dbt_packages', 'dbt_modules', 'target', 'dist', 'venv', 'site-packages', '.git', '.venv', '.cache']) {
      makeDbtProject(path.join(skip, 'pkg'));
      makeSqlmeshProject(path.join(skip, 'mesh'));
    }
    expect(resolveProjectRoot([root], '')).toBeUndefined();

    const real = makeDbtProject('real');
    expect(resolveProjectRoot([root], '')).toBe(real);
  });

  it('does not search deeper than three levels below a workspace folder', () => {
    makeDbtProject('l1/l2/l3/l4/project');
    expect(resolveProjectRoot([root], '')).toBeUndefined();
    const d3 = makeDbtProject('x1/x2/project3');
    expect(resolveProjectRoot([root], '')).toBe(d3);
  });

  it('checks every workspace folder in a multi-root workspace', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-project-other-'));
    try {
      const nested = makeDbtProject('analytics');
      expect(resolveProjectRoot([other, root], '')).toBe(nested);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('respects an explicit provider preference during the search', () => {
    makeDbtProject('dbt_side');
    const mesh = makeSqlmeshProject('mesh_side');
    expect(resolveProjectRoot([root], '', 'sqlmesh')).toBe(mesh);
    expect(resolveProjectRoot([root], '', 'dbt')).toBe(path.join(root, 'dbt_side'));
  });
});

describe('isSqlmeshProject / detectProjectProvider', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-detect-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not mistake an unrelated config.yaml or config.py for SQLMesh', () => {
    fs.writeFileSync(path.join(root, 'config.yaml'), 'server:\n  port: 8080\n');
    fs.writeFileSync(path.join(root, 'config.py'), 'DEBUG = True\n');
    expect(isSqlmeshProject(root)).toBe(false);
    expect(detectProjectProvider(root)).toBeUndefined();
  });

  it('recognises a SQLMesh config.py by its import without executing it', () => {
    fs.writeFileSync(path.join(root, 'config.py'), 'from sqlmesh.core.config import Config\nraise RuntimeError("never run")\n');
    expect(detectProjectProvider(root)).toBe('sqlmesh');
  });

  it('recognises a saved export in a custom semantic directory', () => {
    fs.mkdirSync(path.join(root, 'docs/erd'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/erd/sqlmesh.json'), '{}');
    expect(detectProjectProvider(root, 'auto', 'docs/erd')).toBe('sqlmesh');
    expect(detectProjectProvider(root)).toBeUndefined();
  });
});
