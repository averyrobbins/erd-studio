import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqlmeshProjectAdapter } from '../../src/services/sqlmeshAdapter';
import { applySqlmeshLogicalPlan, buildSqlmeshSyncPlan, captureSqlmeshInputs, assertSqlmeshPlanCurrent, assertSqlmeshCreationTargets } from '../../src/services/sqlmeshSync';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { compare } from '../../src/services/discrepancyService';
import { columnKey, modelKey, relationshipKey } from '../../src/types/syncPlan';
import type { DisplayDomain } from '../../src/types/display';
import type { GroundTruth } from '../../src/types/syncPlan';

let root: string;
let adapter: SqlmeshProjectAdapter;
let domains: DomainService;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sync-'));
  fs.cpSync(path.resolve(__dirname, '../fixtures/sqlmesh-project'), root, { recursive: true });
  adapter = new SqlmeshProjectAdapter(root);
  domains = new DomainService(new LayerService(root));
  domains.setLogicalModelService(new LogicalModelService(root));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const domainPath = '.erd-studio/silver/orders.json';
async function setup() {
  const data = await adapter.load();
  const domain = domains.getDomain(path.join(root, domainPath));
  const physical = adapter.buildPhysical(domain, data);
  const logical: DisplayDomain = { ...physical, stage: 'logical', models: structuredClone(physical.models), relationships: structuredClone(physical.relationships) };
  const options = { snapshot: adapter.getSnapshot()!, domainPath, semanticDir: '.erd-studio', logical: domain,
    preconditions: captureSqlmeshInputs(root, '.erd-studio', adapter.getSnapshot()!, domainPath) };
  const plan = (selections: Record<string, GroundTruth>, reversed = false) => buildSqlmeshSyncPlan({ ...options, selections,
    report: reversed ? compare(physical, logical) : compare(logical, physical) });
  return { domain, physical, logical, options, plan };
}

it.each([false, true])('applies authoritative types in either comparison direction while preserving design metadata (%s)', async reversed => {
  const { domain, physical, logical, plan } = await setup();
  const model = domain.logical.models.find(m => m.name === 'fct_order')!;
  model.grain = 'One row per order'; model.rationale = { purpose: 'Preserve me' } as any;
  model.columns!.find(c => c.name === 'amount')!.scdType = 2;
  logical.models.find(m => m.name === model.name)!.columns.find(c => c.name === 'amount')!.dataType = 'TEXT';
  const prepared = plan({ [columnKey('fct_order', 'amount')]: 'physical' }, reversed);
  const patch = applySqlmeshLogicalPlan(prepared, domain, physical);
  expect(patch.models[0].columns!.find(c => c.name === 'amount')).toMatchObject({ dataType: 'DECIMAL(10, 2)', scdType: 2, description: 'Order amount' });
  expect(patch.models[0]).toMatchObject({ grain: model.grain, rationale: model.rationale });
  expect(prepared.modelContext.fct_order.modelId).toBe('"memory"."analytics"."fct_order"');
  expect(prepared.deployment).toBe('separate-user-action');
  expect(prepared).not.toHaveProperty('requiresCompile');
});

it.each([false, true])('creates bound source plans and detaches absent models in either stage (%s)', async reversed => {
  const { domain, physical, logical, options, plan } = await setup();
  physical.models = physical.models.filter(m => m.name !== 'fct_order');
  physical.relationships = [];
  options.snapshot.models = options.snapshot.models.filter(m => m.name !== 'fct_order');
  options.snapshot.pendingModels = [{ name: 'fct_order', id: '"memory"."analytics"."new_order"', dialect: 'duckdb' }];
  delete options.preconditions['models/fct_order.sql'];
  const selection = { [modelKey('fct_order')]: 'logical' as const };
  const create = plan(selection, reversed);
  expect(create.models![0].action).toBe('add-to-physical');
  expect(create.absentPaths).toEqual(['models/fct_order.sql']);
  expect(create.modelContext.fct_order).toMatchObject({ modelId: '"memory"."analytics"."new_order"', kind: 'NEW' });
  expect(create.columns).toEqual([]);
  const remove = plan({ [modelKey('fct_order')]: 'physical' }, reversed);
  const patch = applySqlmeshLogicalPlan(remove, domain, physical);
  expect(patch.modelNames).toEqual(['dim_customer']);
  expect(patch.relationships).toEqual([]);
  expect(patch.models).toEqual([]); // Shared definitions are retained, not rewritten or deleted.
  expect(logical.models).toHaveLength(2);
  expect(domain.logical.models).toHaveLength(2);
});

it('requires explicit pending bindings, authoritative types and whole-model selections', async () => {
  const { physical, domain, options, plan } = await setup();
  physical.models = physical.models.filter(m => m.name !== 'fct_order'); physical.relationships = [];
  options.snapshot.models = options.snapshot.models.filter(m => m.name !== 'fct_order');
  const selection = { [modelKey('fct_order')]: 'logical' as const };
  expect(() => plan(selection)).toThrow('schema-qualified');
  options.snapshot.pendingModels = [{ name: 'fct_order', id: '"analytics"."new_order"', dialect: 'duckdb' }];
  expect(() => plan(selection)).toThrow('already exists');
  delete options.preconditions['models/fct_order.sql'];
  domain.logical.models.find(m => m.name === 'fct_order')!.columns![0].dataType = 'unknown';
  expect(() => plan(selection)).toThrow('authoritative column types');
  expect(() => plan({ [columnKey('fct_order', 'amount')]: 'logical' })).toThrow('whole model');
  expect(() => plan({ ...selection, [columnKey('fct_order', 'amount')]: 'physical' })).toThrow('same ground truth');
});

