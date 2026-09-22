# SQLMesh pilot and composite relationships — 2026-09-22

All three accepted follow-ups are implemented on `sqlmesh-integration`.
Prior review fixes are **731edfc**; the warehouse alias-display fix is **3930c47**.
The subsequent change adds composite relationships and their acceptance coverage.

## What changed

- Warehouse-only alias collisions render a distinct native label; existing source
  aliases and FK endpoints stay stable. Import and sync still refuse ambiguity.
- Optional `columnPairs` stores one complete ordered tuple. The first pair matches
  the required singular anchor fields. Existing single-column v5 data is unchanged.
- Both integrations retain tuples through discovery, import, graph IDs/labels,
  FK badges, comparison, editing, rename/delete, sync plans and MCP. Secondary-column
  changes participate in identity and grouped undo. Shared harness versions: 18 / 6.
- SQLMesh and dbt templates use one correlated `NOT EXISTS` tuple comparison.
  Partial-null children are exempt; parent NULLs do not hide orphans. Independent
  single-column tests no longer supply composite cardinality evidence.

## Representative local pilot

Created **`../erd-studio-sqlmesh-pilot`**, preserving the original sibling acceptance
project. It has 40 customers, 100 orders / 300 lines, 10 models across three schemas,
seed/FULL/incremental models, aggregation, quoted identifiers and single/tuple FKs.
The Python environment is pinned; the README includes reproduction commands.

Verified through the installed VSIX in an isolated VS Code profile:

1. Imported all ten models; source and logical comparison matched, including the
   two-column product/region relationship and its many-to-one cardinality.
2. Edited/reordered that tuple in the new dialog; native undo restored its pairs.
3. Changed source amount from DECIMAL(12,2) to DECIMAL(14,2). Automatic refresh updated
   the visible comparison without modifying DuckDB. Reviewed Physical-to-Logical
   sync preserved the YAML comment, grain and rationale.
4. Inspected dev: all ten models observed; the deployed DECIMAL(12,2) remained distinct
   from the edited source. Database SHA-256 was unchanged by refresh and inspection.
5. Temporarily added warehouse-only `ORDER_NOTE` beside bound native `order note`.
   Physical displayed `order_note` and `ORDER_NOTE (warehouse only)` separately;
   preparing sync refused the collision. Inspection again left database bytes unchanged.
   Restored the original view afterward.
6. Prepared a domain-plan artifact with ten exact native IDs and no auto-apply flags.
   No planner was launched through this review action. Separately ran a bounded,
   explicit deployment in this disposable dev database; audits passed and final
   Logical/Physical comparison returned **All matched**.

The initial seed CSV required an explicit date cast in the incremental filter.
The pilot now contains that correction. No new Claude execution was used in this
pass; earlier real Claude source-sync acceptance remains recorded separately.

## Verification

| Check | Result |
|---|---|
| TypeScript and Vitest | Passed; 1,772 tests / 78 files |
| SQLMesh Python | 28 passed; 5 PostgreSQL tests skipped (not restarted) |
| Real dbt/DuckDB | Passed: two invalid tuples fail, valid data passes, malformed lists refuse compilation |
| MCP | Typecheck/build; 16 smoke checks, including tuple preservation |
| Actual VS Code host | 10 SQLMesh + 2 dbt checks; includes tuple rename/grouped undo |
| Production VSIX | Packaged; exporter and all three SQL templates included |

Runtime: Linux, VS Code 1.138.0, Python 3.13.15, SQLMesh 0.236.1, SQLGlot 30.8.0,
DuckDB 1.5.5; dbt Core 1.12.5 / dbt-duckdb 1.11.0 in a separate temporary environment.

## Review focus and limits

Review tuple identity when anchors match, all-pair identifier binding, cardinality
without inferred grouping, secondary-column rename/delete, native undo, and both
source-template contracts. See `test/unit/compositeRelationships.test.ts`, provider
and dialog tests, SQLMesh export tests, and `integrations/dbt/test_tuple.py`.

Tuple execution is verified on DuckDB only. Older extension versions cannot safely
edit tuple-bearing domains. Native deletion, generated-source editing, other
warehouse adapters, cloud authentication and production scale remain explicit gaps.
No worktree, PR, GitHub Actions run, release or production deployment was created.
