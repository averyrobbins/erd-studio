# SQLMesh integration — first draft

This branch adds native SQLMesh discovery, model import, logical editing, Physical
view, comparison, AI instructions, and read-only MCP inspection. dbt keeps its
existing integration. SQLMesh Physical means **source metadata**, not the deployed
warehouse. Automated SQLMesh sync and domain execution are not available yet.

## Try it

The locally built `erd-studio-sqlmesh-draft.vsix` can be selected with VS Code's
**Extensions: Install from VSIX** command. It has not been installed automatically.
Alternatively, use the source workflow below.

1. From this repository, run `npm ci` and `npm run build`. Open the repository in
   VS Code and press **F5** to launch the extension development host.
2. In that new window, open your SQLMesh project (or this repository's
   `test/fixtures/sqlmesh-project`). Native `config.yaml`, `config.yml`, or
   `config.py` is detected without a dummy dbt file. For mixed projects, set
   `erdStudio.provider` to `sqlmesh`; automatic detection prefers dbt.
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

The audit allows null child keys and returns orphaned non-null keys. Unfiltered
`unique_values` audits establish single-column uniqueness for cardinality.
`unique_combination_of_columns` is exported as grouped metadata; composite FK
cardinality is deferred. These are **audit declarations**, not evidence of passing
audits. Lineage, `grain`, and `references` do not automatically become ERD edges.
Other custom audits, filtered uniqueness, and unresolved arguments are diagnosed
or omitted. Copying the convention does not run the audit.

## Current boundaries

- No environment-aware warehouse catalog, SQLMesh sync plans, automatic source
  edits, domain plan/run commands, or composite FK support. dbt commands are
  blocked on the native integration; the installed AI harness explains the limits.
- Model coverage is whatever SQLMesh Context loads: SQL, seeds, external models,
  Python and generated SQL. Disabled models are excluded. Unknown columns remain
  unknown and do not become deletion suggestions. Model source paths are exported
  where available; direct model-source navigation is not added in this draft.
- Freshness covers standard model/macro/audit/seed/external folders, root config,
  and bindings. Environment variables, imported Python outside those folders,
  custom loaders, remote resources, and warehouse changes need explicit refresh;
  they are not fingerprinted. An artifact alone cannot detect deployed drift.
- Schema version 1 is validated, including identities, endpoints and relative
  paths. Configurations, credentials and SQL query bodies are not serialized.
  Source descriptions and names remain project data; review snapshots before sharing.
- Verified locally on Linux/Python 3.13 with SQLMesh **0.236.1**, SQLGlot **30.8.0**
  and DuckDB **1.5.5**. Other versions, dialect execution, operating systems,
  remote workspaces, and large-project performance are unverified. `_path` is a
  SQLMesh internal attribute used only for optional source location.

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
audit against disposable in-memory DuckDB tables. Regenerate the fixture with
`export.py --project test/fixtures/sqlmesh-project` after changing its inputs.
See [MCP instructions](../../mcp-server/README.md) for the separate build/smoke test.
