# SQLMesh integration — development preview

This branch adds native SQLMesh discovery, model import, logical editing, Physical
view, comparison, AI instructions, and read-only MCP inspection. dbt keeps its
existing integration. Physical combines **source metadata** with optional, explicitly
requested DuckDB or PostgreSQL observations. Native sync updates the logical design deterministically
or prepares source edits for an assistant. Deployment remains a separate user action.

## Try it

The locally built `erd-studio-sqlmesh-draft.vsix` can be selected with VS Code's
**Extensions: Install from VSIX** command. Acceptance testing installs it only in a disposable, isolated VS Code profile.
Alternatively, use the source workflow below.

1. From this repository, run `npm ci` and `npm run build`. Open the repository in
   VS Code and press **F5** to launch the extension development host.
2. In that new window, open your SQLMesh project (or this repository's
   `test/fixtures/sqlmesh-project`). Native `config.yaml`, `config.yml`, or
   `config.py` is detected without a dummy dbt file. For mixed projects, set
   `erdStudio.provider` to `sqlmesh`; automatic detection prefers dbt. The
   extension activates on its own once the workspace has a `dbt_project.yml`
   or an `.erd-studio/` directory (`layers.json` or `sqlmesh.json`); for a
   brand-new SQLMesh project, open the ERD Studio sidebar or run any
   **ERD Studio:** command once and detection takes over from there.
