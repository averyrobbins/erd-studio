import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { relationshipPairs, relationshipColumns, relationshipIdentity, validRelationshipColumns, renameRelationshipColumn } from '../../src/types/relationships';
import { relationshipKey } from '../../src/types/syncPlan';
import { derivePhysicalRelationships, relationshipReferencesColumn } from '../../src/services/domainService';
import { compare } from '../../src/services/discrepancyService';
import { extractManifestData } from '../../src/workers/manifestExtractor';
import { YmlParserService } from '../../src/services/ymlParserService';
import { transformDomain } from '../../webview/lib/graphTransformer';
import type { DisplayDomain, DisplayRelationship } from '../../src/types/display';

const pairs = [{ fromColumn: 'a', toColumn: 'x' }, { fromColumn: 'b', toColumn: 'y' }];
const rel: DisplayRelationship = { fromModel: 'child', toModel: 'parent', ...relationshipColumns(pairs), cardinality: 'many-to-one' };
const single: DisplayRelationship = { fromModel: 'child', toModel: 'parent', fromColumn: 'a', toColumn: 'x', cardinality: 'many-to-one' };
const variant = { ...rel, columnPairs: [pairs[0], { fromColumn: 'c', toColumn: 'z' }] };
const domain = (relationships: DisplayRelationship[]): DisplayDomain => ({ schemaVersion: 5, domain: 'tuple', layer: 'silver', stage: 'logical',
  readOnly: false, positionDraggable: true, relationships, viewConfig: {},
  models: ['child', 'parent'].map(name => ({ name, columns: ['a','b','c','x','y','z'].map(name => ({ name, dataType: 'INT', isPrimaryKey: false, isForeignKey: false })) })),
});
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })));

describe('ordered tuple identity', () => {
  it('keeps legacy singles and distinguishes tuples sharing an anchor', () => {
    expect(relationshipPairs(single)).toEqual([pairs[0]]);
    expect(new Set([single, rel, variant].map(r => relationshipIdentity(r))).size).toBe(3);
    expect(new Set([single, rel, variant].map(r => relationshipKey(r.fromModel,r.fromColumn,r.toModel,r.toColumn,r.columnPairs))).size).toBe(3);
    const graph = transformDomain(domain([single, rel, variant]));
    expect(new Set(graph.edges.map(e => e.id)).size).toBe(3);
    expect(graph.edges[1].data).toMatchObject({ columnPairs: pairs });
  });
  it.each([[], [pairs[0]], [pairs[0], pairs[0]], [pairs[0], { fromColumn: '', toColumn: 'y' }],
    [pairs[0], { fromColumn: 'b', toColumn: 'x' }], [null, pairs[1]]].map(columnPairs => ({ columnPairs })))('refuses malformed tuples without falling back to the anchor: %j', ({ columnPairs }) => {
    expect(validRelationshipColumns({ ...single, columnPairs })).toBe(false);
  });
  it('requires anchors to match the first pair and cascades non-anchor renames', () => {
    expect(validRelationshipColumns({ ...rel, fromColumn: 'wrong' })).toBe(false);
    const changed = structuredClone(rel);
    renameRelationshipColumn(changed, 'child', 'b', 'renamed');
    expect(changed.columnPairs![1].fromColumn).toBe('renamed');
    expect(relationshipReferencesColumn(changed, 'child', 'renamed')).toBe(true);
    expect(relationshipReferencesColumn(changed, 'parent', 'y')).toBe(true);
    renameRelationshipColumn(changed, 'parent', 'x', 'anchor');
    expect(changed.toColumn).toBe('anchor');
    expect(changed.columnPairs![0].toColumn).toBe('anchor');
  });
  it.each([false, true])('compares the whole tuple, including cardinality and secondary columns (%s)', reverse => {
    const source = domain([rel, single]), target = { ...domain([variant, single]), stage: 'physical' as const };
    const report = reverse ? compare(target, source) : compare(source, target);
    expect(report.relationships.map(r => r.status).sort()).toEqual(['extra', 'matched', 'missing']);
    expect(report.relationships.filter(r => r.columnPairs)).toHaveLength(2);
    const matching = compare(source, { ...target, relationships: [{ ...rel, cardinality: 'one-to-one' }, single] });
    expect(matching.relationships.find(r => r.columnPairs)).toMatchObject({ status: 'cardinality-mismatch', columnPairs: pairs });
  });
  it('uses only keys contained in the declared tuple for cardinality', () => {
    const result = derivePhysicalRelationships([rel, single], new Set(['child','parent']), new Map(), new Map([['parent', [['x','y']]]]));
    expect(result.map(r => r.cardinality)).toEqual(['many-to-one','many-to-many']);
    expect(result[0].columnPairs).toEqual(pairs);
  });
});

