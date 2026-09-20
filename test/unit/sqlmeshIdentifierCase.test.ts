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
import { SqlmeshProjectAdapter } from '../../src/services/sqlmeshAdapter';
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
