/** Versioned, credential-free interchange format for native SQLMesh projects. */
export type ProjectProvider = 'dbt' | 'sqlmesh';

export interface ProjectColumn {
  name: string;
  dataType: string | null;
  description: string;
}

export interface ProjectModel {
  /** Canonical framework identity; never a basename or physical snapshot table. */
  id: string;
  /** Stable, file-safe logical alias. */
  name: string;
  schema: string;
  description: string;
  dialect: string;
  kind: string;
  sourcePath: string | null;
  columns: ProjectColumn[];
  columnsKnown: boolean;
  columnSource: 'declared' | 'inferred';
  uniqueKeys: string[][];
}

export interface ProjectRelationship {
  fromId: string;
  fromColumn: string;
  toId: string;
  toColumn: string;
  audit: string;
}

export interface SqlmeshSnapshot {
  schemaVersion: 1;
  provider: 'sqlmesh';
  generatedAt: string;
  sqlmeshVersion: string;
  gateway: string | null;
  config: string | null;
  models: ProjectModel[];
  relationships: ProjectRelationship[];
  diagnostics: string[];
  /** Relative paths and hashes; used to detect edits AND deleted input files. */
  inputs: Record<string, string>;
}
