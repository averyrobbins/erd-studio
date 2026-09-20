/** Native SQLMesh reconciliation: deterministic logical edits, reviewable source-edit plans. */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { DiscrepancyReport } from '../types/discrepancy';
import type { DisplayDomain } from '../types/display';
import type { SqlmeshSnapshot } from '../types/project';
import type { UnifiedDomain, Relationship, SemanticModel } from '../types/semantic';
import { columnKey, modelKey, relationshipKey, deriveColumnAction, deriveRelationshipAction,
  resolveGroundTruthDataType } from '../types/syncPlan';
import type { GroundTruth, ColumnResolution, RelationshipResolution } from '../types/syncPlan';

export interface SqlmeshSyncPlan {
  schemaVersion: 1;
  provider: 'sqlmesh';
  id: string;
  generatedAt: string;
  domain: string;
  layer: string;
  domainPath: string;
  direction: 'metadata-to-logical' | 'logical-to-source';
  sourceStage: 'logical' | 'physical';
  metadata: { generatedAt: string; sqlmeshVersion: string; gateway: string | null; config: string | null; environment: string | null; observedAt: string | null };
  modelContext: Record<string, { modelId: string; sourcePath: string | null; logicalModelPath: string; kind: string; dialect: string }>;
  columns: ColumnResolution[];
  relationships: Array<RelationshipResolution & { resolvedCardinality?: Relationship['cardinality'] }>;
  /** Preimages include the export, source files, bindings and shared logical definitions. */
  preconditions: Record<string, string>;
  instructions: string[];
  deployment: 'separate-user-action';
}

export const SQLMESH_SYNC_INSTRUCTIONS = [
  'This is a native SQLMesh plan. Never execute it with a dbt action guide. Do not edit sqlmesh.json.',
  'Before editing, verify every preconditions SHA-256 against the current project bytes. Abort and regenerate on changed or missing files. Use the modelContext canonical modelId and sourcePath, never guessed basenames or physical snapshot names.',
  'metadata-to-logical plans are applied by the editor. For logical-to-source, edit only the selected native SQL MODEL definitions, SQL projections and audits. Preserve existing logic, grain, incremental kind, time columns, partitions and other audits.',
  'Use each column resolvedDataType, not the stage-relative types. Adding a column needs a real expression grounded in the project; ask the user if the expression or backfill semantics cannot be determined. Never fabricate data or silently append NULL placeholders.',
  'Relationship actions mean erd_relationship(column := ..., to := qualified_model, field := ...) audits, with unfiltered unique_values or unique_combination_of_columns only when justified. The parent must be a dependency of the child: SQLMesh builds its DAG from the query, not from audits, so when the child query does not select from the parent add depends_on (qualified_model) to the child MODEL — otherwise the audit can run before the parent table exists and a fresh deployment fails. Do not turn grain, lineage or references into enforced keys. Review all consumers before changing shared uniqueness audits.',
  'Do not edit generated SQL, Python generators, seeds or external model definitions through this workflow. Those require a separate manual change. Preserve quoted identifiers and dialect syntax.',
  'Validate with the project Python environment and metadata.gateway/config: SQLMesh load/render, lint and unit tests where configured. Refresh Project Metadata in ERD Studio, then compare again. Report unresolved differences and tests performed; a source edit is not a warehouse deployment.',
  'Never run plan, apply, run, migrate, janitor, audit, evaluate, create_external_models or warehouse DDL as part of executing this plan. The user reviews and runs deployment separately.',
];

function safeFile(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) throw new Error('Unsafe sync input path.');
  const file = path.join(root, relative);
  const resolved = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (resolved.startsWith('..') || path.isAbsolute(resolved)) throw new Error('Sync input points outside the project.');
  return file;
}

export function captureSqlmeshInputs(root: string, semanticDir: string, snapshot: SqlmeshSnapshot, domainPath: string): Record<string, string> {
  const files = new Set([...Object.keys(snapshot.inputs), domainPath, `${semanticDir}/sqlmesh.json`]);
  const visit = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (/\.(json|ya?ml)$/.test(entry.name) && entry.name !== '.sync-plan.json') files.add(file);
    }
  };
  visit(semanticDir);
  return Object.fromEntries([...files].sort().map(file => [file, createHash('sha256').update(fs.readFileSync(safeFile(root, file))).digest('hex')]));
}

