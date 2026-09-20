/** Versioned, credential-free interchange format for native SQLMesh projects. */
import type { IdentifierFolding } from './naming';

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
  /**
   * How the model's dialect folds unquoted identifiers, from SQLGlot's
   * normalization strategy. Absent in exports older than this field: those
   * are matched exactly until refreshed.
   */
  identifierFolding?: IdentifierFolding;
}

export interface ProjectRelationship {
  fromId: string;
  fromColumn: string;
  toId: string;
  toColumn: string;
  audit: string;
}

export interface SqlmeshSnapshot {
  schemaVersion: 1 | 2;
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
  warehouse?: WarehouseObservation | null;
}

export interface WarehouseModelObservation {
  id: string;
  status: 'observed' | 'not-deployed' | 'unavailable' | 'unsupported';
  relation: string | null;
  columns: ProjectColumn[];
  diagnostic?: string;
}

export interface WarehouseObservation {
  environment: string;
  observedAt: string;
  models: WarehouseModelObservation[];
  /** Set when the whole inspection failed (unknown environment, locked file, unreadable state); every model is then `unavailable` with the same text. */
  diagnostic?: string;
}
