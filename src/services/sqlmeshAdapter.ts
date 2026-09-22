import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { SqlmeshSnapshot, ProjectModel } from '../types/project';
import type { ManifestData } from '../types/manifest';
import type { DisplayDomain, ExistingModelPreview } from '../types/display';
import type { SemanticModel, UnifiedDomain } from '../types/semantic';
import type { IdentifierFolding } from '../types/naming';
import type { ProjectAdapter, ProjectMetadata } from './projectAdapter';
import { assertLogicalColumnMapping, findByIdentifier, logicalSpelling, matchIdentifiers } from './identifierMatching';

const MAX_BYTES = 32 * 1024 * 1024;
const aliasPattern = /^[a-z][a-z0-9_]*$/;
const FOLDINGS: readonly IdentifierFolding[] = ['lower', 'upper', 'exact'];
/** Exports written before `identifierFolding` existed are matched exactly, as they always were. */
const foldingOf = (m: ProjectModel): IdentifierFolding => m.identifierFolding ?? 'exact';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const relative = (p: string) => !!p && !path.isAbsolute(p) && !p.includes('\\') && !p.split('/').includes('..') && !p.includes('\0');

/**
 * The byte-stable form both the exporter and the editor hash: sorted keys, no
 * whitespace, every character outside printable ASCII as a lowercase `\uXXXX`
 * escape (per UTF-16 code unit, which is what Python's `ensure_ascii` emits for
 * astral characters too). Mirror of `canonical_json` in
 * `integrations/sqlmesh/export.py`; the two must stay byte-identical.
 */
export function canonicalJson(value: unknown): string {
  // Python's sort_keys orders by code point; a plain JS sort orders by UTF-16
  // code unit, which differs once an astral character meets U+E000–U+FFFF.
  const byCodePoint = (a: string, b: string): number => {
    const x = [...a], y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
      if (d) return d;
    }
    return x.length - y.length;
  };
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : object(v) ? Object.fromEntries(Object.keys(v).sort(byCodePoint).map(k => [k, sorted(v[k])])) : v;
  return JSON.stringify(sorted(value)).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** `sha256:<hex>` of everything in the snapshot but `integrity`, as the exporter stamps it. */
export function snapshotIntegrity(snapshot: Record<string, unknown>): string {
  const { integrity: _ignored, ...body } = snapshot;
  return 'sha256:' + createHash('sha256').update(canonicalJson(body), 'ascii').digest('hex');
}