export function assertSqlmeshPlanCurrent(plan: SqlmeshSyncPlan, current: Record<string, string>): void {
  if (JSON.stringify(plan.preconditions) !== JSON.stringify(current)) throw new Error('The project or logical design changed after this plan was prepared. Compare again and regenerate the plan.');
}

export function buildSqlmeshSyncPlan(options: {
  report: DiscrepancyReport; selections: Record<string, GroundTruth>; snapshot: SqlmeshSnapshot;
  domainPath: string; semanticDir: string; preconditions: Record<string, string>;
}): SqlmeshSyncPlan {
  const { report, selections, snapshot, domainPath, semanticDir, preconditions } = options;
  const columns: ColumnResolution[] = [];
  const relationships: SqlmeshSyncPlan['relationships'] = [];
  const choices = new Set<GroundTruth>();
  const keys = new Set<string>();
  const choose = (key: string) => {
    if (keys.has(key)) throw new Error('Ambiguous identifiers in sync selections. Rename the conflicting identifiers before syncing.');
    keys.add(key);
    const value = selections[key];
    if (value !== undefined && value !== 'logical' && value !== 'physical') throw new Error('Invalid ground truth selection.');
    if (value) choices.add(value);
    return value;
  };
  for (const m of report.models) {
    if (m.status !== 'matched' && choose(modelKey(m.name))) throw new Error('Model creation/removal is not supported by native sync yet. Add or bind the model first.');
    for (const c of m.columns) {
      if (c.status === 'matched') continue;
      const truth = choose(columnKey(m.name, c.name));
      if (!truth) continue;
      const action = deriveColumnAction(c.status, truth, report.sourceStage)!;
      const resolvedDataType = resolveGroundTruthDataType(truth, report.sourceStage, c.sourceDataType, c.targetDataType);
      if (!action.startsWith('remove-') && !resolvedDataType) throw new Error(`No authoritative type for ${m.name}.${c.name}. Declare or inspect its type before syncing.`);
      columns.push({ modelName: m.name, columnName: c.name, discrepancyStatus: c.status, groundTruth: truth,
        action, sourceDataType: c.sourceDataType, targetDataType: c.targetDataType, resolvedDataType });
    }
  }
  for (const r of report.relationships) {
    if (r.status === 'matched') continue;
    const truth = choose(relationshipKey(r.fromModel, r.fromColumn, r.toModel, r.toColumn));
    if (!truth) continue;
    relationships.push({ fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn,
      discrepancyStatus: r.status, groundTruth: truth, action: deriveRelationshipAction(r.status, truth, report.sourceStage)!,
      sourceCardinality: r.sourceCardinality, targetCardinality: r.targetCardinality,
      resolvedCardinality: truth === report.sourceStage ? r.sourceCardinality : r.targetCardinality });
  }
  if (Object.keys(selections).some(key => !keys.has(key))) throw new Error('Selections no longer match the comparison. Compare again.');
  if (!columns.length && !relationships.length) throw new Error('No actionable resolutions selected.');
  if (choices.size !== 1) throw new Error('Use one sync direction per plan. Apply Physical selections to the logical design first, then prepare Logical selections for source edits.');
  const direction = choices.has('physical') ? 'metadata-to-logical' : 'logical-to-source';
  if (direction === 'logical-to-source' && snapshot.warehouse) throw new Error('Refresh Project Metadata before planning source edits. Warehouse differences must not be mistaken for source differences.');
  const names = new Set([...columns.map(c => c.modelName), ...relationships.flatMap(r => [r.fromModel, r.toModel])]);
  const modelContext: SqlmeshSyncPlan['modelContext'] = {};
  for (const name of names) {
    const m = snapshot.models.find(model => model.name === name);
    if (!m) throw new Error(`Missing SQLMesh binding for ${name}. Refresh metadata after binding this model.`);
    if (direction === 'logical-to-source' && (!m.sourcePath?.endsWith('.sql') || ['SEED', 'EXTERNAL', 'EMBEDDED'].includes(m.kind))) {
      throw new Error(`Source edits for ${name} (${m.kind}) need a manual workflow; this sync supports SQL model files.`);
    }
    modelContext[name] = { modelId: m.id, sourcePath: m.sourcePath, kind: m.kind, dialect: m.dialect,
      logicalModelPath: `${semanticDir}/logical-models/${name}.yml` };
  }
  return { schemaVersion: 1, provider: 'sqlmesh', id: randomUUID(), generatedAt: new Date().toISOString(),
    domain: report.domain, layer: report.layer, domainPath, direction, sourceStage: report.sourceStage,
    metadata: { generatedAt: snapshot.generatedAt, sqlmeshVersion: snapshot.sqlmeshVersion, gateway: snapshot.gateway, config: snapshot.config,
      environment: snapshot.warehouse?.environment ?? null, observedAt: snapshot.warehouse?.observedAt ?? null },
    modelContext, columns, relationships, preconditions, instructions: SQLMESH_SYNC_INSTRUCTIONS, deployment: 'separate-user-action' };
}

