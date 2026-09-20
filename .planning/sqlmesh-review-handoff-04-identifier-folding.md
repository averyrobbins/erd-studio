# ERD Studio review handoff 04 — M1: identifier case policy for SQLMesh columns

Please independently review the change below. Report findings with severity, file/line references, impact and a concrete reproduction. Do not edit source, commit, push, install the VSIX or trigger GitHub Actions; local checks and disposable databases are fine.

## Repository state

- Checkout: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`
- Branch: `claude/sqlmesh-review-fixes` (from `sqlmesh-integration` @ `23292db`). Earlier commits: `1fe7e5e`, `1ac3c90`, `dd66b55` (handoffs 01–03).
- Commit under review: `8b6c897` — *Match SQLMesh column names by the dialect's identifier folding*.
- Python environment: `.venv-sqlmesh` (SQLMesh 0.236.1, SQLGlot 30.8.0, DuckDB 1.5.5).
- Origin: independent Claude review finding **M1**.

## The defect

The exporter preserves dialect case (verified: a Snowflake-dialect model exports `['ORDER_ID','CUSTOMER_ID']`), and `SemanticEditorProvider.buildDisplayDomain` sets `identifierCaseSensitive: true` on both stages for SQLMesh, but `COLUMN_NAME_PATTERN` (`src/types/naming.ts`) is `/^[a-z0-9_]+$/`. Consequences on any upper-folding dialect (Snowflake, Oracle): `compare()` reported a lowercase logical model as 0 matched / N extra / N missing; Add Existing Model seeded `CUSTOMER_ID` into the yml (unvalidated), after which `updateColumn` refused it (*"Column name must use lowercase…"*); `applySqlmeshLogicalPlan` wrote uppercase names into the design; and `update-type-in-logical` could not find the logical column at all.

## The design

**Principle:** the logical design keeps its lowercase authoring rule; the export says how each model's engine folds unquoted identifiers; matching is *exact first, then folded among unclaimed names*, so quoted identifiers that differ only by case (`"id"` beside `ID`, both real on Snowflake) never collapse.

- `integrations/sqlmesh/export.py`: `identifier_folding(dialect)` maps SQLGlot's `NORMALIZATION_STRATEGY` — `LOWERCASE`/`CASE_INSENSITIVE` → `lower`, `UPPERCASE`/`CASE_INSENSITIVE_UPPERCASE` → `upper`, `CASE_SENSITIVE` or unknown dialect → `exact`; each model gains `identifierFolding`. Schema version stays 2 (additive optional field).
- `src/types/naming.ts`: `IdentifierFolding` type with the policy documented. `src/types/project.ts` / `display.ts`: optional `identifierFolding` on `ProjectModel` / `DisplayModel`.
- `src/services/identifierMatching.ts` (new, pure): `foldIdentifier`, `sameIdentifier`, `logicalSpelling` (lowercase unless `exact`), `findByIdentifier` (exact, else the single folded candidate), `matchIdentifiers` (two-pass pairing; ambiguous folded keys pair nothing; each entry claimed once).
- `src/services/discrepancyService.ts`: `compareColumns` uses `matchIdentifiers` with the model's folding (`identifierFolding` from either side, else the domain default: `exact` when `identifierCaseSensitive`, otherwise `lower` — i.e. dbt behaviour unchanged for ordinary names). `compareRelationships` folds each endpoint column by its model's folding. The unused `relationshipKey` helper was removed.
- `src/services/sqlmeshAdapter.ts`: parser accepts the optional field; `buildPhysical` sets `identifierFolding` per model, merges observed DuckDB columns into source columns through the fold (source spelling kept, observed type wins), and resolves design key flags through the fold; `relationshipCardinality` folds; new `seedModel(name)` returns the logical-spelled model; `manifest.relationshipTests` (consumed only by Add Existing Model's domain write) carry logical spelling.
- `src/services/sqlmeshSync.ts`: `foldingByModel(physical)`; `applySqlmeshLogicalPlan` looks up logical/physical columns through the fold, writes `logicalSpelling(...)` on add, removes by folded match, matches relationships by folded endpoints, and the dangling check folds. A type update whose logical column vanished now fails with a specific message instead of "Unsupported logical action".
- `src/providers/SemanticEditorProvider.ts`: v5 and v4 Add Existing Model paths seed through `seedModel` for SQLMesh; `checkSqlmeshSharedRemovals` compares other domains' relationships through the fold.
- Fixture export regenerated (every model now `identifierFolding: "lower"`); README section "Model identity and relationships" documents the policy and its limits.

## Tests

- `test/unit/identifierMatching.test.ts` (11): folding, exact-first, ambiguity, exact never folds, duplicate claims, dbt-equivalent lowercase fold.
- `test/unit/sqlmeshIdentifierCase.test.ts` (6): fixture rewritten as an upper-folding Snowflake export — full match of a lowercase design; quoted twin stays apart; plan apply writes `amount`/`created_at` (all pass `validateColumnDef`) and finds the existing column for a type update; removal + relationship add through the fold and the dangling guard; `seedModel`/`relationshipTests`/cardinality in logical spelling; exports without the field match exactly.
- Python: `test_dialect_normalization_preserves_distinct_quoted_columns` asserts `upper` for the Snowflake model and `lower` for the DuckDB ones; `test_identifier_folding_follows_the_dialect`.

## What to check

- The dbt path: `matchIdentifiers(…, 'lower')` must reproduce the old `Map`-keyed lowercase matching for every realistic input. The one behavioural difference is pathological: two columns on one side differing only by case used to collapse (last wins); now they pair exactly where possible and an ambiguous fold pairs nothing. Confirm you agree this is an improvement rather than a regression, and that the report ordering (source order, then unmatched target order) is unchanged.
- Relationship keys now fold per endpoint model. A relationship whose model is absent from both stages (cannot happen after the `existsInProject` filter, but check) falls back to the domain default.
- `foldingByModel` reads `physical.models[].identifierFolding`; `applySqlmeshLogicalPlan` is called with the freshly built physical domain in both `handleGenerateSqlmeshSyncPlan` and `handleApplySqlmeshLogicalSync`. Confirm there is no path that passes a physical domain built from a *different* export than the plan's preconditions cover.
- `seedModel` lowercases for `lower`/`upper`. On a `lower` dialect a quoted mixed-case column (`"Customer_Id"` on Postgres) is seeded as `customer_id`; if the table also has an unquoted `customer_id`, exact-first pairs the design with the unquoted one and the quoted twin reports as missing. Documented as a limitation in the README; argue whether the seed should refuse instead.
- `exact` dialects (ClickHouse, MySQL) with uppercase columns: seeding writes the exact spelling, which violates `COLUMN_NAME_PATTERN` and the canvas will refuse later edits to that column's type. Documented; not fixed (a global rule change was out of scope). Your view on whether the seed should reject or the pattern should relax for SQLMesh projects is welcome.
- `buildPhysical`'s observed-column merge changed from "observed object replaces source entry (observed spelling)" to "source entry keeps its spelling, takes the observed type, and fills an empty description". Confirm the existing test `merges v2 observations…` still expresses the intended semantics.
- `SqlmeshProjectAdapter.load()` now spells `relationshipTests` columns logically. `list_manifest_models` (MCP) also prints them; confirm that is acceptable for a "legacy" summary tool.

## Validation run

- Python: 18 tests OK. `npm run compile` clean. `npx vitest run`: 73 files, 1630 tests. `npm run build` OK. `mcp-server` build + smoke: 11/11 ✅.

## Out of scope here

Environment-not-found diagnostic (M2), export timeout (M3), export self-hash (L2), symlink asymmetry (L4), notice dismissal (L5), Claude launch venv (L6) follow in later commits, each with its own `.planning/sqlmesh-review-handoff-NN-*.md`.