it('rejects existing, linked or escaped creation targets before launching an assistant', async () => {
  const { plan } = await setup();
  const p = { absentPaths: ['models/new_model.sql'] } as ReturnType<typeof plan>;
  assertSqlmeshCreationTargets(root, p);
  const file = path.join(root, p.absentPaths![0]);
  fs.symlinkSync('/missing-file', file);
  expect(() => assertSqlmeshCreationTargets(root, p)).toThrow('already exists');
  fs.unlinkSync(file);
  fs.rmSync(path.join(root, 'models'), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(root, 'models'));
  expect(() => assertSqlmeshCreationTargets(root, p)).toThrow('outside the project');
  p.absentPaths = ['../new_model.sql'];
  expect(() => assertSqlmeshCreationTargets(root, p)).toThrow('Unsafe');
});

it('adds observed columns with descriptions without inventing keys', async () => {
  const { domain, physical, logical, plan } = await setup();
  physical.models[0].columns.push({ name: 'new_col', dataType: 'TEXT', description: 'Source description', isPrimaryKey: false, isForeignKey: false });
  const prepared = plan({ [columnKey('dim_customer', 'new_col')]: 'physical' });
  const patch = applySqlmeshLogicalPlan(prepared, domain, physical);
  expect(patch.models[0].columns!.at(-1)).toEqual({ name: 'new_col', dataType: 'TEXT', description: 'Source description' });
  expect(compare(logical, physical).summary.missingColumns).toBe(1);
});

it('rejects an observed column outside the logical naming rules before producing a patch', async () => {
  const { domain, physical, plan } = await setup();
  physical.models[0].columns.push({ name: 'new:col', dataType: 'TEXT', description: '', isPrimaryKey: false, isForeignKey: false });
  const prepared = plan({ [columnKey('dim_customer', 'new:col')]: 'physical' });
  expect(() => applySqlmeshLogicalPlan(prepared, domain, physical)).toThrow('logical naming rules');
});

it('adds only selected audit-backed relationships and is idempotent', async () => {
  const { domain, physical, logical, plan } = await setup();
  logical.relationships = []; domain.logical.relationships = [];
  const r = physical.relationships[0];
  const prepared = plan({ [relationshipKey(r.fromModel, r.fromColumn, r.toModel, r.toColumn)]: 'physical' });
  const first = applySqlmeshLogicalPlan(prepared, domain, physical);
  expect(first.relationships).toEqual([r]);
  domain.logical.relationships = first.relationships;
  expect(applySqlmeshLogicalPlan(prepared, domain, physical).relationships).toEqual([r]);
});

it('rejects column removal that leaves a relationship dangling', async () => {
  const { domain, physical, plan } = await setup();
  physical.models.find(m => m.name === 'fct_order')!.columns = physical.models.find(m => m.name === 'fct_order')!.columns.filter(c => c.name !== 'customer_id');
  const prepared = plan({ [columnKey('fct_order', 'customer_id')]: 'physical' });
  expect(() => applySqlmeshLogicalPlan(prepared, domain, physical)).toThrow('endpoint');
});

it('generates native source context and blocks ambiguous, unknown-type, mixed and observed-source plans', async () => {
  const { logical, options, plan } = await setup();
  logical.models[0].columns[0].dataType = 'TEXT';
  const key = columnKey('dim_customer', logical.models[0].columns[0].name);
  const source = plan({ [key]: 'logical' });
  expect(source.direction).toBe('logical-to-source');
  expect(source.modelContext.dim_customer.sourcePath).toBe('models/dim_customer.sql');
  expect(source.instructions.join(' ')).toContain('Never run plan, apply');
  expect(() => plan({ ...{ [key]: 'logical' }, 'col:unknown:x': 'logical' })).toThrow('no longer match');
  logical.models[0].columns[1].dataType = 'INT';
  expect(() => plan({ [key]: 'logical', [columnKey('dim_customer', logical.models[0].columns[1].name)]: 'physical' })).toThrow('one sync direction');
  options.snapshot.warehouse = { environment: 'dev', observedAt: new Date().toISOString(), models: [] };
  expect(() => plan({ [key]: 'logical' })).toThrow('Refresh Project Metadata');
  options.snapshot.warehouse = null;
  options.snapshot.models.find(m => m.name === 'dim_customer')!.sourcePath = 'models/generated.py';
  expect(() => plan({ [key]: 'logical' })).toThrow('manual workflow');
});

it('detects changed exports, source or shared logical files and newly added domain files', async () => {
  const { logical, options, plan } = await setup();
  logical.models[0].columns[0].dataType = 'TEXT';
  const prepared = plan({ [columnKey('dim_customer', logical.models[0].columns[0].name)]: 'physical' });
  assertSqlmeshPlanCurrent(prepared, options.preconditions);
  for (const file of ['models/dim_customer.sql', '.erd-studio/logical-models/fct_order.yml', '.erd-studio/sqlmesh.json']) {
    const abs = path.join(root, file); const text = fs.readFileSync(abs);
    fs.appendFileSync(abs, '\n');
    expect(() => assertSqlmeshPlanCurrent(prepared, captureSqlmeshInputs(root, '.erd-studio', options.snapshot, domainPath))).toThrow('changed');
    fs.writeFileSync(abs, text);
  }
  fs.writeFileSync(path.join(root, '.erd-studio/silver/other.json'), '{}');
  expect(() => assertSqlmeshPlanCurrent(prepared, captureSqlmeshInputs(root, '.erd-studio', options.snapshot, domainPath))).toThrow('changed');
});
