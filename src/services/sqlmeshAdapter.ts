import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { SqlmeshSnapshot, ProjectModel } from '../types/project';
import type { ManifestData } from '../types/manifest';
import type { DisplayDomain, ExistingModelPreview } from '../types/display';
import type { UnifiedDomain } from '../types/semantic';
import type { ProjectAdapter, ProjectMetadata } from './projectAdapter';

const MAX_BYTES = 32 * 1024 * 1024;
const aliasPattern = /^[a-z][a-z0-9_]*$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const relative = (p: string) => !!p && !path.isAbsolute(p) && !p.includes('\\') && !p.split('/').includes('..') && !p.includes('\0');

export function parseSqlmeshSnapshot(raw: string): SqlmeshSnapshot {
  const s: unknown = JSON.parse(raw);
  if (!object(s) || s.schemaVersion !== 1 || s.provider !== 'sqlmesh'
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
  return s as unknown as SqlmeshSnapshot;
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
  getModel(name: string): ProjectModel | undefined { return this.snapshot?.models.find(m => m.name === name); }
  relationshipCardinality(fromModel: string, fromColumn: string, toModel: string, toColumn: string) {
    const one = (name: string, col: string) => this.getModel(name)?.uniqueKeys.some(k => k.length === 1 && k[0] === col);
    return one(fromModel, fromColumn)
      ? (one(toModel, toColumn) ? 'one-to-one' as const : 'one-to-many' as const)
      : (one(toModel, toColumn) ? 'many-to-one' as const : 'many-to-many' as const);
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
      manifest.relationshipTests = snapshot.relationships.map(r => ({ fromModel: byId.get(r.fromId)!.name,
        fromColumn: r.fromColumn, toModel: byId.get(r.toId)!.name, toColumn: r.toColumn }));
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
    const files = new Set<string>();
    const visit = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) visit(file);
        else if (entry.isFile() && /\.(sql|py|yaml|yml|csv)$/.test(entry.name)) files.add(path.relative(this.root, file).split(path.sep).join('/'));
      }
    };
    for (const d of ['models', 'macros', 'audits', 'seeds', 'external_models']) visit(path.join(this.root, d));
    for (const f of ['config.py', 'config.yaml', 'config.yml', 'schema.yaml', 'external_models.yaml', `${this.semanticDir}/sqlmesh-bindings.json`]) {
      if (fs.existsSync(path.join(this.root, f))) files.add(f);
    }
    if (files.size !== Object.keys(inputs).length) return true;
    for (const file of files) {
      const abs = path.join(this.root, file);
      // Never follow an input symlink out of the workspace when inspecting an artifact.
      const real = fs.realpathSync(abs);
      const rel = path.relative(fs.realpathSync(this.root), real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
      if (createHash('sha256').update(fs.readFileSync(abs)).digest('hex') !== inputs[file]) return true;
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
      return { name: logical.name, schema: actual.schema, description: actual.description,
        qualifiedName: actual.id, columnsKnown: actual.columnsKnown, existsInProject: true,
        rationale: logical.rationale, grain: logical.grain, modelRole: logical.modelRole,
        provenance: { columns: [source], types: source },
        columns: actual.columns.map(c => {
          const design = (logical.columns ?? []).find(l => l.name === c.name);
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
      integration: { provider: 'sqlmesh', status: this.status, generatedAt: this.generatedAt, diagnostics: this.diagnostics },
      identifierCaseSensitive: true };
  }
}