describe('dbt tuple declarations', () => {
  it.each([true, false])('extracts exactly one tuple from model-level YAML (nested arguments: %s)', nested => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbt-tuple-')); dirs.push(root);
    fs.mkdirSync(path.join(root, 'models'));
    fs.writeFileSync(path.join(root,'dbt_project.yml'), 'name: tuple\nmodel-paths: [models]\n');
    const kwargs = { to: "ref('parent')", from_columns: ['a','b'], to_columns: ['x','y'] };
    // JSON is valid YAML and preserves the same modern/legacy test AST shape.
    fs.writeFileSync(path.join(root,'models/schema.yml'), JSON.stringify({ version: 2, models: [{ name: 'child', data_tests: [
      { erd_relationship_tuple: nested ? { arguments: kwargs } : kwargs },
      { erd_relationship_tuple: { ...kwargs, to_columns: ['x'] } },
    ] }] }));
    return new YmlParserService().loadYmlData(root).then(data => {
      expect(data.relationshipTests).toEqual([{ fromModel: 'child', toModel: 'parent', ...relationshipColumns(pairs) }]);
    });
  });
  it('extracts manifest tuples and rejects malformed widths instead of guessing independent edges', () => {
    const node = (from_columns: unknown, to_columns: unknown) => ({ attached_node: 'model.p.child',
      test_metadata: { name: 'erd_relationship_tuple', kwargs: { from_columns, to_columns, to: "ref('parent')" } } });
    const result = extractManifestData({ nodes: {
      'model.p.child': { name: 'child', unique_id: 'model.p.child' },
      'test.p.tuple': node(['a','b'], ['x','y']), 'test.p.bad': node(['a','b'], ['x']),
      'test.p.duplicate': node(['a','a'], ['x','y']),
    } });
    expect(result.relationshipTests).toEqual([{ fromModel: 'child', toModel: 'parent', ...relationshipColumns(pairs) }]);
  });
});

it('maps every SQLMesh tuple component through column bindings and validates non-anchor endpoints', async () => {
  const { SqlmeshProjectAdapter, parseSqlmeshSnapshot } = await import('../../src/services/sqlmeshAdapter');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-native-tuple-')); dirs.push(root);
  fs.cpSync(path.resolve(__dirname, '../fixtures/sqlmesh-project'), root, { recursive: true });
  const file = path.join(root, '.erd-studio/sqlmesh.json');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')); delete snapshot.integrity;
  const child = snapshot.models.find((m: any) => m.name === 'fct_order');
  const parent = snapshot.models.find((m: any) => m.name === 'dim_customer');
  child.columnBindings = { customer_key: 'customer_id', total: 'amount' };
  parent.columnBindings = { parent_key: 'customer_id', label: 'name' };
  parent.uniqueKeys = [['customer_id', 'name']];
  snapshot.relationships = [{ ...snapshot.relationships[0], audit: 'erd_relationship_tuple', columnPairs: [
    { fromColumn: 'customer_id', toColumn: 'customer_id' }, { fromColumn: 'amount', toColumn: 'name' },
  ] }];
  fs.writeFileSync(file, JSON.stringify(snapshot));
  const adapter = new SqlmeshProjectAdapter(root);
  const data = await adapter.load();
  const expected = [{ fromColumn: 'customer_key', toColumn: 'parent_key' }, { fromColumn: 'total', toColumn: 'label' }];
  expect(data.manifest.relationshipTests[0].columnPairs).toEqual(expected);
  expect(adapter.relationshipCardinality('fct_order','customer_key','dim_customer','parent_key',expected)).toBe('many-to-one');
  expect(adapter.relationshipCardinality('fct_order','customer_key','dim_customer','parent_key')).toBe('many-to-many');
  const { DomainService } = await import('../../src/services/domainService');
  const { LayerService } = await import('../../src/services/layerService');
  const { LogicalModelService } = await import('../../src/services/logicalModelService');
  const domains = new DomainService(new LayerService(root)); domains.setLogicalModelService(new LogicalModelService(root));
  const physical = adapter.buildPhysical(domains.getDomain(path.join(root, '.erd-studio/silver/orders.json')), data);
  expect(physical.relationships[0]).toMatchObject({ columnPairs: expected, cardinality: 'many-to-one' });
  expect(physical.models.find(m => m.name === 'fct_order')!.columns.find(c => c.name === 'total')!.isForeignKey).toBe(true);
  const missingTuple = structuredClone(snapshot); delete missingTuple.relationships[0].columnPairs;
  expect(() => parseSqlmeshSnapshot(JSON.stringify(missingTuple))).toThrow('endpoints');
  snapshot.relationships[0].columnPairs[1].toColumn = 'missing';
  expect(() => parseSqlmeshSnapshot(JSON.stringify(snapshot))).toThrow('endpoints');
});
