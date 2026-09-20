import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlmeshProjectAdapter, parseSqlmeshSnapshot, snapshotIntegrity, canonicalJson } from '../../src/services/sqlmeshAdapter';
import { detectProjectProvider, resolveProjectRoot } from '../../src/services/projectDetection';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { compare } from '../../src/services/discrepancyService';
import { HarnessService, HARNESS_TARGETS, HARNESS_VERSION, SQLMESH_HARNESS_VERSION, extractHarnessVersion } from '../../src/services/harnessService';

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
/** Rewrite the export as a different exporter run would have written it (re-stamped). */
function editArtifact(fn: (s: any) => void) {
  const s = JSON.parse(fs.readFileSync(adapter.artifactPath, 'utf8')); fn(s);
  s.integrity = snapshotIntegrity(s);
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
  it('merges v2 observations without losing source-only columns or treating unavailable relations as absent', async () => {
    editArtifact(s => {
      s.schemaVersion = 2;
      s.warehouse = { environment: 'dev', observedAt: '2026-09-20T12:00:00Z', models: s.models.map((m: any) => ({
        id: m.id, status: m.name === 'dim_customer' ? 'observed' : 'unavailable',
        relation: m.name === 'dim_customer' ? '"memory"."analytics__dev"."dim_customer"' : null,
        columns: m.name === 'dim_customer' ? [{ name: 'customer_id', dataType: 'BIGINT', description: '' }, { name: 'warehouse_only', dataType: 'TEXT', description: '' }] : [],
      })) };
    });
    const physical = adapter.buildPhysical(domain(), await adapter.load());
    expect(physical.integration?.warehouse).toMatchObject({ environment: 'dev', observed: 1, total: 7 });
    const customer = physical.models.find(m => m.name === 'dim_customer')!;
    expect(customer.columns.map(c => c.name)).toEqual(['customer_id', 'name', 'warehouse_only']);
    expect(customer.columns[0].dataType).toBe('BIGINT');
    expect(customer.provenance?.types).toBe('sqlmesh-observed');
    const order = physical.models.find(m => m.name === 'fct_order')!;
    expect(order.existsInProject).toBe(true);
    expect(order.columns).toHaveLength(3);
    expect(order.provenance?.types).toBe('sqlmesh-inferred');
    expect(physical.relationships).toHaveLength(1);
  });
  it('refuses an export edited by hand but still reads one written before the stamp existed', async () => {
    // The checked-in fixture is stamped by the real exporter; the editor's
    // canonical form must agree byte-for-byte (it holds non-ASCII text).
    const original = JSON.parse(fs.readFileSync(adapter.artifactPath, 'utf8'));
    expect(original.integrity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snapshotIntegrity(original)).toBe(original.integrity);
    expect(canonicalJson({ b: 'é😀\u007f', a: [1, null, true] })).toBe('{"a":[1,null,true],"b":"\\u00e9\\ud83d\\ude00\\u007f"}');
    // Keys sort by code point as Python's sort_keys does, not by UTF-16 code unit.
    expect(canonicalJson({ '\uE000': 1, '😀': 2, z: 3 })).toBe('{"z":3,"\\ue000":1,"\\ud83d\\ude00":2}');
    await adapter.load();
    expect(adapter.status).toBe('ready');

    const tampered = structuredClone(original);
    tampered.models.find((m: any) => m.name === 'fct_order').columns.pop();
    fs.writeFileSync(adapter.artifactPath, JSON.stringify(tampered)); adapter.invalidate();
    await adapter.load();
    expect(adapter.status).toBe('stale');
    expect(adapter.diagnostics[0]).toContain('integrity check failed');
    expect((await adapter.load()).manifest.models.get('fct_order')?.columns).toHaveLength(3);

    const legacy = structuredClone(tampered); delete legacy.integrity;
    fs.writeFileSync(adapter.artifactPath, JSON.stringify(legacy)); adapter.invalidate();
    await adapter.load();
    expect(adapter.status).toBe('ready');
    expect((await adapter.load()).manifest.models.get('fct_order')?.columns).toHaveLength(2);

    for (const bad of ['sha256:abc', 42, 'md5:' + 'a'.repeat(64)]) {
      expect(() => parseSqlmeshSnapshot(JSON.stringify({ ...original, integrity: bad }))).toThrow('integrity');
    }
  });
  it('rejects incomplete and malformed warehouse evidence', () => {
    const s = JSON.parse(fs.readFileSync(adapter.artifactPath, 'utf8'));
    delete s.integrity;
    s.schemaVersion = 2;
    s.warehouse = { environment: 'dev', observedAt: '2026-09-20T12:00:00Z', models: [] };
    expect(() => parseSqlmeshSnapshot(JSON.stringify(s))).toThrow('Incomplete');
    s.warehouse.models = s.models.map((m: any) => ({ id: m.id, status: 'observed', relation: null, columns: [] }));
    expect(() => parseSqlmeshSnapshot(JSON.stringify(s))).toThrow('Invalid warehouse');
    s.warehouse.models = s.models.map((m: any) => ({ id: m.id, status: 'unavailable', relation: null, columns: [], diagnostic: 'x' }));
    s.warehouse.diagnostic = 42;
    expect(() => parseSqlmeshSnapshot(JSON.stringify(s))).toThrow('Invalid warehouse');
  });
  it('surfaces a whole-inspection failure on the integration summary', async () => {
    const reason = "Environment 'prdo' was not found in SQLMesh state; check erdStudio.sqlmesh.environment or deploy that environment first";
    editArtifact(s => {
      s.schemaVersion = 2;
      s.warehouse = { environment: 'prdo', observedAt: '2026-09-20T12:00:00Z', diagnostic: reason,
        models: s.models.map((m: any) => ({ id: m.id, status: 'unavailable', relation: null, columns: [], diagnostic: reason })) };
    });
    const physical = adapter.buildPhysical(domain(), await adapter.load());
    expect(physical.integration?.warehouse).toMatchObject({ environment: 'prdo', observed: 0, total: 7, diagnostic: reason });
    // Source columns are untouched by a failed inspection.
    expect(physical.models.find(m => m.name === 'fct_order')?.columns).toHaveLength(3);
    expect(physical.models.find(m => m.name === 'fct_order')?.provenance?.types).toBe('sqlmesh-inferred');
  });
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
    delete original.integrity;
    for (const mutate of [
      (s: any) => { s.models[0].name = '../bad'; },
      (s: any) => { s.models[0].sourcePath = '/etc/passwd'; },
      (s: any) => { s.models.push(s.models[0]); },
      (s: any) => { s.relationships[0].toColumn = 'absent'; },
      (s: any) => { s.schemaVersion = 3; },
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
  it('tells assistants the FK parent must be a declared dependency', () => {
    const content = new HarnessService('.erd-studio', 'sqlmesh').generateContent('claude');
    expect(content).toContain('depends_on (analytics.dim_customer)');
    expect(content).toMatch(/builds its DAG from the query, not from audits/);
  });
  it('versions the SQLMesh harness independently of the dbt harness', () => {
    // A SQLMesh-only content change must never prompt every dbt user to rewrite
    // files that would come out byte-identical, so each provider carries and is
    // compared against its own version.
    const dbt = new HarnessService();
    const mesh = new HarnessService('.erd-studio', 'sqlmesh');
    expect(dbt.version).toBe(HARNESS_VERSION);
    expect(mesh.version).toBe(SQLMESH_HARNESS_VERSION);
    expect(extractHarnessVersion(dbt.generateContent('claude'))).toBe(HARNESS_VERSION);
    expect(extractHarnessVersion(mesh.generateContent('claude'))).toBe(SQLMESH_HARNESS_VERSION);
    const claude = HARNESS_TARGETS.find(t => t.id === 'claude')!;
    mesh.install(root, claude);
    expect(mesh.detectStale(root)).toHaveLength(0);
    // An older SQLMesh install is stale for SQLMesh; the dbt version is irrelevant to it.
    const file = path.join(root, claude.relativePath);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`<!-- erd-studio-harness: ${SQLMESH_HARNESS_VERSION} -->`, '<!-- erd-studio-harness: 0 -->'));
    expect(mesh.detectStale(root).map(t => t.id)).toEqual(['claude']);
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
