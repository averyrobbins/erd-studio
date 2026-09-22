# Native SQLMesh editor acceptance

Executed locally on 2026-09-21/22, on `sqlmesh-integration`, following
`94b8f37`. This supersedes the outstanding Linux editor/Claude checks in
[handoff 11](sqlmesh-review-handoff-11-editor-acceptance.md). It does not replace
the remaining parity checklist in [current status](sqlmesh-parity-status.md).

## Environment and method

- VS Code 1.138.0 on Linux, a built VSIX installed in an isolated profile. The
  registered Semantic Domain Editor was opened normally; no test message bridge
  was used for this acceptance run. Existing user profiles were untouched.
- Disposable sibling `../erd-studio-sqlmesh-acceptance`, created with `uv init`,
  pinned dependencies, and `sqlmesh init duckdb`. Python 3.13.15, SQLMesh 0.236.1,
  SQLGlot 30.8.0, DuckDB 1.5.5. Local Git only; no remote.
- An ERD `full_model` alias binds the native sample model. The logical definition
  includes a grain, rationale, and a YAML comment to detect destructive rewrites.

## Results

1. Imported metadata and opened both stages. Changed `num_orders` from BIGINT to
   INT through the column editor; comparison showed the expected type difference.
2. Applied metadata-to-logical sync, then used the actual canvas Undo button with
   the custom editor focused. The grouped change was reversed; comments, grain
   and rationale survived without opening the domain JSON as a text editor.
3. Discovered that comparison did not refresh after undo. Fixed the production
   refresh path and added unit/real-host regression coverage. Missing metadata
   now clears comparison without turning a successful logical edit into an error.
4. Launched real Claude Code from **Edit source with Claude**. It verified input
   hashes, added `CAST(COUNT(DISTINCT id) AS INT)`, retained grouping and input,
   and passed the sample unit test. Source refresh then showed all columns matched.
5. That first assistant used `sqlmesh render`, which initialized local state.
   Corrected the plan instructions to forbid this validation route and provide
   an explicit installed exporter command using `Context(load_state=False)`.
   A Python regression forbids state access and proves source export creates no
   database file. The second real assistant run changed INT back to BIGINT, invoked that
   exporter, and verified matching source metadata and in-memory query results.
   Independently checked database SHA-256 remained identical. The editor toolbar
   refresh showed All matched; automatic watcher-driven comparison refresh is
   tracked in the next automation step.
6. Deployed the disposable project separately to `dev`, with model start and
   backfill interval set to 2020-01-01 through 2020-01-07 to match the sample seed.
   **Inspect SQLMesh Warehouse** observed all three models and their consumer
   relations. The DuckDB file's SHA-256 was identical before and after inspection.
   An earlier inspection of absent `prod` correctly reported unavailable metadata.

## Reproducible checks and boundaries

`npm run compile`, `npm test` (1,675 tests), `npm run test:host` (8 SQLMesh and
2 dbt cases), the Python unittest suite (22 tests),
production packaging, and MCP smoke checks accompany these changes. The host
suite uses disposable dbt and SQLMesh copies; its terminal probe is distinct from
the real Claude run above. Session screenshots/logs live under
`/tmp/erd-acceptance-*` and `/tmp/erd-step2-*`; they are transient evidence, not
test dependencies. The sibling remains available for repeating the workflow.

The run validates one Linux/runtime combination and disposable DuckDB. It does
not establish Windows/macOS behavior, production-scale performance, arbitrary
custom loaders, or general SQL rewrite correctness. Assistant edits still need
grounded expressions and review; metadata refresh and sync do not deploy models.
