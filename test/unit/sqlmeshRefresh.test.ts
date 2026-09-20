import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { refreshSqlmesh } from '../../src/services/sqlmeshRefresh';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd mesh refresh ')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('passes paths and SQLMesh options as literal arguments without a shell', async () => {
  const exporter = path.join(root, 'mock exporter.js');
  fs.writeFileSync(exporter, 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))');
  const gateway = 'local; $(exit 1)';
  const result = await refreshSqlmesh({ root, exporter, semanticDir: 'docs/erd', python: process.execPath, gateway, config: 'config_test' });
  expect(JSON.parse(result)).toEqual({ cwd: root, args: ['--project', root, '--semantic-dir', 'docs/erd', '--gateway', gateway, '--config', 'config_test'] });
});

it('reports exporter stderr without replacing the existing artifact', async () => {
  const exporter = path.join(root, 'failure.js');
  const artifact = path.join(root, 'sqlmesh.json');
  fs.writeFileSync(artifact, 'last good export');
  fs.writeFileSync(exporter, 'console.error("Missing SQLMesh dependency"); process.exit(1)');
  await expect(refreshSqlmesh({ root, exporter, semanticDir: '.', python: process.execPath })).rejects.toThrow('Missing SQLMesh dependency');
  expect(fs.readFileSync(artifact, 'utf8')).toBe('last good export');
});