export function parseSqlmeshSnapshot(raw: string): SqlmeshSnapshot {
  const s: unknown = JSON.parse(raw);
  // Verified before anything else: a tampered artifact must be refused even if
  // the edit happens to be well-formed. Exports from before the stamp existed
  // carry no `integrity` and are accepted as they always were.
  if (object(s) && s.integrity !== undefined) {
    if (typeof s.integrity !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(s.integrity) || s.integrity !== snapshotIntegrity(s)) {
      throw new Error('SQLMesh metadata was modified after export (integrity check failed). Do not edit sqlmesh.json; run Refresh Project Metadata.');
    }
  }
  if (!object(s) || ![1, 2].includes(s.schemaVersion as number) || s.provider !== 'sqlmesh'
    || typeof s.generatedAt !== 'string' || !Number.isFinite(Date.parse(s.generatedAt))
    || typeof s.sqlmeshVersion !== 'string' || ![null, 'string'].includes(s.gateway === null ? null : typeof s.gateway)
    || ![null, 'string'].includes(s.config === null ? null : typeof s.config)
    || !Array.isArray(s.models) || !Array.isArray(s.relationships) || !strings(s.diagnostics) || !object(s.inputs)) {
    throw new Error('Unsupported or malformed SQLMesh metadata. Re-export with the ERD Studio exporter.');
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const m of s.models) {
    if (!object(m) || !['id', 'name', 'schema', 'description', 'kind', 'dialect'].every(k => typeof m[k] === 'string')
      || !m.id || !aliasPattern.test(m.name as string) || ids.has(m.id as string) || names.has(m.name as string)
      || !(m.sourcePath === null || (typeof m.sourcePath === 'string' && relative(m.sourcePath)))
      || !['declared', 'inferred'].includes(m.columnSource as string) || typeof m.columnsKnown !== 'boolean'
      || !(m.identifierFolding === undefined || FOLDINGS.includes(m.identifierFolding as IdentifierFolding))
      || !Array.isArray(m.columns) || !Array.isArray(m.uniqueKeys)) throw new Error('Invalid or duplicate SQLMesh model.');
    const cols = new Set<string>();
    for (const c of m.columns) {
      if (!object(c) || typeof c.name !== 'string' || !c.name || cols.has(c.name)
        || !(c.dataType === null || typeof c.dataType === 'string') || typeof c.description !== 'string') {
        throw new Error(`Invalid columns for ${m.name}`);
      }
      cols.add(c.name);
    }
    if (!m.uniqueKeys.every(k => strings(k) && k.length > 0 && k.every(c => cols.has(c)))) {
      throw new Error(`Invalid uniqueness evidence for ${m.name}`);
    }
    ids.add(m.id as string); names.add(m.name as string);
  }
  const models = new Map((s.models as unknown as ProjectModel[]).map(m => [m.id, m]));
  for (const r of s.relationships) {
    if (!object(r) || !['fromId', 'fromColumn', 'toId', 'toColumn', 'audit'].every(k => typeof r[k] === 'string')
      || !models.get(r.fromId as string)?.columns.some(c => c.name === r.fromColumn)
      || !models.get(r.toId as string)?.columns.some(c => c.name === r.toColumn)) throw new Error('Invalid SQLMesh relationship endpoints.');
  }
  for (const [file, hash] of Object.entries(s.inputs)) {
    if (!relative(file) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid SQLMesh input fingerprint.');
  }
  if (s.warehouse != null) {
    const w = s.warehouse;
    if (s.schemaVersion !== 2 || !object(w) || typeof w.environment !== 'string' || !w.environment
      || typeof w.observedAt !== 'string' || !Number.isFinite(Date.parse(w.observedAt)) || !Array.isArray(w.models)
      || !(w.diagnostic === undefined || typeof w.diagnostic === 'string')) throw new Error('Invalid warehouse observation.');
    const seen = new Set<string>();
    for (const m of w.models) {
      if (!object(m) || typeof m.id !== 'string' || !ids.has(m.id) || seen.has(m.id)
        || !['observed', 'not-deployed', 'unavailable', 'unsupported'].includes(m.status as string)
        || !(m.relation === null || typeof m.relation === 'string') || !Array.isArray(m.columns)
        || !(m.diagnostic === undefined || typeof m.diagnostic === 'string')
        || (m.status === 'observed' && !m.relation)
        || (m.status !== 'observed' && m.columns.length)) throw new Error('Invalid warehouse model observation.');
      seen.add(m.id);
      const cols = new Set<string>();
      for (const c of m.columns) {
        if (!object(c) || typeof c.name !== 'string' || !c.name || cols.has(c.name)
          || typeof c.dataType !== 'string' || !c.dataType || typeof c.description !== 'string') throw new Error('Invalid observed columns.');
        cols.add(c.name);
      }
    }
    if (seen.size !== ids.size) throw new Error('Incomplete warehouse observation.');
  }
  return s as unknown as SqlmeshSnapshot;
}

const INPUT_DIRS = ['models', 'macros', 'audits', 'seeds', 'external_models'];
const INPUT_ROOT_FILES = ['config.py', 'config.yaml', 'config.yml', 'schema.yaml', 'external_models.yaml'];
const INPUT_SUFFIX = /\.(sql|py|yaml|yml|csv)$/;

/**
 * The project files whose bytes the exporter fingerprints, as POSIX paths
 * relative to `root`, sorted. Mirror of `input_files` in
 * `integrations/sqlmesh/export.py`: the two must list exactly the same files
 * or every export reads as stale. Hidden directories are skipped; a symlink to
 * a file is an input when its target lies inside the project and is skipped
 * when it points outside (an artifact must never make the editor read outside
 * the workspace); a symlink to a directory is never descended into.
 */
export function sqlmeshInputFiles(root: string, semanticDir = '.erd-studio'): string[] {
  const realRoot = fs.realpathSync(root);
  const insideRoot = (file: string): boolean => {
    const rel = path.relative(realRoot, fs.realpathSync(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.')) visit(file); continue; }
      if (!INPUT_SUFFIX.test(entry.name)) continue;
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { isFile = fs.statSync(file).isFile() && insideRoot(file); } catch { isFile = false; }
      }
      if (isFile) files.push(path.relative(root, file).split(path.sep).join('/'));
    }
  };
  for (const d of INPUT_DIRS) visit(path.join(root, d));
  for (const f of [...INPUT_ROOT_FILES, `${semanticDir}/sqlmesh-bindings.json`]) {
    try {
      const abs = path.join(root, f);
      if (fs.statSync(abs).isFile() && (!fs.lstatSync(abs).isSymbolicLink() || insideRoot(abs))) files.push(f);
    } catch { /* absent */ }
  }
  return files.sort();
}

function emptyMetadata(): ProjectMetadata {
  return {
    manifest: { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() },
    declarations: { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() },
  };
}

/** Reads an inert artifact only. Python execution belongs to the explicit refresh command. */
export class SqlmeshProjectAdapter implements ProjectAdapter {
  readonly provider = 'sqlmesh' as const;
  readonly artifactPath: string;
  private snapshot?: SqlmeshSnapshot;
  private metadata = emptyMetadata();
  private signature = '';
  status: 'missing' | 'ready' | 'stale' | 'invalid' = 'missing';
  diagnostics: string[] = [];
  constructor(readonly root: string, readonly semanticDir = '.erd-studio') {
    this.artifactPath = path.join(root, semanticDir, 'sqlmesh.json');
  }
  invalidate(): void { this.signature = ''; }
  get generatedAt(): string | undefined { return this.snapshot?.generatedAt; }
  getSnapshot(): SqlmeshSnapshot | undefined { return this.snapshot; }
  get integration(): NonNullable<DisplayDomain['integration']> {
    const w = this.snapshot?.warehouse;
    return { provider: 'sqlmesh', status: this.status, generatedAt: this.generatedAt, diagnostics: this.diagnostics,
      ...(w ? { warehouse: { environment: w.environment, observedAt: w.observedAt,
        observed: w.models.filter(m => m.status === 'observed').length, total: w.models.length,
        ...(w.diagnostic ? { diagnostic: w.diagnostic } : {}) } } : {}) };
  }
  getModel(name: string): ProjectModel | undefined { return this.snapshot?.models.find(m => m.name === name); }
  assertWritableModel(name: string): void {
    const model = this.getModel(name);
    if (model) assertLogicalColumnMapping(model.name, model.columns, foldingOf(model));
  }
  /** Resolve only the exported source, within this project's real filesystem root. */
  resolveSourceFile(name: string): string {
    const source = this.getModel(name)?.sourcePath;
    if (!source) throw new Error(`No source file is available for SQLMesh model ${name}. Refresh metadata if the model moved.`);
    const file = path.join(this.root, source);
    let real: string;
    try { real = fs.realpathSync(file); }
    catch { throw new Error(`Source file ${source} is unavailable. Refresh metadata if the model moved.`); }
    const rel = path.relative(fs.realpathSync(this.root), real);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(real).isFile()) {
      throw new Error('The SQLMesh source file must be a file inside this project.');
    }
    return real;
  }
  /**
   * Cardinality from single-column uniqueness evidence. Column names may be
   * given in either spelling — the export's or the logical design's — so
   * `customer_id` finds Snowflake's `CUSTOMER_ID` unique key.
   */
  relationshipCardinality(fromModel: string, fromColumn: string, toModel: string, toColumn: string) {
    const one = (name: string, col: string) => {
      const model = this.getModel(name);
      if (!model) return false;
      const column = findByIdentifier(model.columns, col, foldingOf(model));
      return !!column && model.uniqueKeys.some(k => k.length === 1 && k[0] === column.name);
    };
    return one(fromModel, fromColumn)
      ? (one(toModel, toColumn) ? 'one-to-one' as const : 'one-to-many' as const)
      : (one(toModel, toColumn) ? 'many-to-one' as const : 'many-to-many' as const);
  }
  /**
   * A logical model seeded from the export for Add Existing Model: columns take
   * their logical spelling (lowercase wherever the engine folds case), so the
   * yml satisfies `COLUMN_NAME_PATTERN` and still matches the physical names.
   */
  seedModel(name: string): SemanticModel | undefined {
    const m = this.getModel(name);
    if (!m) return undefined;
    this.assertWritableModel(name);
    const folding = foldingOf(m);
    return { name: m.name, schema: m.schema, description: m.description,
      columns: m.columns.map(c => ({ name: logicalSpelling(c.name, folding), dataType: c.dataType ?? 'unknown', description: c.description })) };
  }

  async load(): Promise<ProjectMetadata> {
    try {
      const stat = fs.statSync(this.artifactPath);
      const signature = `${stat.mtimeMs}:${stat.size}`;
      if (signature === this.signature) return this.metadata;
      if (stat.size > MAX_BYTES) throw new Error('SQLMesh metadata exceeds the 32 MiB limit.');
      const snapshot = parseSqlmeshSnapshot(fs.readFileSync(this.artifactPath, 'utf8'));
      let stale = true;
      const diagnostics = [...snapshot.diagnostics];
      try { stale = this.inputsChanged(snapshot.inputs); }
      catch { diagnostics.unshift('Source fingerprints could not be checked; refresh metadata when the project is readable.'); }
      if (stale) diagnostics.unshift('Project inputs changed or could not be checked since export. Refresh SQLMesh metadata.');
      const manifest: ManifestData = emptyMetadata().manifest;
      const byId = new Map(snapshot.models.map(m => [m.id, m]));
      for (const m of snapshot.models) {
        manifest.models.set(m.name, { name: m.name, uniqueId: m.id, projectName: 'sqlmesh', schema: m.schema,
          description: m.description, columns: m.columns.map(c => ({ name: c.name, data_type: c.dataType, description: c.description })),
          ...(m.sourcePath ? { originalFilePath: m.sourcePath } : {}) });
        manifest.uniqueColumns.set(m.name, new Set(m.uniqueKeys.filter(k => k.length === 1).map(k => k[0])));
        manifest.compositeUniqueGroups.set(m.name, m.uniqueKeys.filter(k => k.length > 1));
      }
      // Consumed by Add Existing Model, which writes these into the domain file,
      // so column names carry their logical spelling; `relationshipCardinality`
      // folds when it looks the uniqueness evidence up again.
      manifest.relationshipTests = snapshot.relationships.map(r => {
        const from = byId.get(r.fromId)!; const to = byId.get(r.toId)!;
        return { fromModel: from.name, fromColumn: logicalSpelling(r.fromColumn, foldingOf(from)),
          toModel: to.name, toColumn: logicalSpelling(r.toColumn, foldingOf(to)) };
      });
      this.snapshot = snapshot;
      this.signature = signature;
      this.diagnostics = diagnostics;
      this.status = stale ? 'stale' : 'ready';
      this.metadata = { ...emptyMetadata(), manifest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.snapshot = undefined; this.metadata = emptyMetadata(); this.signature = ''; this.status = 'missing';
        this.diagnostics = ['No SQLMesh export found. Run Refresh Project Metadata or the Python exporter.'];
      } else {
        this.status = this.snapshot ? 'stale' : 'invalid';
        this.diagnostics = [`SQLMesh metadata could not be read: ${error instanceof Error ? error.message : String(error)}`];
      }
    }
    return this.metadata;
  }

  private inputsChanged(inputs: Record<string, string>): boolean {
    const files = sqlmeshInputFiles(this.root, this.semanticDir);
    if (files.length !== Object.keys(inputs).length) return true;
    for (const file of files) {
      if (createHash('sha256').update(fs.readFileSync(path.join(this.root, file))).digest('hex') !== inputs[file]) return true;
    }
    return false;
  }

  existingModels(domainNames: Set<string>, modelFolder?: string): ExistingModelPreview[] {
    return (this.snapshot?.models ?? []).filter(m => !domainNames.has(m.name)
      && (!modelFolder || m.sourcePath?.startsWith(`${modelFolder.replace(/\/$/, '')}/`)))
      .map(m => ({ name: m.name, schema: m.schema, description: m.description, columnCount: m.columns.length,
        source: 'sqlmesh', sourcePath: m.sourcePath ?? '', qualifiedName: m.id }));
  }

  buildPhysical(domain: UnifiedDomain, _data: ProjectMetadata): DisplayDomain {
    if (!this.snapshot) throw new Error(this.diagnostics[0] ?? 'Refresh SQLMesh metadata before opening the Physical stage.');
    const names = new Set(domain.logical.models.map(m => m.name));
    const byId = new Map(this.snapshot.models.map(m => [m.id, m]));
    const models = domain.logical.models.map(logical => {
      const actual = this.getModel(logical.name);
      if (!actual) return { name: logical.name, schema: '', description: logical.description ?? '', columns: [], existsInProject: false, missingReason: 'absent' as const };
      const source = actual.columnSource === 'declared' ? 'sqlmesh-declared' as const : 'sqlmesh-inferred' as const;
      const folding = foldingOf(actual);
      const warehouse = this.snapshot?.warehouse?.models.find(m => m.id === actual.id);
      const observed = warehouse?.status === 'observed' ? warehouse.columns : [];
      // Observed columns replace their source counterpart (observed types win)
      // and observed-only columns are appended; the source spelling is kept.
      const columns = actual.columns.map(c => ({ ...c }));
      const observationMatches = matchIdentifiers(columns, observed, folding);
      for (const [existing, observation] of observationMatches.pairs) {
        existing.dataType = observation.dataType;
        existing.description ||= observation.description;
      }
      columns.push(...observationMatches.unmatchedTarget.map(c => ({ ...c })));
      const designMatches = matchIdentifiers(columns, logical.columns ?? [], folding).pairs;
      return { name: logical.name, schema: actual.schema, description: actual.description,
        ...(actual.sourcePath ? { sourcePath: actual.sourcePath } : {}),
        qualifiedName: actual.id, columnsKnown: actual.columnsKnown || warehouse?.status === 'observed', existsInProject: true, warehouse,
        identifierFolding: folding,
        rationale: logical.rationale, grain: logical.grain, modelRole: logical.modelRole,
        provenance: { columns: observed.length ? ['sqlmesh-observed' as const, source] : [source], types: observed.length ? 'sqlmesh-observed' as const : source },
        columns: columns.map(c => {
          const design = designMatches.get(c);
          return { name: c.name, dataType: c.dataType ?? '', description: c.description,
            isPrimaryKey: design?.isPrimaryKey ?? false, isForeignKey: design?.isForeignKey ?? false,
            isNaturalKey: design?.isNaturalKey ?? false, scdType: design?.scdType, additiveType: design?.additiveType };
        }) };
    });
    const relationships = this.snapshot.relationships.flatMap(r => {
      const from = byId.get(r.fromId)!; const to = byId.get(r.toId)!;
      if (!names.has(from.name) || !names.has(to.name)) return [];
      const cardinality = this.relationshipCardinality(from.name, r.fromColumn, to.name, r.toColumn);
      return [{ fromModel: from.name, fromColumn: r.fromColumn, toModel: to.name, toColumn: r.toColumn, cardinality }];
    });
    return { schemaVersion: domain.schemaVersion, domain: domain.domain, layer: domain.layer,
      description: domain.description, modelFolder: domain.modelFolder, stage: 'physical', models, relationships,
      viewConfig: domain.viewConfig, readOnly: true, positionDraggable: true,
      integration: this.integration,
      identifierCaseSensitive: true };
  }
}
