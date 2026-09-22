/**
 * A Snowflake-dialect SQLMesh project reports `CUSTOMER_ID`; the logical
 * design is typed `customer_id` (COLUMN_NAME_PATTERN is lowercase-only). The
 * export's per-model `identifierFolding` is what reconciles the two — in the
 * comparison, in the sync plan that applies physical truth to the design, in
 * Add Existing Model seeding and in cardinality evidence.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlmeshProjectAdapter, snapshotIntegrity } from '../../src/services/sqlmeshAdapter';
import { applySqlmeshLogicalPlan, buildSqlmeshSyncPlan, captureSqlmeshInputs } from '../../src/services/sqlmeshSync';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { compare } from '../../src/services/discrepancyService';
import { validateColumnDef } from '../../src/providers/payloadValidation';
import { columnKey, relationshipKey } from '../../src/types/syncPlan';
import type { DisplayDomain } from '../../src/types/display';
import type { GroundTruth } from '../../src/types/syncPlan';

let root: string;
let adapter: SqlmeshProjectAdapter;
let domains: DomainService;
const domainPath = '.erd-studio/silver/orders.json';

/** Rewrite the fixture export as a Snowflake-style project: upper-folded, uppercase names. */
function makeSnowflake(edit?: (s: any) => void) {
  const file = path.join(root, '.erd-studio/sqlmesh.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const m of s.models) {
    m.identifierFolding = 'upper';
    m.dialect = 'snowflake';
    for (const c of m.columns) c.name = c.name.toUpperCase();
    m.uniqueKeys = m.uniqueKeys.map((k: string[]) => k.map((c) => c.toUpperCase()));
  }
  for (const r of s.relationships) { r.fromColumn = r.fromColumn.toUpperCase(); r.toColumn = r.toColumn.toUpperCase(); }
  edit?.(s);
  s.integrity = snapshotIntegrity(s);
  fs.writeFileSync(file, JSON.stringify(s));
  adapter.invalidate();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-case-'));
  fs.cpSync(path.resolve(__dirname, '../fixtures/sqlmesh-project'), root, { recursive: true });
  adapter = new SqlmeshProjectAdapter(root);
  domains = new DomainService(new LayerService(root));
  domains.setLogicalModelService(new LogicalModelService(root));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function stages() {
  const data = await adapter.load();
  const unified = domains.getDomain(path.join(root, domainPath));
  const physical = adapter.buildPhysical(unified, data);
  const logicalStage = domains.getDomainStage(path.join(root, domainPath));
  const logical: DisplayDomain = { ...physical, stage: 'logical', identifierCaseSensitive: true,
    models: logicalStage.models.map((m) => ({ name: m.name, schema: m.schema ?? '', description: m.description ?? '',
      columns: (m.columns ?? []).map((c) => ({ name: c.name, dataType: c.dataType, description: c.description ?? '',
        isPrimaryKey: !!c.isPrimaryKey, isForeignKey: !!c.isForeignKey, isNaturalKey: !!c.isNaturalKey })) })),
    relationships: logicalStage.relationships.map((r) => ({ ...r })) };
  return { data, unified, physical, logical };
}

it('matches a lowercase logical design against upper-folded physical names', async () => {
  makeSnowflake();
  const { physical, logical } = await stages();
  expect(physical.models.find((m) => m.name === 'fct_order')?.identifierFolding).toBe('upper');
  expect(physical.models.find((m) => m.name === 'fct_order')?.columns.map((c) => c.name)).toEqual(['ORDER_ID', 'CUSTOMER_ID', 'AMOUNT']);

  const report = compare(physical, logical);
  expect(report.summary).toMatchObject({ extraColumns: 0, missingColumns: 0, dataTypeMismatches: 0 });
  expect(report.models.every((m) => m.columns.every((c) => c.status === 'matched'))).toBe(true);
  expect(report.relationships).toHaveLength(1);
  expect(report.relationships[0].status).toBe('matched');
  expect(physical.relationships[0].cardinality).toBe('many-to-one');
});

it('keeps a quoted lowercase column apart from its uppercase twin', async () => {
  makeSnowflake((s) => {
    const order = s.models.find((m: any) => m.name === 'fct_order');
    order.columns.push({ name: 'amount', dataType: 'DECIMAL(10, 2)', description: 'quoted twin' });
  });
  const { physical, logical } = await stages();
  const report = compare(physical, logical);
  const order = report.models.find((m) => m.name === 'fct_order')!;
  // The logical `amount` pairs with the exact `amount` (never the folded
  // `AMOUNT` while an exact spelling exists); `AMOUNT` is then extra.
  expect(order.columns.find((c) => c.name === 'amount')?.status).toBe('matched');
  expect(order.columns.find((c) => c.name === 'AMOUNT')?.status).toBe('extra');
});

it('applies physical truth to the design in logical spelling and finds existing columns through the fold', async () => {
  makeSnowflake((s) => {
    const order = s.models.find((m: any) => m.name === 'fct_order');
    order.columns.find((c: any) => c.name === 'AMOUNT').dataType = 'NUMBER(12, 2)';
    order.columns.push({ name: 'CREATED_AT', dataType: 'TIMESTAMP_NTZ', description: 'Order time' });
  });
  const { unified, physical, logical } = await stages();
  const report = compare(physical, logical);
  const selections: Record<string, GroundTruth> = {
    [columnKey('fct_order', 'AMOUNT')]: 'physical',
    [columnKey('fct_order', 'CREATED_AT')]: 'physical',
  };
  const plan = buildSqlmeshSyncPlan({ report, selections, snapshot: adapter.getSnapshot()!, domainPath, semanticDir: '.erd-studio',
    preconditions: captureSqlmeshInputs(root, '.erd-studio', adapter.getSnapshot()!, domainPath) });
  expect(plan.direction).toBe('metadata-to-logical');
  expect(plan.columns.map((c) => c.action).sort()).toEqual(['add-column-to-logical', 'update-type-in-logical']);

  const patch = applySqlmeshLogicalPlan(plan, unified, physical);
  const order = patch.models.find((m) => m.name === 'fct_order')!;
  expect(order.columns!.map((c) => c.name)).toEqual(['order_id', 'customer_id', 'amount', 'created_at']);
  expect(order.columns!.find((c) => c.name === 'amount')?.dataType).toBe('NUMBER(12, 2)');
  expect(order.columns!.find((c) => c.name === 'created_at')).toMatchObject({ dataType: 'TIMESTAMP_NTZ', description: 'Order time' });
  // Everything written satisfies the authoring rule the canvas enforces.
  for (const c of order.columns!) expect(validateColumnDef(c)).toBeNull();
  // The design's relationship still has both endpoints.
  expect(patch.relationships).toHaveLength(1);
});

it('removes a column and adds a relationship through the fold, and blocks a dangling removal', async () => {
  makeSnowflake((s) => {
    const order = s.models.find((m: any) => m.name === 'fct_order');
    order.columns = order.columns.filter((c: any) => c.name !== 'AMOUNT');
  });
  const { unified, physical, logical } = await stages();
  // Drop the design's own relationship so the audit-backed one is 'extra' from physical.
  const logicalNoRel = { ...logical, relationships: [] };
  const report = compare(physical, logicalNoRel);
  const unifiedNoRel = { ...unified, logical: { ...unified.logical, relationships: [] } };
  const snapshot = adapter.getSnapshot()!;
  const preconditions = captureSqlmeshInputs(root, '.erd-studio', snapshot, domainPath);
  const plan = buildSqlmeshSyncPlan({ report, snapshot, domainPath, semanticDir: '.erd-studio', preconditions, selections: {
    [columnKey('fct_order', 'amount')]: 'physical',
    [relationshipKey('fct_order', 'CUSTOMER_ID', 'dim_customer', 'CUSTOMER_ID')]: 'physical',
  } });
  const patch = applySqlmeshLogicalPlan(plan, unifiedNoRel, physical);
  expect(patch.models.find((m) => m.name === 'fct_order')!.columns!.map((c) => c.name)).toEqual(['order_id', 'customer_id']);
  expect(patch.relationships).toEqual([{ fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' }]);

  // Removing the FK column while the design still relates through it is refused.
  const dangling = buildSqlmeshSyncPlan({ report: compare(physical, { ...logical, models: logical.models }), snapshot, domainPath, semanticDir: '.erd-studio', preconditions,
    selections: { [columnKey('fct_order', 'amount')]: 'physical' } });
  const withFkRemoved = { ...dangling, columns: [...dangling.columns, { ...dangling.columns[0], columnName: 'CUSTOMER_ID', discrepancyStatus: 'missing' as const }] };
  expect(() => applySqlmeshLogicalPlan(withFkRemoved, unified, physical)).toThrow('without an endpoint');
});

it('seeds Add Existing Model in logical spelling and folds cardinality evidence', async () => {
  makeSnowflake();
  const data = await adapter.load();
  const seeded = adapter.seedModel('fct_order')!;
  expect(seeded.columns!.map((c) => c.name)).toEqual(['order_id', 'customer_id', 'amount']);
  for (const c of seeded.columns!) expect(validateColumnDef(c)).toBeNull();
  expect(data.manifest.relationshipTests).toEqual([{ fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id' }]);
  expect(adapter.relationshipCardinality('fct_order', 'customer_id', 'dim_customer', 'customer_id')).toBe('many-to-one');
  expect(adapter.relationshipCardinality('fct_order', 'ORDER_ID', 'dim_customer', 'CUSTOMER_ID')).toBe('one-to-one');
});

it('matches exports that predate identifierFolding exactly, as before', async () => {
  makeSnowflake((s) => { for (const m of s.models) delete m.identifierFolding; });
  const { physical, logical } = await stages();
  expect(physical.models[0].identifierFolding).toBe('exact');
  const report = compare(physical, logical);
  expect(report.summary.matchedColumns).toBe(0);
});

it.each(['lower', 'upper'] as const)('refuses importing distinct columns that collide under %s folding', async folding => {
  makeSnowflake(s => {
    const model = s.models.find((m: any) => m.name === 'fct_order');
    model.identifierFolding = folding;
    model.columns.push({ name: 'amount', dataType: 'VARCHAR', description: 'Quoted twin' });
  });
  const { physical } = await stages();
  expect(physical.models.find(m => m.name === 'fct_order')!.columns.map(c => c.name)).toContain('amount');
  expect(() => adapter.seedModel('fct_order')).toThrow(/AMOUNT.*amount.*collide/);
});

it.each(['physical', 'logical'] as const)('refuses a %s-authoritative plan for a colliding model', async truth => {
  makeSnowflake(s => {
    s.models.find((m: any) => m.name === 'fct_order').columns.push({ name: 'amount', dataType: 'DECIMAL(10, 2)', description: '' });
  });
  const { physical, logical } = await stages();
  const report = compare(physical, logical);
  expect(() => buildSqlmeshSyncPlan({ report, snapshot: adapter.getSnapshot()!, domainPath,
    semanticDir: '.erd-studio', preconditions: {}, selections: { [columnKey('fct_order', 'AMOUNT')]: truth } })).toThrow('collide');
});

it('refuses a colliding physical patch even if a caller supplies an older plan', async () => {
  makeSnowflake(s => { s.models.find((m: any) => m.name === 'fct_order').columns[2].dataType = 'TEXT'; });
  const { physical, logical, unified } = await stages();
  const plan = buildSqlmeshSyncPlan({ report: compare(physical, logical), snapshot: adapter.getSnapshot()!, domainPath,
    semanticDir: '.erd-studio', preconditions: {}, selections: { [columnKey('fct_order', 'AMOUNT')]: 'physical' } });
  physical.models.find(m => m.name === 'fct_order')!.columns.push({ ...physical.models[1].columns[0], name: 'amount' });
  const before = structuredClone(unified);
  expect(() => applySqlmeshLogicalPlan(plan, unified, physical)).toThrow('collide');
  expect(unified).toEqual(before);
});

it.each(['UpperCase', 'has space', 'has-dash'])('refuses an uneditable exact column name %s during import', async name => {
  makeSnowflake(s => {
    const model = s.models.find((m: any) => m.name === 'fct_order');
    model.identifierFolding = 'exact';
    model.columns = [{ name, dataType: 'INT', description: '' }];
    model.uniqueKeys = [];
    s.relationships = [];
  });
  await adapter.load();
  expect(() => adapter.seedModel('fct_order')).toThrow('logical naming rules');
});

it('keeps quoted-column uniqueness evidence separate from its folded twin', async () => {
  makeSnowflake(s => {
    s.models.find((m: any) => m.name === 'fct_order').columns.push({ name: 'order_id', dataType: 'INT', description: '' });
  });
  await adapter.load();
  expect(adapter.relationshipCardinality('fct_order', 'ORDER_ID', 'dim_customer', 'CUSTOMER_ID')).toBe('one-to-one');
  expect(adapter.relationshipCardinality('fct_order', 'order_id', 'dim_customer', 'CUSTOMER_ID')).toBe('many-to-one');
});

it('does not copy a logical primary-key badge to both physical case siblings', async () => {
  makeSnowflake(s => {
    s.models.find((m: any) => m.name === 'fct_order').columns.push({ name: 'order_id', dataType: 'INT', description: '' });
  });
  const { physical } = await stages();
  const columns = physical.models.find(m => m.name === 'fct_order')!.columns;
  expect(columns.find(c => c.name === 'order_id')!.isPrimaryKey).toBe(true);
  expect(columns.find(c => c.name === 'ORDER_ID')!.isPrimaryKey).toBe(false);
});

it.each([false, true])('retains observed case siblings without order-dependent type overwrites (reverse=%s)', async reverse => {
  makeSnowflake(s => {
    const order = s.models.find((m: any) => m.name === 'fct_order');
    order.columns.find((c: any) => c.name === 'AMOUNT').name = 'amount';
    const observed = [{ name: 'AMOUNT', dataType: 'VARCHAR', description: '' }, { name: 'amount', dataType: 'BIGINT', description: '' }];
    s.warehouse = { environment: 'dev', observedAt: new Date().toISOString(), models: s.models.map((m: any) => ({
      id: m.id, status: m === order ? 'observed' : 'unavailable', relation: m === order ? '"db"."schema"."orders"' : null,
      columns: m === order ? (reverse ? [...observed].reverse() : observed) : [],
    })) };
  });
  const { physical } = await stages();
  const columns = physical.models.find(m => m.name === 'fct_order')!.columns;
  expect(columns.find(c => c.name === 'AMOUNT')?.dataType).toBe('VARCHAR');
  expect(columns.find(c => c.name === 'amount')?.dataType).toBe('BIGINT');
});

async function boundStages() {
  makeSnowflake(s => {
    const order = s.models.find((m: any) => m.name === 'fct_order');
    order.columns.push({ name: 'order_id', dataType: 'VARCHAR', description: 'quoted sibling' });
    order.columnBindings = { order_key: 'ORDER_ID', quoted_key: 'order_id', customer_key: 'CUSTOMER_ID' };
    s.models.find((m: any) => m.name === 'dim_customer').columnBindings = { customer_key: 'CUSTOMER_ID' };
  });
  const data = await adapter.load();
  const unified = domains.getDomain(path.join(root, domainPath));
  unified.logical.models = unified.logical.models.map(m => adapter.seedModel(m.name)!);
  unified.logical.models.find(m => m.name === 'fct_order')!.columns!.find(c => c.name === 'order_key')!.isPrimaryKey = true;
  unified.logical.relationships = [{ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }];
  const physical = adapter.buildPhysical(unified, data);
  const logical: DisplayDomain = { ...physical, stage: 'logical', relationships: unified.logical.relationships,
    models: unified.logical.models.map(m => ({ name: m.name, schema: m.schema ?? '', description: '',
      columns: m.columns!.map(c => ({ ...c, description: c.description ?? '', isPrimaryKey: !!c.isPrimaryKey, isForeignKey: false, isNaturalKey: false })) })) };
  return { unified, physical, logical, data };
}

it('uses explicit aliases for case siblings, design badges, imports and relationship evidence', async () => {
  const { physical, logical, data } = await boundStages();
  const model = physical.models.find(m => m.name === 'fct_order')!;
  expect(model.identifierFolding).toBe('exact');
  expect(model.columns.map(c => [c.name, c.nativeName, c.isPrimaryKey])).toEqual([
    ['order_key', 'ORDER_ID', true], ['customer_key', 'CUSTOMER_ID', false], ['amount', 'AMOUNT', false], ['quoted_key', 'order_id', false],
  ]);
  for (const report of [compare(physical, logical), compare(logical, physical)]) {
    expect(report.models.flatMap(m => m.columns).every(c => c.status === 'matched')).toBe(true);
    expect(report.relationships.map(r => r.status)).toEqual(['matched']);
  }
  expect(data.manifest.relationshipTests[0]).toMatchObject({ fromColumn: 'customer_key', toColumn: 'customer_key' });
  expect(adapter.relationshipCardinality('fct_order', 'order_key', 'dim_customer', 'customer_key')).toBe('one-to-one');
  expect(adapter.relationshipCardinality('fct_order', 'quoted_key', 'dim_customer', 'customer_key')).toBe('many-to-one');
});

it.each(['logical', 'physical'] as const)('syncs a bound identifier from the %s comparison without touching its sibling', async stage => {
  const { unified, physical, logical } = await boundStages();
  logical.models.find(m => m.name === 'fct_order')!.columns.find(c => c.name === 'order_key')!.dataType = 'BIGINT';
  unified.logical.models.find(m => m.name === 'fct_order')!.columns!.find(c => c.name === 'order_key')!.dataType = 'BIGINT';
  const report = stage === 'logical' ? compare(logical, physical) : compare(physical, logical);
  const options = { report, snapshot: adapter.getSnapshot()!, domainPath, semanticDir: '.erd-studio', preconditions: {} };
  const key = columnKey('fct_order', 'order_key');
  const plan = buildSqlmeshSyncPlan({ ...options, selections: { [key]: 'physical' } });
  const patch = applySqlmeshLogicalPlan(plan, unified, physical);
  expect(patch.models[0].columns!.find(c => c.name === 'order_key')!.dataType).toBe('INT');
  expect(patch.models[0].columns!.find(c => c.name === 'quoted_key')!.dataType).toBe('VARCHAR');
  const source = buildSqlmeshSyncPlan({ ...options, selections: { [key]: 'logical' } });
  expect(source.modelContext.fct_order.columnNames).toEqual({ order_key: 'ORDER_ID', quoted_key: 'order_id', customer_key: 'CUSTOMER_ID', amount: 'AMOUNT' });
  expect(source.columns[0]).toMatchObject({ columnName: 'order_key', resolvedDataType: 'BIGINT' });
});

it.each(['logical', 'physical'] as const)('shows unrepresentable warehouse drift on a bound model in the %s comparison but refuses sync', async stage => {
  const { unified, physical, logical, data } = await boundStages();
  logical.models.find(m => m.name === 'fct_order')!.columns.find(c => c.name === 'amount')!.dataType = 'TEXT';
  const snapshot = adapter.getSnapshot()!;
  const reportFor = (physical: DisplayDomain) => stage === 'logical' ? compare(logical, physical) : compare(physical, logical);
  const options = { snapshot, domainPath, semanticDir: '.erd-studio', preconditions: {} };
  const earlierPlan = buildSqlmeshSyncPlan({ ...options, report: reportFor(physical),
    selections: { [columnKey('fct_order', 'amount')]: 'physical' } });
  snapshot.warehouse = { environment: 'dev', observedAt: new Date().toISOString(), models: snapshot.models.map(m => ({
    id: m.id, status: m.name === 'fct_order' ? 'observed' : 'unavailable',
    relation: m.name === 'fct_order' ? '"db"."schema"."orders"' : null,
    columns: m.name === 'fct_order' ? [{ name: 'Order Note', dataType: 'TEXT', description: 'Warehouse drift' }] : [],
  })) };

  const drifted = adapter.buildPhysical(unified, data);
  expect(drifted.readOnly).toBe(true);
  expect(drifted.models.find(m => m.name === 'fct_order')!.columns).toContainEqual(expect.objectContaining({
    name: 'order note', nativeName: 'Order Note', dataType: 'TEXT', description: 'Warehouse drift',
  }));
  const report = reportFor(drifted);
  expect(report.models.find(m => m.name === 'fct_order')!.columns.find(c => c.name === 'order note')!.status)
    .toBe(stage === 'logical' ? 'missing' : 'extra');
  expect(() => buildSqlmeshSyncPlan({ ...options, report,
    selections: { [columnKey('fct_order', 'order note')]: 'physical' } })).toThrow('logical naming rules');
  const before = structuredClone(unified);
  expect(() => applySqlmeshLogicalPlan(earlierPlan, unified, drifted)).toThrow('logical naming rules');
  expect(unified).toEqual(before);
});

it('keeps bound source import guards when a source column cannot be represented logically', async () => {
  await boundStages();
  adapter.getModel('fct_order')!.columns.push({ name: 'Order Note', dataType: 'TEXT', description: '' });
  expect(() => adapter.assertWritableModel('fct_order')).toThrow('logical naming rules');
  expect(() => adapter.seedModel('fct_order')).toThrow('logical naming rules');
});

it.each(['logical', 'physical'] as const)('distinguishes warehouse alias conflicts without moving source comparison or relationship identity (%s)', async stage => {
  const { unified, logical, data } = await boundStages();
  const snapshot = adapter.getSnapshot()!;
  const order = snapshot.models.find(m => m.name === 'fct_order')!;
  snapshot.warehouse = { environment: 'dev', observedAt: new Date().toISOString(), models: [{
    id: order.id, status: 'observed', relation: 'analytics.fct_order', columns: [
      ...order.columns, { name: 'CUSTOMER_KEY', dataType: 'TEXT', description: 'Observed alias collision' },
    ],
  }] };
  const physical = adapter.buildPhysical(unified, data);
  const columns = physical.models.find(m => m.name === 'fct_order')!.columns;
  expect(new Set(columns.map(c => c.name)).size).toBe(columns.length);
  expect(columns.find(c => c.name === 'customer_key')!.nativeName).toBe('CUSTOMER_ID');
  const conflict = columns.find(c => c.nativeName === 'CUSTOMER_KEY')!;
  expect(conflict.name).toBe('CUSTOMER_KEY (warehouse only)');
  expect(conflict.isPrimaryKey).toBe(false);
  expect(physical.relationships[0].fromColumn).toBe('customer_key');
  const report = stage === 'logical' ? compare(logical, physical) : compare(physical, logical);
  const compared = report.models.find(m => m.name === 'fct_order')!.columns;
  expect(compared.find(c => c.name === 'customer_key')!.status).toBe('matched');
  expect(compared.find(c => c.name === conflict.name)!.status).toBe(stage === 'logical' ? 'missing' : 'extra');
  expect(() => buildSqlmeshSyncPlan({ report, snapshot, domainPath, semanticDir: '.erd-studio', preconditions: {},
    selections: { [columnKey('fct_order', conflict.name)]: 'physical' } })).toThrow('collide');
  snapshot.warehouse.models[0].columns.reverse();
  expect(adapter.buildPhysical(unified, data).models.find(m => m.name === 'fct_order')!.columns.find(c => c.nativeName === 'CUSTOMER_KEY')!.name).toBe(conflict.name);
});

it.each([
  { bad: 'MISSING' }, { a: 'ORDER_ID', b: 'ORDER_ID' }, { 'Bad Alias': 'ORDER_ID' }, { amount: 'ORDER_ID' },
])('refuses malformed, dangling, or colliding bindings %j', async columnBindings => {
  makeSnowflake(s => { s.models.find((m: any) => m.name === 'fct_order').columnBindings = columnBindings; });
  await adapter.load();
  expect(adapter.status).toBe('invalid');
  expect(adapter.getSnapshot()).toBeUndefined();
});

it('imports an exact identifier containing spaces using an explicit binding', async () => {
  makeSnowflake(s => {
    const model = s.models.find((m: any) => m.name === 'fct_order');
    model.identifierFolding = 'exact';
    model.columns = [{ name: 'Order Number', dataType: 'INT', description: 'Native identifier' }];
    model.uniqueKeys = [];
    model.columnBindings = { order_number: 'Order Number' };
    s.relationships = [];
  });
  await adapter.load();
  expect(adapter.seedModel('fct_order')?.columns).toEqual([{ name: 'order_number', dataType: 'INT', description: 'Native identifier' }]);
});
