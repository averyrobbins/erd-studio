/**
 * Naming rules shared by the extension host and the webview.
 *
 * This pattern is the *authoring* convention: it governs names the user types
 * in the New Model dialog (webview) and in a rename, and the host enforces it
 * through `validateModelName`.
 *
 * It is deliberately NOT applied to names discovered in the user's dbt project
 * ("Add Existing Model"), where dbt permits uppercase and digit-leading names.
 * Those go through `validateModelNameSafety`, which only rules out anything
 * unsafe as a file name under `.erd-studio/logical-models/`.
 */

/** A model name: lowercase, starts with a letter, then letters/digits/underscores. */
export const MODEL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Human-readable statement of the model-name rule (used in error messages). */
export const MODEL_NAME_RULE =
  'Model name must start with a letter and use lowercase letters, numbers, and underscores.';

/** A column name: lowercase letters, digits, and underscores. */
export const COLUMN_NAME_PATTERN = /^[a-z0-9_]+$/;

/** Return the names that appear more than once in `names` (trimmed; blanks ignored). */
export function findDuplicateNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return Array.from(duplicates);
}

/**
 * How a project's engine folds the case of *unquoted* identifiers, and so how a
 * logical column name (always typed lowercase, per `COLUMN_NAME_PATTERN`) is
 * matched against the exact spelling a framework reports back:
 *
 * - `lower` — the engine lowercases unquoted identifiers (Postgres) or ignores
 *   case entirely (DuckDB, BigQuery, Spark): `customer_id` ≡ `customer_id`.
 * - `upper` — the engine uppercases unquoted identifiers (Snowflake, Oracle):
 *   a logical `customer_id` names the physical `CUSTOMER_ID`.
 * - `exact` — identifiers are case-sensitive (ClickHouse, MySQL) or the
 *   folding is unknown: only an exact spelling matches.
 *
 * Matching is always exact-first, then folded among the names still unclaimed,
 * so a quoted `"id"` beside an unquoted `ID` (both real on Snowflake) never
 * collapse into one column. See `src/services/identifierMatching.ts`.
 */
export type IdentifierFolding = 'lower' | 'upper' | 'exact';