3. Use your project's Python environment with SQLMesh installed. Set
   **User Settings → `erdStudio.sqlmesh.pythonPath`** to its Python executable.
   Otherwise the extension tries project `.venv`, then `python3` (`python` on
   Windows). Optional workspace settings: `erdStudio.sqlmesh.gateway`,
   `erdStudio.sqlmesh.config` (a Python configuration object name) and
   `erdStudio.sqlmesh.exportTimeoutSeconds` (default 600, minimum 30 — loading a
   large project and inferring every model's columns can take minutes). The
   progress notification can be cancelled; a cancelled or timed-out export
   leaves the previous `sqlmesh.json` untouched.
4. Run **ERD Studio: Refresh Project Metadata**. This explicitly executes trusted
   project configuration/macros and produces `.erd-studio/sqlmesh.json`. It never
   invokes SQLMesh plan, apply, run, model evaluation, or audit execution. SQLMesh
   loading can still execute user code, access services, and create caches/logs.
   VS Code workspace trust is required for this command.
5. Run **ERD Studio: Set Up Semantic Domains Directory**, open/create a domain,
   and choose **Add Existing Model → SQLMesh**. Switch to **Physical** or compare
   the stages. The supplied fixture already has an `orders` domain.

Select a model and choose **Open model source** in its details panel to open the
exported SQL/Python/source file from either stage. Generated models may share a
source file. Models without an exported source location have no source button;
missing files and links outside the project are rejected with a diagnostic.

An exported snapshot can be viewed without Python. By default, opening a diagram,
watching files, and MCP reads never launch the exporter. Source changes mark the
snapshot stale; explicitly refresh it.

For automatic source metadata sync, enable **User Settings →
`erdStudio.sqlmesh.autoRefresh`** in trusted SQLMesh workspaces. Source/config/binding
changes are debounced for one second. Only one export runs at a time; edits during
an export schedule one follow-up. Logical files and generated snapshots do not
trigger exports. Successful refreshes update both stages and open comparisons;
changed comparisons clear old sync selections. Failures preserve the last good
snapshot and report a warning; another source save retries. Disabling the setting
cancels pending/running automatic exports. Automatic refresh never edits source,
deploys, or inspects the warehouse, and clears prior warehouse observations.
MCP remains an inert reader regardless of this setting. Malformed replacement exports retain the last good
snapshot with a warning; deleting the export clears it.

For command-line export, use absolute paths:

```sh
/path/to/project/.venv/bin/python /path/to/erd-studio/integrations/sqlmesh/export.py \
  --project /path/to/project
```

`--semantic-dir docs/erd`, `--gateway local`, and `--config config_test` are optional.
The VSIX bundles this script as `dist/sqlmesh_export.py`; it does not bundle Python
or SQLMesh. Do not edit the generated JSON: it carries an `integrity` hash of its own
content, and an edited file is refused as invalid (the last good export is kept) until
you refresh. Exports written before the hash existed are still read.

## Model identity and relationships

Exports retain canonical, qualified SQLMesh names. ERD model names must be safe
file names, so default aliases combine schema/name with a stable identity hash.
To match an existing logical model, create `.erd-studio/sqlmesh-bindings.json`:

```json
{"version":1,"models":{"dim_customer":"analytics.dim_customer","fct_order":"analytics.fct_order"}}
```

Refresh after editing bindings. Renaming a bound logical model requires updating
its binding too. Bindings are one-to-one; changing the catalog changes identity.

Column names are exported exactly as SQLMesh normalizes them. Without explicit
column bindings, comparison pairs exact names first and then unambiguous dialect
folding (`lower`, `upper`, or `exact`). Import/sync refuse names that violate the
logical lowercase naming rules or collapse distinct native columns.

Add an optional `columns` object to the same binding file to handle these cases:

```json
{
  "version": 1,
  "models": {"orders": "analytics.orders"},
  "columns": {
    "orders": {"order_key": "ID", "quoted_key": "id", "total": "Order Total"}
  }
}
```

Each key is a safe logical alias; each value is the **exact name from the export**,
without SQL quote delimiters. Unlisted columns keep their normal logical spelling.
The complete resulting name set must be valid and one-to-one. Duplicate targets,
unknown source columns/models, and collisions with implicit names fail refresh;
fix the binding file and retry. Binding edits participate in freshness checks and
invalidate previously prepared sync plans. Remove bindings when removing source
columns and update them when renaming logical aliases.

For bound models, Physical and MCP output use logical aliases consistently, with
`nativeName` retaining the exact source identifier (shown on hover in either editor
stage). Comparison uses exact aliases; source/warehouse matching still uses native
identifiers. Both sync directions, imported relationships and uniqueness evidence
use the same mapping. Source plans include `modelContext.columnNames`; assistants
must resolve aliases through this map and preserve native SQL quoting.

For a single-column FK, copy [erd_relationship.sql](audits/erd_relationship.sql)
into your project's `audits/` folder and attach it to the child model:

```sql
audits (
  erd_relationship(column := customer_id, to := analytics.dim_customer, field := customer_id)
)
```

The audit allows null child keys and returns orphaned non-null keys. **The parent
must be a dependency of the child.** SQLMesh derives its DAG from the query, not
from audits, so a child that does not select from the parent needs an explicit
`depends_on (analytics.dim_customer)` in its `MODEL` block. Without it the audit
is rendered against the parent's virtual name: a fresh deployment fails with
*table does not exist* because the child can run before the parent, and a dev
environment checks prod's parent instead of its own. The exporter reports this
case as a diagnostic (*"…is not a dependency of the model"*) and still exports
the edge; fix the model, then refresh. Unfiltered
`unique_values` audits establish single-column uniqueness for cardinality.
`unique_combination_of_columns` is exported as grouped metadata; composite FK
cardinality is deferred. These are **audit declarations**, not evidence of passing
audits. Lineage, `grain`, and `references` do not automatically become ERD edges.
Other custom audits, filtered uniqueness, and unresolved arguments are diagnosed
or omitted. Copying the convention does not run the audit.

## Inspect a deployed DuckDB or PostgreSQL environment

Set `erdStudio.sqlmesh.environment` (default `prod`), then run **ERD Studio: Inspect
SQLMesh Warehouse**. CLI equivalent: add `--environment dev` to the export
command. **Refresh Project Metadata** returns to source-only mode and clears previous
observations; repeat inspection for a new warehouse snapshot.

Inspection supports one native project, one gateway and the built-in scheduler.
Warehouse/state connections can be plain local DuckDB files or PostgreSQL (including
separate state connections). In-memory DuckDB, attachments, DuckDB connection hooks,
extensions, other remote engines and multiple gateways are rejected. Close any process
holding a writable DuckDB connection before inspecting; database locks are reported
as unavailable metadata.

The exporter reads SQLMesh's existing, finalized environment state and resolves its
promoted models to consumer relations, honoring environment suffixes/catalog mapping.
It opens DuckDB with `read_only=True`. PostgreSQL connections set read-only transaction
defaults before the first query, with statement/lock timeouts, and honor configured
authentication, SSL mode and optional role. Use an account with only CONNECT, schema
USAGE and SELECT on SQLMesh state and consumer relations. Both adapters bypass
normal connection setup and never use
SQLMesh's state accessor that can initialize/migrate state, and closes connections.
It does not query model rows, deploy models or run audits. Project config/macros
still execute as trusted Python, so this is not a sandbox for arbitrary project code.

Exports retain source columns separately from observations. Observed column types
win in Physical; the column list is the union, retaining source-only columns.
The notice and model details show environment, time, coverage, relation and status:
`observed`, `not-deployed`, `unavailable`, or `unsupported`. `not-deployed` is only
reported for a model absent from an environment that exists; an environment that is
not in SQLMesh state (a typo in `erdStudio.sqlmesh.environment`, or one never
deployed), a locked or missing database and unreadable state all mark every model
`unavailable` and put the reason in the notice. Failed inspection does
not make a source model disappear or imply its columns should be deleted. Embedded
and external models have no managed relation inspected by this workflow. Edges
remain source audit declarations, not observed/enforced warehouse constraints.

## Sync selected differences

Use a v5 domain, save project files, refresh metadata, compare stages, then **Sync**.
Choose **Physical** to adopt metadata into the logical design or **Logical** to
prepare source edits. Each plan supports one direction; reconcile mixed decisions
in separate batches. **Prepare sync plan** opens `.erd-studio/.sync-plan.json` for
review. The plan includes canonical model IDs, exact source paths, environment
provenance and SHA-256 preconditions covering source/export/bindings/shared designs.

- **Apply to logical design** adds/removes selected columns, updates selected types,
  and reconciles selected audit-backed relationships/cardinality in one WorkspaceEdit.
  YAML comments, grain, rationale, key flags, SCD/additivity, and existing descriptions
  survive. New columns receive source descriptions. Description-only differences are
  not compared. Column removal is rejected if it would leave dangling relationships
  in this or another domain; update the relationships first. Shared model edits
  propagate through the normal editor pipeline. The normal Logical-stage undo
  command reverses the grouped edit.
- **Edit source with Claude** launches Claude Code directly (no shell) with
  native SQLMesh instructions, after the usual confirmation. `claude` is resolved
  on your PATH (`claude.cmd` on Windows) and the project's Python environment —
  `erdStudio.sqlmesh.pythonPath`'s directory, or `.venv`/`venv`/`env` when unset — is put
  first on the PATH it inherits. `VIRTUAL_ENV` points at that selected environment
  only when it has `pyvenv.cfg`; otherwise inherited virtualenv variables are cleared.
  Other assistants can read the same plan and the installed ERD
  Studio harness. Source edits support SQL model files: declarations,
  projections and the FK/uniqueness audit convention. The assistant must verify
  hashes, preserve model logic/kind, and run the plan’s explicit `refreshCommand`
  afterward. This invokes the installed source-only exporter with `load_state=False`.
  Do not use `sqlmesh render` or a default `Context` for source validation: they
  can initialize warehouse state. Run unit tests only on a known disposable test
  connection. Comparison refreshes after edits, sync and grouped undo/redo.
  Missing transformation expressions require user input; this is AI-assisted source
  editing, not a deterministic SQL rewriter. Export source-only metadata before
  generating a source plan so deployed drift is not confused with source drift.

Changed/dirty inputs, replaced plans, stale metadata, unknown authoritative types,
unsupported source models and mixed directions are rejected. Model creation/removal,
Python/generated models, seeds and external definitions need a manual source workflow.
No sync operation runs SQLMesh `plan`, `apply`, `run`, migrations or warehouse DDL.

## Current boundaries

- This is not full dbt parity: composite FKs, automatic source rewrites, model-level
  sync, additional warehouse adapters and domain execution
  remain open. dbt commands are blocked on the native integration.
- Model discovery covers SQL, seeds, external, Python/generated and disabled models
  as loaded by SQLMesh. Unknown schemas never become deletion suggestions.
- Freshness covers standard model/macro/audit/seed/external folders, root config,
  bindings and logical files. Environment variables, imported Python elsewhere,
  custom loaders, remote resources and subsequent warehouse changes require manual
  refresh. Observation timestamps indicate when metadata was read, not a live check.
- Readers accept export schemas 1 and 2; the exporter writes 2 with an `integrity`
  stamp and per-model `identifierFolding`. Sync plans use their own version 1 native
  contract. Credentials/config values/query bodies are not
  serialized. Names and descriptions remain project data; review before sharing.
- Verified on Linux/Python 3.13 with SQLMesh **0.236.1**, SQLGlot **30.8.0**, DuckDB
  **1.5.5**; PostgreSQL **17.11** over loopback TCP with psycopg2 **2.9.11**.
  Managed remote services, TLS deployments, other versions/platforms and production
  scale remain unverified.
  Source `_path`, context adapter injection and the state reader are internal
  SQLMesh interfaces isolated in the exporter; upgrades need regression tests.

## Validate locally

```sh
npm run compile
npm test
npm run build
npm run package
python -m venv .venv-sqlmesh
.venv-sqlmesh/bin/pip install -r integrations/sqlmesh/requirements-test.txt
.venv-sqlmesh/bin/python -m unittest discover -s integrations/sqlmesh -p 'test_*.py' -v
```

The checked-in native fixture/snapshot keeps JavaScript tests independent of a
Python installation. Python tests load real projects and exercise the custom
audit against disposable in-memory DuckDB tables. Warehouse tests deploy only to
temporary databases, then forbid deployment/migration during inspection and verify
database bytes, source drift, missing state, environment naming and lock release.
Regenerate the fixture with
`export.py --project test/fixtures/sqlmesh-project` after changing its inputs.
See [MCP instructions](../../mcp-server/README.md) for the separate build/smoke test.

### Real VS Code host checks

Run `npm run test:host` with VS Code's `code` command available and the pinned
`.venv-sqlmesh` environment prepared above. Override `VSCODE_EXECUTABLE` and
`SQLMESH_PYTHON` with absolute executable paths when needed. The runner builds and
type-checks its tests, then launches separate VS Code windows with temporary copies
of the dbt/SQLMesh fixtures, isolated settings, and an empty extensions directory.
It leaves results and logs under the printed `/tmp/erd-host-*` paths. It installs
no extension into your usual profile and starts no GitHub Actions.

These checks use the production React webview with a test-only message bridge and
real VS Code document, command, terminal and WorkspaceEdit APIs. They exercise
native activation/refresh, both stages, comparisons, source navigation, sync/undo,
stale-plan rejection and cancellation. An inert CLI probe verifies terminal arguments
and the configured Python PATH; it makes no AI request. A separate [installed-editor acceptance run](../../.planning/sqlmesh-editor-acceptance-results.md)
verified actual Claude source edits, canvas-focused undo and DuckDB inspection
without a test bridge. Windows/macOS and production warehouses remain unverified.
Tested locally on Linux with VS Code 1.138.0.

### PostgreSQL acceptance

Install `requirements-postgres-test.txt` in the test environment. On a **disposable**
PostgreSQL cluster, run:

```sh
ERD_TEST_POSTGRES_DSN='host=/tmp port=55437 user=erd_admin dbname=postgres' \
  .venv-sqlmesh/bin/python -m unittest discover -s integrations/sqlmesh \
  -p test_warehouse_postgres.py -v
```

The test account needs CREATE DATABASE/ROLE solely to create isolated fixtures;
each test removes its random database and roles. The inspection itself uses a
SELECT-only role. Tests cover quoted bindings, deployed/source drift, missing state,
unknown environments, permission failures and database-enforced write rejection.
Without the DSN these optional tests skip; ordinary DuckDB tests still run.
PostgreSQL was built under `/tmp` from the official 17.11 source archive, with its
published SHA-256 verified; no system package or privileged service was changed.

See [SQLMesh PostgreSQL configuration](https://sqlmesh.readthedocs.io/en/stable/integrations/engines/postgres/)
and [PostgreSQL read-only transaction defaults](https://www.postgresql.org/docs/17/runtime-config-client.html).
