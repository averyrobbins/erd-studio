import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { refreshSqlmesh, exportTimeoutMs, DEFAULT_EXPORT_TIMEOUT_SECONDS, MIN_EXPORT_TIMEOUT_SECONDS } from '../../src/services/sqlmeshRefresh';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd mesh refresh ')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('passes paths and SQLMesh options as literal arguments without a shell', async () => {
  const exporter = path.join(root, 'mock exporter.js');
  fs.writeFileSync(exporter, 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))');
  const gateway = 'local; $(exit 1)';
  const result = await refreshSqlmesh({ root, exporter, semanticDir: 'docs/erd', python: process.execPath, gateway, config: 'config_test', environment: 'dev;literal' });
  expect(JSON.parse(result)).toEqual({ cwd: root, args: ['--project', root, '--semantic-dir', 'docs/erd', '--gateway', gateway, '--config', 'config_test', '--environment', 'dev;literal'] });
});

it('reports exporter stderr without replacing the existing artifact', async () => {
  const exporter = path.join(root, 'failure.js');
  const artifact = path.join(root, 'sqlmesh.json');
  fs.writeFileSync(artifact, 'last good export');
  fs.writeFileSync(exporter, 'console.error("Missing SQLMesh dependency"); process.exit(1)');
  await expect(refreshSqlmesh({ root, exporter, semanticDir: '.', python: process.execPath })).rejects.toThrow('Missing SQLMesh dependency');
  expect(fs.readFileSync(artifact, 'utf8')).toBe('last good export');
});

it('derives the exporter timeout from the setting with a floor and a default', () => {
  expect(exportTimeoutMs(undefined)).toBe(DEFAULT_EXPORT_TIMEOUT_SECONDS * 1000);
  expect(exportTimeoutMs('not a number')).toBe(DEFAULT_EXPORT_TIMEOUT_SECONDS * 1000);
  expect(exportTimeoutMs(1)).toBe(MIN_EXPORT_TIMEOUT_SECONDS * 1000);
  expect(exportTimeoutMs(900.7)).toBe(900 * 1000);
});

it('names the setting when the exporter is stopped by the timeout and keeps the artifact', async () => {
  const exporter = path.join(root, 'slow.js');
  const artifact = path.join(root, 'sqlmesh.json');
  fs.writeFileSync(artifact, 'last good export');
  fs.writeFileSync(exporter, 'setTimeout(() => {}, 60000)');
  await expect(refreshSqlmesh({ root, exporter, semanticDir: '.', python: process.execPath, timeoutMs: 200 }))
    .rejects.toThrow(/timed out after 0 s .*erdStudio\.sqlmesh\.exportTimeoutSeconds/);
  expect(fs.readFileSync(artifact, 'utf8')).toBe('last good export');
});

it('stops the exporter when the progress notification is cancelled', async () => {
  const exporter = path.join(root, 'slow.js');
  fs.writeFileSync(exporter, 'setTimeout(() => {}, 60000)');
  const controller = new AbortController();
  const run = refreshSqlmesh({ root, exporter, semanticDir: '.', python: process.execPath, timeoutMs: 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await expect(run).rejects.toThrow('SQLMesh export cancelled');
});
