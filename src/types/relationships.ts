/** Ordered column pairs form ONE relationship, never independent foreign keys. */
export interface ColumnPair { fromColumn: string; toColumn: string }
export interface RelationshipColumns {
  fromColumn: string;
  toColumn: string;
  /** Complete ordered tuple (at least two pairs). Anchors above equal its first pair. */
  columnPairs?: ColumnPair[];
}
export interface RelationshipEndpoints extends RelationshipColumns { fromModel: string; toModel: string }

export function relationshipPairs(r: RelationshipColumns): ColumnPair[] {
  return r.columnPairs ?? [{ fromColumn: r.fromColumn, toColumn: r.toColumn }];
}

/** Fail closed: malformed tuples must never be silently treated as single-column edges. */
export function validRelationshipColumns(value: unknown): value is RelationshipColumns {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  const name = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
  if (!name(r.fromColumn) || !name(r.toColumn)) return false;
  if (r.columnPairs === undefined) return true;
  if (!Array.isArray(r.columnPairs) || r.columnPairs.length < 2) return false;
  const pairs = r.columnPairs as ColumnPair[];
  if (!pairs.every(p => p && typeof p === 'object' && name(p.fromColumn) && name(p.toColumn))) return false;
  return pairs[0].fromColumn === r.fromColumn && pairs[0].toColumn === r.toColumn
    && new Set(pairs.map(p => p.fromColumn)).size === pairs.length
    && new Set(pairs.map(p => p.toColumn)).size === pairs.length;
}

export function relationshipIdentity(r: RelationshipEndpoints, normalise: (name: string) => string = x => x): string {
  return JSON.stringify([normalise(r.fromModel), normalise(r.toModel),
    relationshipPairs(r).map(p => [normalise(p.fromColumn), normalise(p.toColumn)])]);
}
export function sameRelationship(a: RelationshipEndpoints, b: RelationshipEndpoints): boolean {
  return relationshipIdentity(a) === relationshipIdentity(b);
}
export function relationshipColumns(pairs: ColumnPair[]): RelationshipColumns {
  if (!pairs.length) throw new Error('A relationship needs at least one column pair.');
  return { ...pairs[0], ...(pairs.length > 1 ? { columnPairs: pairs.map(p => ({ ...p })) } : {}) };
}
export function relationshipColumnLabel(r: RelationshipColumns, side: 'from' | 'to'): string {
  const names = relationshipPairs(r).map(p => side === 'from' ? p.fromColumn : p.toColumn);
  return names.length === 1 ? names[0] : `(${names.join(', ')})`;
}
export function relationshipEdgeId(r: RelationshipEndpoints): string {
  return r.columnPairs ? `fk-tuple-${relationshipIdentity(r)}` : `fk-${r.fromModel}-${r.fromColumn}-${r.toModel}-${r.toColumn}`;
}
export function renameRelationshipColumn(r: RelationshipEndpoints, model: string, oldName: string, newName: string): void {
  for (const pair of relationshipPairs(r)) {
    if (r.fromModel === model && pair.fromColumn === oldName) pair.fromColumn = newName;
    if (r.toModel === model && pair.toColumn === oldName) pair.toColumn = newName;
  }
  if (r.fromModel === model && r.fromColumn === oldName) r.fromColumn = newName;
  if (r.toModel === model && r.toColumn === oldName) r.toColumn = newName;
}
