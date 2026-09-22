/**
 * Identifier matching between a logical design and what a framework reports.
 *
 * The logical design spells every column lowercase (`COLUMN_NAME_PATTERN`);
 * engines report identifiers in their own folded form — `CUSTOMER_ID` on
 * Snowflake, `customer_id` on DuckDB, exactly as written on ClickHouse. The
 * two sides are reconciled by the model's {@link IdentifierFolding}: names are
 * paired exactly first, then by folded spelling among whatever is still
 * unclaimed, and a folded key that is ambiguous on either side pairs nothing.
 *
 * Pure: no vscode import (shared with `discrepancyService`, which the
 * mcp-server bundles).
 */
import type { IdentifierFolding } from '../types/naming';
import { COLUMN_NAME_PATTERN } from '../types/naming';

/** The comparison key for `name` under `folding`. */
export function foldIdentifier(name: string, folding: IdentifierFolding): string {
  const trimmed = name.trim();
  if (folding === 'lower') return trimmed.toLowerCase();
  if (folding === 'upper') return trimmed.toUpperCase();
  return trimmed;
}

/** True when `a` and `b` name the same identifier under `folding`. */
export function sameIdentifier(a: string, b: string, folding: IdentifierFolding): boolean {
  return a === b || foldIdentifier(a, folding) === foldIdentifier(b, folding);
}

/**
 * The spelling a framework-reported identifier takes when it is written into
 * the logical design: lowercase wherever the engine folds case (so the yml
 * stays within `COLUMN_NAME_PATTERN` and still folds back to the physical
 * name), and the exact spelling where case is significant.
 */
export function logicalSpelling(name: string, folding: IdentifierFolding, bindings?: Readonly<Record<string, string>>): string {
  const alias = Object.entries(bindings ?? {}).find(([, native]) => native === name)?.[0];
  if (alias !== undefined) return alias;
  return folding === 'exact' ? name : name.toLowerCase();
}

/**
 * A read-only comparison can retain identifiers the logical schema cannot
 * represent. Import and sync must stop before mapping them into an invalid
 * design or confusing two distinct columns. Explicit bindings take precedence
 * over inferred spellings, and must still produce a one-to-one logical schema.
 */
export function assertLogicalColumnMapping(
  modelName: string, columns: readonly { name: string }[], folding: IdentifierFolding,
  bindings?: Readonly<Record<string, string>>,
): void {
  const mapped = new Map<string, string>();
  for (const column of columns) {
    const name = logicalSpelling(column.name, folding, bindings);
    if (!COLUMN_NAME_PATTERN.test(name)) {
      throw new Error(`Cannot import or sync ${modelName}: column ${JSON.stringify(column.name)} cannot be represented by the logical naming rules. Add explicit column bindings in sqlmesh-bindings.json and refresh.`);
    }
    const previous = mapped.get(name);
    if (previous !== undefined) {
      throw new Error(`Cannot import or sync ${modelName}: columns ${JSON.stringify(previous)} and ${JSON.stringify(column.name)} collide as logical column ${JSON.stringify(name)}. Add explicit column bindings in sqlmesh-bindings.json and refresh.`);
    }
    mapped.set(name, column.name);
  }
}

/**
 * Find the entry of `items` that names `name` under `folding`: an exact match
 * wins; otherwise the single folded match, if there is exactly one.
 */
export function findByIdentifier<T extends { name: string }>(
  items: readonly T[],
  name: string,
  folding: IdentifierFolding,
): T | undefined {
  const exact = items.find((item) => item.name === name);
  if (exact) return exact;
  const key = foldIdentifier(name, folding);
  const folded = items.filter((item) => foldIdentifier(item.name, folding) === key);
  return folded.length === 1 ? folded[0] : undefined;
}

export interface IdentifierMatch<S, T> {
  /** Source entries paired with the target entry they name; insertion order follows `source`. */
  pairs: Map<S, T>;
  /** Target entries no source entry claimed, in `target` order. */
  unmatchedTarget: T[];
}

/**
 * Pair `source` and `target` entries by name. Every entry is claimed at most
 * once. Pass one: exact spelling. Pass two: folded spelling, but only where the
 * folded key belongs to exactly one unclaimed entry on each side — two
 * unclaimed target columns that fold alike (`"id"` and `ID` on Snowflake) are
 * left for the caller to report rather than guessed between.
 */
export function matchIdentifiers<S extends { name: string }, T extends { name: string }>(
  source: readonly S[],
  target: readonly T[],
  folding: IdentifierFolding,
): IdentifierMatch<S, T> {
  const pairs = new Map<S, T>();
  const claimed = new Set<T>();

  const exactTargets = new Map<string, T>();
  for (const t of target) {
    if (!exactTargets.has(t.name)) exactTargets.set(t.name, t);
  }
  for (const s of source) {
    const t = exactTargets.get(s.name);
    if (t && !claimed.has(t)) {
      pairs.set(s, t);
      claimed.add(t);
    }
  }

  if (folding !== 'exact') {
    const foldedTargets = new Map<string, T[]>();
    for (const t of target) {
      if (claimed.has(t)) continue;
      const key = foldIdentifier(t.name, folding);
      foldedTargets.set(key, [...(foldedTargets.get(key) ?? []), t]);
    }
    const foldedSources = new Map<string, S[]>();
    for (const s of source) {
      if (pairs.has(s)) continue;
      const key = foldIdentifier(s.name, folding);
      foldedSources.set(key, [...(foldedSources.get(key) ?? []), s]);
    }
    for (const s of source) {
      if (pairs.has(s)) continue;
      const key = foldIdentifier(s.name, folding);
      const candidates = foldedTargets.get(key);
      if (candidates?.length === 1 && foldedSources.get(key)?.length === 1 && !claimed.has(candidates[0])) {
        pairs.set(s, candidates[0]);
        claimed.add(candidates[0]);
      }
    }
  }

  return { pairs, unmatchedTarget: target.filter((t) => !claimed.has(t)) };
}
