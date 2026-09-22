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
import type { GroundTruth, ModelResolution, ColumnResolution, RelationshipResolution } from '../types/syncPlan';
import type { IdentifierFolding } from '../types/naming';
import { assertLogicalColumnMapping, findByIdentifier, logicalSpelling, sameIdentifier } from './identifierMatching';

/** How each physical model folds identifier case; exact where the export does not say. */
export function foldingByModel(physical: DisplayDomain): (modelName: string) => IdentifierFolding {
  const map = new Map(physical.models.map(m => [m.name, m.identifierFolding ?? 'exact' as const]));
  return name => map.get(name) ?? 'exact';
}

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
  modelContext: Record<string, { modelId: string; sourcePath: string | null; logicalModelPath: string; kind: string; dialect: string;
    columnNames?: Record<string, string> }>;
  columns: ColumnResolution[];
  models?: ModelResolution[];
  relationships: Array<RelationshipResolution & { resolvedCardinality?: Relationship['cardinality'] }>;
  /** Preimages include the export, source files, bindings and shared logical definitions. */
  preconditions: Record<string, string>;
  /** Creation targets must remain absent; the editor checks their parent paths too. */
  absentPaths?: string[];
  instructions: string[];
  /** Explicit source-only exporter invocation supplied by the installed editor. */
  refreshCommand?: { executable: string; args: string[] };
  deployment: 'separate-user-action';
}

export const SQLMESH_SYNC_INSTRUCTIONS = [
  'This is a native SQLMesh plan. Never execute it with a dbt action guide. Do not edit sqlmesh.json.',
  'Before editing, verify every preconditions SHA-256 against the current project bytes. Abort and regenerate on changed or missing files. Use the modelContext canonical modelId and sourcePath, never guessed basenames or physical snapshot names.',
  'modelContext.columnNames maps logical aliases to exact native column identifiers. Resolve selected column and relationship endpoints through that map before editing SQL or audits, preserving required quoting. Do not rename source columns to their logical aliases. If removing a bound column, remove its explicit column binding in sqlmesh-bindings.json in the same change, then refresh.',
  'metadata-to-logical plans are applied by the editor. For logical-to-source, edit only the selected native SQL MODEL definitions, SQL projections and audits. Preserve existing logic, grain, incremental kind, time columns, partitions and other audits.',
  'Whole-model add-to-physical actions create the modelContext sourcePath using its explicitly bound modelId and the referenced logical design. Verify every absentPaths target is absent and its parent resolves inside the project before writing; never overwrite an existing file. Ground all column expressions in project sources and design rationale. Choose kind/history behavior deliberately and ask if business logic is unknown. A remove-from-logical action detaches the model and its relationships from this domain; shared logical files remain in the library.',
  'Use each column resolvedDataType, not the stage-relative types. Adding a column needs a real expression grounded in the project; ask the user if the expression or backfill semantics cannot be determined. Never fabricate data or silently append NULL placeholders.',
  'Relationship actions mean erd_relationship(column := ..., to := qualified_model, field := ...) audits, with unfiltered unique_values or unique_combination_of_columns only when justified. The parent must be a dependency of the child: SQLMesh builds its DAG from the query, not from audits, so when the child query does not select from the parent add depends_on (qualified_model) to the child MODEL — otherwise the audit can run before the parent table exists and a fresh deployment fails. Do not turn grain, lineage or references into enforced keys. Review all consumers before changing shared uniqueness audits.',
  'Do not edit generated SQL, Python generators, seeds or external model definitions through this workflow. Those require a separate manual change. Preserve quoted identifiers and dialect syntax.',
  'After editing, invoke refreshCommand.executable with refreshCommand.args as separate arguments, from the project root. This is the installed source-only exporter using load_state=False: it loads/validates the project and refreshes inferred metadata without initializing SQLMesh state. Do not hand-edit sqlmesh.json. If refreshCommand is absent, ask the user to Refresh Project Metadata in ERD Studio. Compare the refreshed model columns/relationships with the selected resolutions and report any remaining differences.',
  'Do not use the sqlmesh render CLI or a default Context for validation: these can initialize or migrate warehouse state even without a deployment. Run unit tests only against a known disposable test connection. Preserve metadata.gateway/config and report validation performed; a source edit is not a warehouse deployment.',
  'Never run plan, apply, run, migrate, janitor, audit, evaluate, create_external_models or warehouse DDL as part of executing this plan. The user reviews and runs deployment separately.',
];

