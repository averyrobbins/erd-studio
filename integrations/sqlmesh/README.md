# SQLMesh integration — development preview

This branch adds native SQLMesh discovery, model import, logical editing, Physical
view, comparison, AI instructions, and read-only MCP inspection. dbt keeps its
existing integration. Physical combines **source metadata** with optional, explicitly
requested DuckDB observations. Native sync updates the logical design deterministically
or prepares source edits for an assistant. Deployment remains a separate user action.

## Try it

The locally built `erd-studio-sqlmesh-draft.vsix` can be selected with VS Code's
**Extensions: Install from VSIX** command. It has not been installed automatically.
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
   Windows). Optional workspace settings: `erdStudio.sqlmesh.gateway` and
   `erdStudio.sqlmesh.config` (a Python configuration object name).
4. Run **ERD Studio: Refresh Project Metadata**. This explicitly executes trusted
   project configuration/macros and produces `.erd-studio/sqlmesh.json`. It never
   invokes SQLMesh plan, apply, run, model evaluation, or audit execution. SQLMesh
   loading can still execute user code, access services, and create caches/logs.
   VS Code workspace trust is required for this command.
5. Run **ERD Studio: Set Up Semantic Domains Directory**, open/create a domain,
   and choose **Add Existing Model → SQLMesh**. Switch to **Physical** or compare
   the stages. The supplied fixture already has an `orders` domain.

An exported snapshot can be viewed without Python. Opening a diagram, watching
files, and MCP reads never launch the exporter. Source changes mark the snapshot
stale; explicitly refresh it. Malformed replacement exports retain the last good
snapshot with a warning; deleting the export clears it.

For command-line export, use absolute paths:

```sh
/path/to/project/.venv/bin/python /path/to/erd-studio/integrations/sqlmesh/export.py \
  --project /path/to/project
```

`--semantic-dir docs/erd`, `--gateway local`, and `--config config_test` are optional.
The VSIX bundles this script as `dist/sqlmesh_export.py`; it does not bundle Python
or SQLMesh. Do not edit the generated JSON.

## Model identity and relationships

Exports retain canonical, qualified SQLMesh names. ERD model names must be safe
file names, so default aliases combine schema/name with a stable identity hash.
To match an existing logical model, create `.erd-studio/sqlmesh-bindings.json`:

```json
{"version":1,"models":{"dim_customer":"analytics.dim_customer","fct_order":"analytics.fct_order"}}
```

Refresh after editing bindings. Renaming a bound logical model requires updating
its binding too. Bindings are one-to-one; changing the catalog changes identity.
SQLMesh IDs and column case are preserved through the metadata adapter/comparison.

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

## Inspect a deployed DuckDB environment

Set `erdStudio.sqlmesh.environment` (default `prod`), then run **ERD Studio: Inspect
SQLMesh Warehouse (DuckDB)**. CLI equivalent: add `--environment dev` to the export
command. **Refresh Project Metadata** returns to source-only mode and clears previous
observations; repeat inspection for a new warehouse snapshot.

This first implementation supports one native project, one gateway, the built-in
scheduler, and plain local DuckDB files for both warehouse and state (a separate
state file is supported). In-memory databases, remote engines, attachments,
connection hooks/extensions and multiple gateways are rejected. Close any process
holding a writable DuckDB connection before inspecting; database locks are reported
as unavailable metadata.

The exporter reads SQLMesh's existing, finalized environment state and resolves its
promoted models to consumer relations, honoring environment suffixes/catalog mapping.
It opens DuckDB with `read_only=True`, bypasses normal connection setup, never uses
SQLMesh's state accessor that can initialize/migrate state, and closes connections.
It does not query model rows, deploy models or run audits. Project config/macros
still execute as trusted Python, so this is not a sandbox for arbitrary project code.

Exports retain source columns separately from observations. Observed column types
win in Physical; the column list is the union, retaining source-only columns.
The notice and model details show environment, time, coverage, relation and status:
`observed`, `not-deployed`, `unavailable`, or `unsupported`. Failed inspection does
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
- **Edit source with Claude** launches the existing reviewed terminal workflow with
  native SQLMesh instructions. Other assistants can read the same plan and the
  installed ERD Studio harness. Source edits support SQL model files: declarations,
  projections and the FK/uniqueness audit convention. The assistant must verify
  hashes, preserve model logic/kind, validate locally, and refresh/compare afterward.
  Missing transformation expressions require user input; this is AI-assisted source
  editing, not a deterministic SQL rewriter. Export source-only metadata before
  generating a source plan so deployed drift is not confused with source drift.

Changed/dirty inputs, replaced plans, stale metadata, unknown authoritative types,
unsupported source models and mixed directions are rejected. Model creation/removal,
Python/generated models, seeds and external definitions need a manual source workflow.
No sync operation runs SQLMesh `plan`, `apply`, `run`, migrations or warehouse DDL.

## Current boundaries

- This is not full dbt parity: composite FKs, automatic source rewrites, model-level
  sync, model-source navigation, remote warehouse adapters and domain execution
  remain open. dbt commands are blocked on the native integration.
- Model discovery covers SQL, seeds, external, Python/generated and disabled models
  as loaded by SQLMesh. Unknown schemas never become deletion suggestions.
- Freshness covers standard model/macro/audit/seed/external folders, root config,
  bindings and logical files. Environment variables, imported Python elsewhere,
  custom loaders, remote resources and subsequent warehouse changes require manual
  refresh. Observation timestamps indicate when metadata was read, not a live check.
- Readers accept export schemas 1 and 2; the exporter writes 2. Sync plans use their
  own version 1 native contract. Credentials/config values/query bodies are not
  serialized. Names and descriptions remain project data; review before sharing.
- Verified on Linux/Python 3.13 with SQLMesh **0.236.1**, SQLGlot **30.8.0**, DuckDB
  **1.5.5**. Other versions/platforms and production scale remain unverified.
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