/** Returns a patch; the editor writes it through one comment-preserving WorkspaceEdit. */
export function applySqlmeshLogicalPlan(plan: SqlmeshSyncPlan, domain: UnifiedDomain, physical: DisplayDomain): {
  models: SemanticModel[]; relationships: Relationship[];
} {
  if (plan.direction !== 'metadata-to-logical') throw new Error('This plan requires assisted source edits.');
  const models = structuredClone(domain.logical.models);
  const changed = new Set<string>();
  let relationships = structuredClone(domain.logical.relationships);
  for (const c of plan.columns) {
    const m = models.find(m => m.name === c.modelName);
    if (!m) throw new Error(`Logical model ${c.modelName} is unavailable.`);
    const cols = m.columns ?? (m.columns = []);
    const existing = cols.find(col => col.name === c.columnName);
    const source = physical.models.find(m => m.name === c.modelName)?.columns.find(col => col.name === c.columnName);
    if (c.action === 'add-column-to-logical') {
      if (!source || !c.resolvedDataType) throw new Error('Column metadata is unavailable.');
      if (!existing) cols.push({ name: c.columnName, dataType: c.resolvedDataType, description: source.description });
    } else if (c.action === 'remove-column-from-logical') {
      m.columns = cols.filter(col => col.name !== c.columnName);
    } else if (c.action === 'update-type-in-logical' && existing && c.resolvedDataType) existing.dataType = c.resolvedDataType;
    else throw new Error(`Unsupported logical action: ${c.action}`);
    changed.add(m.name);
  }
  const same = (a: Relationship, b: RelationshipResolution) => a.fromModel === b.fromModel && a.fromColumn === b.fromColumn && a.toModel === b.toModel && a.toColumn === b.toColumn;
  for (const r of plan.relationships) {
    const existing = relationships.find(rel => same(rel, r));
    if (r.action === 'remove-relationship-from-logical') relationships = relationships.filter(rel => !same(rel, r));
    else if (r.action === 'add-relationship-to-logical' && r.resolvedCardinality) {
      if (!existing) relationships.push({ fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn, cardinality: r.resolvedCardinality });
    } else if (r.action === 'update-cardinality-in-logical' && existing && r.resolvedCardinality) existing.cardinality = r.resolvedCardinality;
    else throw new Error(`Unsupported logical action: ${r.action}`);
  }
  for (const r of relationships) {
    const has = (name: string, col: string) => models.find(m => m.name === name)?.columns?.some(c => c.name === col);
    if (!has(r.fromModel, r.fromColumn) || !has(r.toModel, r.toColumn)) throw new Error('A selected column removal leaves a relationship without an endpoint. Select that relationship for removal too.');
  }
  return { models: models.filter(m => changed.has(m.name)), relationships };
}