function safeFile(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) throw new Error('Unsafe sync input path.');
  const file = path.join(root, relative);
  const resolved = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (resolved.startsWith('..') || path.isAbsolute(resolved)) throw new Error('Sync input points outside the project.');
  return file;
}

export function assertSqlmeshCreationTargets(root: string, plan: SqlmeshSyncPlan): void {
  const realRoot = fs.realpathSync(root);
  for (const relative of plan.absentPaths ?? []) {
    if (!/^models\/[a-z][a-z0-9_]*\.sql$/.test(relative)) throw new Error('Unsafe SQLMesh model creation path.');
    const file = path.join(root, relative);
    try {
      fs.lstatSync(file);
      throw new Error(`Creation target ${relative} already exists. Choose a different model alias or create the source manually.`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let parent = realRoot;
    try {
      const parentPath = path.dirname(file);
      const stat = fs.lstatSync(parentPath);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error('SQLMesh model creation parent is not a directory.');
      try { parent = fs.realpathSync(parentPath); }
      catch { throw new Error('SQLMesh model creation parent is an unresolved link.'); }
      if (!fs.statSync(parent).isDirectory()) throw new Error('SQLMesh model creation parent is not a directory.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const rel = path.relative(realRoot, parent);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('SQLMesh model creation directory points outside the project.');
  }
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
  logical?: UnifiedDomain;
}): SqlmeshSyncPlan {
  const { report, selections, snapshot, domainPath, semanticDir, preconditions } = options;
  const columns: ColumnResolution[] = [];
  const models: ModelResolution[] = [];
  const absentPaths: string[] = [];
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
    const modelTruth = m.status !== 'matched' ? choose(modelKey(m.name)) : undefined;
    if (m.status !== 'matched' && modelTruth) {
      const logicalOnly = (report.sourceStage === 'logical') === (m.status === 'extra');
      const action = logicalOnly
        ? (modelTruth === 'logical' ? 'add-to-physical' : 'remove-from-logical')
        : (modelTruth === 'physical' ? 'add-to-logical' : 'remove-from-physical');
      if (!['add-to-physical', 'remove-from-logical'].includes(action)) throw new Error('Import existing models with Add Existing Model; source deletion requires a manual review of downstream consumers.');
      models.push({ modelName: m.name, discrepancyStatus: m.status, groundTruth: modelTruth, action });
    }
    for (const c of m.columns) {
      if (c.status === 'matched') continue;
      const truth = choose(columnKey(m.name, c.name));
      if (!truth) continue;
      if (modelTruth) {
        if (truth !== modelTruth) throw new Error('Choose the same ground truth for a whole model and its columns.');
        continue;
      }
      if (m.status !== 'matched') throw new Error('Select the whole model before syncing its columns.');
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
    if (models.some(m => m.action === 'remove-from-logical' && [r.fromModel, r.toModel].includes(m.modelName))) continue;
    relationships.push({ fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn,
      discrepancyStatus: r.status, groundTruth: truth, action: deriveRelationshipAction(r.status, truth, report.sourceStage)!,
      sourceCardinality: r.sourceCardinality, targetCardinality: r.targetCardinality,
      resolvedCardinality: truth === report.sourceStage ? r.sourceCardinality : r.targetCardinality });
  }
  if (Object.keys(selections).some(key => !keys.has(key))) throw new Error('Selections no longer match the comparison. Compare again.');
  if (!models.length && !columns.length && !relationships.length) throw new Error('No actionable resolutions selected.');
  if (choices.size !== 1) throw new Error('Use one sync direction per plan. Apply Physical selections to the logical design first, then prepare Logical selections for source edits.');
  const direction = choices.has('physical') ? 'metadata-to-logical' : 'logical-to-source';
  if (direction === 'logical-to-source' && snapshot.warehouse) throw new Error('Refresh Project Metadata before planning source edits. Warehouse differences must not be mistaken for source differences.');
  const names = new Set([...models.filter(m => m.action === 'add-to-physical').map(m => m.modelName),
    ...columns.map(c => c.modelName), ...relationships.flatMap(r => [r.fromModel, r.toModel])]);
  const modelContext: SqlmeshSyncPlan['modelContext'] = {};
  for (const name of names) {
    const m = snapshot.models.find(model => model.name === name);
    if (!m && models.some(m => m.modelName === name && m.action === 'add-to-physical')) {
      const pending = snapshot.pendingModels?.find(m => m.name === name);
      if (!pending) throw new Error(`Add a schema-qualified model binding for ${name} in sqlmesh-bindings.json and refresh before creating source.`);
      const logical = options.logical?.logical.models.find(m => m.name === name);
      if (!logical?.columns?.length) throw new Error(`Define columns and design intent for ${name} before creating native source.`);
      assertLogicalColumnMapping(name, logical.columns, 'exact');
      if (logical.columns.some(c => !c.dataType?.trim() || /^(unknown|null)$/i.test(c.dataType.trim()))) {
        throw new Error(`Declare authoritative column types for ${name} before creating native source.`);
      }
      const sourcePath = `models/${name}.sql`;
      if (preconditions[sourcePath]) throw new Error(`Creation target ${sourcePath} already exists.`);
      absentPaths.push(sourcePath);
      modelContext[name] = { modelId: pending.id, sourcePath, kind: 'NEW', dialect: pending.dialect,
        logicalModelPath: `${semanticDir}/logical-models/${name}.yml` };
      continue;
    }
    if (!m) throw new Error(`Missing SQLMesh binding for ${name}. Refresh metadata after binding this model.`);
    assertLogicalColumnMapping(name, m.columns, m.identifierFolding ?? 'exact', m.columnBindings);
    const observed = snapshot.warehouse?.models.find(model => model.id === m.id);
    if (observed?.status === 'observed') assertLogicalColumnMapping(name, observed.columns, m.identifierFolding ?? 'exact', m.columnBindings);
    if (direction === 'logical-to-source' && (!m.sourcePath?.endsWith('.sql') || ['SEED', 'EXTERNAL', 'EMBEDDED'].includes(m.kind))) {
      throw new Error(`Source edits for ${name} (${m.kind}) need a manual workflow; this sync supports SQL model files.`);
    }
    modelContext[name] = { modelId: m.id, sourcePath: m.sourcePath, kind: m.kind, dialect: m.dialect,
      columnNames: Object.fromEntries(m.columns.map(c => [logicalSpelling(c.name, m.identifierFolding ?? 'exact', m.columnBindings), c.name])),
      logicalModelPath: `${semanticDir}/logical-models/${name}.yml` };
  }
  return { schemaVersion: 1, provider: 'sqlmesh', id: randomUUID(), generatedAt: new Date().toISOString(),
    domain: report.domain, layer: report.layer, domainPath, direction, sourceStage: report.sourceStage,
    metadata: { generatedAt: snapshot.generatedAt, sqlmeshVersion: snapshot.sqlmeshVersion, gateway: snapshot.gateway, config: snapshot.config,
      environment: snapshot.warehouse?.environment ?? null, observedAt: snapshot.warehouse?.observedAt ?? null },
    modelContext, columns, relationships, ...(models.length ? { models } : {}), ...(absentPaths.length ? { absentPaths } : {}),
    preconditions, instructions: SQLMESH_SYNC_INSTRUCTIONS, deployment: 'separate-user-action' };
}

/**
 * Returns a patch; the editor writes it through one comment-preserving WorkspaceEdit.
 *
 * Column names in the plan are the comparison's raw spellings — the export's
 * when the physical stage was the source (`CUSTOMER_ID` on Snowflake). They are
 * resolved against the logical design by each model's identifier folding, and
 * anything written into the design takes its logical spelling.
 */
export function applySqlmeshLogicalPlan(plan: SqlmeshSyncPlan, domain: UnifiedDomain, physical: DisplayDomain): {
  models: SemanticModel[]; relationships: Relationship[]; modelNames?: string[];
} {
  if (plan.direction !== 'metadata-to-logical') throw new Error('This plan requires assisted source edits.');
  const foldingOf = foldingByModel(physical);
  // Validate before producing any patch, including when applying a previously
  // reviewed plan or when only a relationship is selected.
  const affected = new Set([...plan.columns.map(c => c.modelName),
    ...plan.relationships.flatMap(r => [r.fromModel, r.toModel])]);
  for (const name of affected) {
    assertLogicalColumnMapping(name, physical.models.find(m => m.name === name)?.columns ?? [], foldingOf(name));
    assertLogicalColumnMapping(name, domain.logical.models.find(m => m.name === name)?.columns ?? [], 'exact');
  }
  const removed = new Set((plan.models ?? []).map(m => {
    if (m.action !== 'remove-from-logical') throw new Error('Unsupported whole-model logical action.');
    return m.modelName;
  }));
  const models = structuredClone(domain.logical.models).filter(m => !removed.has(m.name));
  const changed = new Set<string>();
  let relationships = structuredClone(domain.logical.relationships).filter(r => !removed.has(r.fromModel) && !removed.has(r.toModel));
  for (const c of plan.columns) {
    const m = models.find(m => m.name === c.modelName);
    if (!m) throw new Error(`Logical model ${c.modelName} is unavailable.`);
    const folding = foldingOf(c.modelName);
    const cols = m.columns ?? (m.columns = []);
    const existing = findByIdentifier(cols, c.columnName, folding);
    const source = findByIdentifier(physical.models.find(m => m.name === c.modelName)?.columns ?? [], c.columnName, folding);
    if (c.action === 'add-column-to-logical') {
      if (!source || !c.resolvedDataType) throw new Error('Column metadata is unavailable.');
      if (!existing) cols.push({ name: logicalSpelling(source.name, folding), dataType: c.resolvedDataType, description: source.description });
    } else if (c.action === 'remove-column-from-logical') {
      m.columns = cols.filter(col => !sameIdentifier(col.name, c.columnName, folding));
    } else if (c.action === 'update-type-in-logical') {
      if (!existing || !c.resolvedDataType) throw new Error(`Column ${c.modelName}.${c.columnName} is no longer in the logical design. Compare again.`);
      existing.dataType = c.resolvedDataType;
    } else throw new Error(`Unsupported logical action: ${c.action}`);
    changed.add(m.name);
  }
  const same = (a: Relationship, b: RelationshipResolution) => a.fromModel === b.fromModel && a.toModel === b.toModel
    && sameIdentifier(a.fromColumn, b.fromColumn, foldingOf(a.fromModel)) && sameIdentifier(a.toColumn, b.toColumn, foldingOf(a.toModel));
  for (const r of plan.relationships) {
    const existing = relationships.find(rel => same(rel, r));
    if (r.action === 'remove-relationship-from-logical') relationships = relationships.filter(rel => !same(rel, r));
    else if (r.action === 'add-relationship-to-logical' && r.resolvedCardinality) {
      if (!existing) relationships.push({ fromModel: r.fromModel, fromColumn: logicalSpelling(r.fromColumn, foldingOf(r.fromModel)),
        toModel: r.toModel, toColumn: logicalSpelling(r.toColumn, foldingOf(r.toModel)), cardinality: r.resolvedCardinality });
    } else if (r.action === 'update-cardinality-in-logical' && existing && r.resolvedCardinality) existing.cardinality = r.resolvedCardinality;
    else throw new Error(`Unsupported logical action: ${r.action}`);
  }
  for (const r of relationships) {
    const has = (name: string, col: string) => !!findByIdentifier(models.find(m => m.name === name)?.columns ?? [], col, foldingOf(name));
    if (!has(r.fromModel, r.fromColumn) || !has(r.toModel, r.toColumn)) throw new Error('A selected column removal leaves a relationship without an endpoint. Select that relationship for removal too.');
  }
  return { models: models.filter(m => changed.has(m.name)), relationships,
    ...(removed.size ? { modelNames: models.map(m => m.name) } : {}) };
}
