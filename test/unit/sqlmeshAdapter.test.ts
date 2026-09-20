import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlmeshProjectAdapter, parseSqlmeshSnapshot } from '../../src/services/sqlmeshAdapter';
import { detectProjectProvider, resolveProjectRoot } from '../../src/services/projectDetection';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { compare } from '../../src/services/discrepancyService';
import { HarnessService, HARNESS_TARGETS } from '../../src/services/harnessService';

const fixture = path.resolve(__dirname, '../fixtures/sqlmesh-project');
let root: string;
let adapter: SqlmeshProjectAdapter;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-mesh-'));
  fs.cpSync(fixture, root, { recursive: true });
  adapter = new SqlmeshProjectAdapter(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function domain() {
  const service = new DomainService(new LayerService(root));
  service.setLogicalModelService(new LogicalModelService(root));
  return service.getDomain(path.join(root, '.erd-studio/silver/orders.json'));
}
function editArtifact(fn: (s: any) => void) {
  const s = JSON.parse(fs.readFileSync(adapter.artifactPath, 'utf8')); fn(s);
  fs.writeFileSync(adapter.artifactPath, JSON.stringify(s)); adapter.invalidate();
}

describe('SQLMesh project detection', () => {
  it('discovers a nested native project and respects an explicit provider', () => {
    expect(detectProjectProvider(root)).toBe('sqlmesh');
    expect(resolveProjectRoot([path.dirname(root)], root)).toBe(root);
    expect(detectProjectProvider(root, 'dbt')).toBeUndefined();
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: hybrid\n');
    expect(detectProjectProvider(root)).toBe('dbt');
    expect(detectProjectProvider(root, 'sqlmesh')).toBe('sqlmesh');
  });
  it('does not execute Python configuration or recognize unrelated config files', () => {
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config.yaml'), 'application: test');
    expect(detectProjectProvider(root)).toBeUndefined();
    fs.writeFileSync(path.join(root, 'config.py'), 'from sqlmesh import Context\nraise RuntimeError("must not execute")');
    expect(detectProjectProvider(root)).toBe('sqlmesh');
  });
});

describe('SQLMesh metadata adapter', () => {
  it('loads real exported metadata, identities, provenance, FK evidence and matching comparisons', async () => {
    const data = await adapter.load();
    expect(adapter.status).toBe('ready');
    expect(data.manifest.models.get('dim_customer')?.uniqueId).toContain('"analytics"."dim_customer"');
    expect([...data.manifest.models.values()].filter(m => m.uniqueId.endsWith('"dim_customer"'))).toHaveLength(2);
    const physical = adapter.buildPhysical(domain(), data);
    expect(physical.relationships).toEqual([{ fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' }]);
    expect(physical.models.find(m => m.name === 'fct_order')?.provenance?.types).toBe('sqlmesh-inferred');
    const logical = { ...physical, stage: 'logical' as const, models: physical.models.map(m => ({ ...m, provenance: undefined })) };
    const report = compare(logical, physical);
    expect(report.models.every(m => m.status === 'matched')).toBe(true);
    expect(report.relationships[0].status).toBe('matched');
    expect(adapter.existingModels(new Set(['dim_customer', 'fct_order']))[0].source).toBe('sqlmesh');
  });
  it('never merges case-sensitive columns and does not infer edges from logical relationships', async () => {
    editArtifact(s => { s.relationships = []; s.models[0].columns.push({ name: 'CUSTOMER_ID', dataType: 'TEXT', description: '' }); });
    const physical = adapter.buildPhysical(domain(), await adapter.load());
    expect(physical.relationships).toEqual([]);
    const logical = { ...physical, stage: 'logical' as const, models: physical.models.map(m => ({ ...m, columns: m.columns.filter(c => c.name !== 'CUSTOMER_ID') })) };
    expect(compare(logical, physical).models[0].columns.some(c => c.name === 'CUSTOMER_ID' && c.status === 'missing')).toBe(true);
  });
  it('marks changed, added and removed source inputs stale', async () => {
    await adapter.load();
    fs.appendFileSync(path.join(root, 'models/dim_customer.sql'), '\n-- changed');
    adapter.invalidate(); await adapter.load(); expect(adapter.status).toBe('stale');
    fs.cpSync(path.join(fixture, 'models/dim_customer.sql'), path.join(root, 'models/dim_customer.sql'));
    fs.writeFileSync(path.join(root, 'models/added.sql'), 'SELECT 1');
    adapter.invalidate(); await adapter.load(); expect(adapter.status).toBe('stale');
    fs.unlinkSync(path.join(root, 'models/added.sql'));
    fs.unlinkSync(path.join(root, 'models/disabled.sql'));
    adapter.invalidate(); await adapter.load(); expect(adapter.status).toBe('stale');
  });
  it('keeps last good data on malformed exports but clears it on deletion', async () => {
    await adapter.load();
    fs.writeFileSync(adapter.artifactPath, '{'); adapter.invalidate();
    expect((await adapter.load()).manifest.models.size).toBeGreaterThan(0);
    expect(adapter.status).toBe('stale');
    fs.unlinkSync(adapter.artifactPath); adapter.invalidate();
    expect((await adapter.load()).manifest.models.size).toBe(0);
    expect(adapter.status).toBe('missing');
    expect(() => adapter.buildPhysical(domain(), { manifest: {} as any, declarations: {} as any })).toThrow('No SQLMesh export');
  });
  it('does not turn unknown columns into destructive comparison suggestions', async () => {
    const data = await adapter.load();
    const physical = adapter.buildPhysical(domain(), data);
    const logical = { ...physical, stage: 'logical' as const };
    const unknown = { ...physical, models: physical.models.map(m => ({ ...m, columns: [], columnsKnown: false })) };
    expect(compare(logical, unknown).models.every(m => m.columns.length === 0)).toBe(true);
  });
  it('rejects unsafe aliases, paths, duplicate IDs, invalid edges and future schema versions', () => {
    const original = JSON.parse(fs.readFileSync(adapter.artifactPath, 'utf8'));
    for (const mutate of [
      (s: any) => { s.models[0].name = '../bad'; },
      (s: any) => { s.models[0].sourcePath = '/etc/passwd'; },
      (s: any) => { s.models.push(s.models[0]); },
      (s: any) => { s.relationships[0].toColumn = 'absent'; },
      (s: any) => { s.schemaVersion = 2; },
    ]) {
      const value = structuredClone(original); mutate(value);
      expect(() => parseSqlmeshSnapshot(JSON.stringify(value))).toThrow();
    }
  });
  it('generates native harness instructions without dbt execution guidance', () => {
    for (const target of ['claude', 'copilot', 'gemini', 'codex'] as const) {
      const content = new HarnessService('.erd-studio', 'sqlmesh').generateContent(target);
      expect(content).toContain('sqlmesh-bindings.json');
      expect(content).not.toContain('dbt compile');
      expect(content).not.toContain('dbt build');
      expect(content).toContain('schemaVersion');
    }
  });
  it('offers harness replacement when switching providers at the same version', () => {
    const dbt = new HarnessService();
    const mesh = new HarnessService('.erd-studio', 'sqlmesh');
    const codex = HARNESS_TARGETS.find(t => t.id === 'codex')!;
    dbt.install(root, codex);
    expect(dbt.detectStale(root)).toHaveLength(0);
    expect(mesh.detectStale(root).map(t => t.id)).toEqual(['codex']);
    mesh.install(root, codex, true);
    expect(mesh.detectStale(root)).toHaveLength(0);
    expect(dbt.detectStale(root).map(t => t.id)).toEqual(['codex']);
  });
});
