# SQLMesh integration feasibility

Assessed 2026-09-20 against ERD Studio **1.0.5**, commit `ecb9ba0108d759b386aa4fa192190ee25f0f06da`, on branch `sqlmesh-integration`. Based on repository source, tests, SQLMesh stable documentation, and selected upstream implementation details. The assessment below describes that baseline; the first-draft implementation status is recorded at the end.

## Conclusion

**Supporting native SQLMesh alongside dbt is feasible, but requires an integration layer, not just another manifest parser.** Most of the logical editor can be reused. The substantial work is extracting SQLMesh metadata, resolving model identities, interpreting audits, and adapting refresh, sync, domain selection, and AI/MCP workflows.

Recommend **one ERD Studio application with separate dbt and SQLMesh adapters**, plus a small Python companion for SQLMesh metadata extraction. Full parity with ERD Studio's current user workflows is a reasonable target for a documented set of supported models and audit conventions. Universal inference of relationships from arbitrary SQL/Python is not.

Here, parity means equivalent ERD Studio capabilities for each framework. It does not mean making SQLMesh's execution, versioning, and deployment semantics identical to dbt's.

## What the repository actually does

| Area | Finding and integration consequence |
|---|---|
| Logical editor | Domain JSON references shared model YAML in `.erd-studio/logical-models/`. React Flow, ELK layout, keys, grain, roles, SCD annotations, rationale, templates, model library, and undo/redo are broadly reusable. See [domain types](src/types/semantic.ts), [logical model service](src/services/logicalModelService.ts), and [webview](webview/). |
| Activation and configuration | [package.json](package.json) and `resolveDbtProjectRoot()` in [extension.ts](src/extension.ts) require `dbt_project.yml`. [DbtProjectConfig](src/services/dbtProjectConfig.ts) supplies all artifact/source paths. Even logical-only setup currently needs a dummy dbt file. |
| Physical view | `buildPhysicalDomain()` in [domainService.ts](src/services/domainService.ts) combines source-file existence, schema YAML, manifest, and optional catalog. Warehouse types take precedence; declarations supply missing detail. It renders the domain's logical model list, including missing-model placeholders, rather than a complete warehouse inventory. |
| Relationships and semantics | Physical edges come from YAML/manifest relationship-test declarations; standalone/composite uniqueness tests determine cardinality. PK/FK/NK badges, grain, role, SCD and additive annotations are carried from the logical design. They are not independently verified warehouse constraints. |
| Comparison and sync | [DiscrepancyService](src/services/discrepancyService.ts) compares generic display objects and is reusable. [SyncPlan](src/types/syncPlan.ts), [SemanticEditorProvider](src/providers/SemanticEditorProvider.ts), and [HarnessService](src/services/harnessService.ts) embed dbt paths, YAML tests, `requiresCompile`, and `dbt compile`. Sync generates instructions for an AI assistant; it is not a deterministic SQL generator. |
| Domain commands and refresh | [SelectorsService](src/services/selectorsService.ts) maintains `selectors.yml` without changing model tags. [Watchers](src/watchers/FileWatcherService.ts), [staleness checks](src/services/stalenessService.ts), provenance types and UI notices assume dbt artifacts. |
| Companion applications | The read-only [MCP server](mcp-server/src/services.ts) also requires `dbt_project.yml`. Its [physical listing](mcp-server/src/tools/list_manifest_models.ts) reads only the manifest, not the editor's YAML/catalog union, and returns column counts rather than column details despite its description. The [Forge resolver](forge-app/src/resolvers/index.js) displays logical files fetched from GitHub; the [feedback proxy](proxy/README.md) is unrelated to model integration. |

The current dbt integration is itself bounded: short-name indexing, selected test patterns, and uneven resource coverage. For example, the [manifest extractor](src/workers/manifestExtractor.ts) indexes `model.*`, while the [catalog reader](src/types/catalog.ts) also accepts seeds and snapshots. Establish parity from tested behavior, rather than assuming every dbt feature is supported.

## Feature mapping

| Existing capability | SQLMesh approach | Assessment |
|---|---|---|
| Discover project; set up logical modelling | Recognize SQLMesh `config.yaml` / `config.py`, with explicit provider/project selection when ambiguous. Allow logical-only setup without either framework. [Configuration guide](https://sqlmesh.readthedocs.io/en/stable/guides/configuration/). | Straightforward; avoid treating every generic config file as a SQLMesh project. |
| Add existing models; open source files | Export loaded models and their actual source locations using SQLMesh's Python context. Include SQL, Python, seed, external, and generated models. [Context API](https://sqlmesh.readthedocs.io/en/stable/_readthedocs/html/sqlmesh/core/context.html). | Feasible; generated models can share a source file. |
| Show columns, types, descriptions | Export `columns_to_types`, `column_descriptions`, model description, dialect and kind; distinguish explicit metadata from inferred output. These are available through the [model API](https://sqlmesh.readthedocs.io/en/stable/_readthedocs/html/sqlmesh/core/model/definition.html). | Strong fit. Unknown types must remain unknown. |
| Enrich with actual warehouse schema | Resolve the selected environment's deployed relation and query engine metadata. SQLMesh provides environment-aware `table_name()` and an engine-adapter `columns()` operation. Comments/order may need engine-specific enrichment. [Context API](https://sqlmesh.readthedocs.io/en/stable/_readthedocs/html/sqlmesh/core/context.html), [engine adapter](https://github.com/TobikoData/sqlmesh/blob/main/sqlmesh/core/engine_adapter/base.py). | Feasible; requires credentials and explicit environment/gateway selection. |
| Derive FK edges and cardinality | Recognize `unique_values`, `unique_combination_of_columns`, and a documented custom relationship audit with explicit parent/child columns. SQLMesh supports parameterized custom audits. [Audits](https://sqlmesh.readthedocs.io/en/stable/concepts/audits/). | Largest semantic gap; conventions required. |
| Preserve dimensional design | Keep business grain text, keys, role, rationale, and column SCD/additivity in logical YAML. Optionally expose SQLMesh grain/kind separately. A SQLMesh model kind is execution metadata, not a complete dimensional design. [Model configuration](https://sqlmesh.readthedocs.io/en/stable/reference/model_configuration/). | Reuse existing editor. |
| Compare and choose either source of truth | Feed normalized SQLMesh data into the existing discrepancy UI; adapt identifier matching and type normalization for the model dialect. Retain missing/unknown distinction and stub suppression. | Mostly reusable after identity work. |
| Generate and execute sync plans | Add provider, canonical model ID, actual SQL/Python/audit paths, and framework-specific validation steps. Teach the harness to edit `MODEL` / `@model` definitions and audits. | Feasible with the same AI-assisted execution model as dbt. |
| Build/select a domain | Translate stored domain membership into SQLMesh model selections, offering plan and run workflows with explicit environment and dependency scope. [Selection guide](https://sqlmesh.readthedocs.io/en/stable/guides/model_selection/). | Equivalent outcome; different commands and planning semantics. |
| Refresh, stale indicators, AI/MCP access | Share the adapter's metadata snapshot between extension and MCP. Add SQLMesh watches, refresh actions, provenance labels and tailored instructions. | Required for full workflow parity. |

SQLMesh's existing [dbt integration](https://sqlmesh.readthedocs.io/en/stable/integrations/dbt/) runs projects that retain dbt files. It does **not** solve ingestion of native SQLMesh projects. Likewise, generating imitation dbt manifests would leave activation, identity, sync and command behavior unresolved.

## Recommended design

1. **Introduce a framework-neutral project adapter.** Move dbt extraction/merging behind it first. Return a versioned project snapshot containing canonical IDs, display names, source locations, columns, descriptions, relationship evidence, uniqueness groups, capabilities, diagnostics and freshness. Let the existing domain/display layer consume that contract.

2. **Use SQLMesh's Python loader, then export plain JSON.** A companion launched in the project's Python environment should load `Context`, normalize its model metadata, and atomically write an ERD-owned artifact. The TypeScript extension and MCP server read that artifact. Offer artifact-only viewing when Python is unavailable. The documented [CLI](https://sqlmesh.readthedocs.io/en/stable/reference/cli/) provides rendering, DAG and state-export operations, but no native dbt-style project manifest/catalog contract; exported state is not a substitute for current, unapplied source metadata.

3. **Keep logical IDs separate from framework IDs.** Add a versioned integration/binding file mapping a logical name such as `dim_customer` to a SQLMesh project and canonical qualified name. Preserve existing v5 domains and YAML. `sales.orders` and `support.orders` must remain distinct, and quoted identifiers must retain dialect-sensitive identity. Today's [lowercase matching](src/services/nameUtils.ts) and [authoring-name rules](src/types/naming.ts) cannot safely serve as universal SQLMesh identifiers. SQLMesh itself normalizes qualified names using dialect and catalog context. [Model metadata implementation](https://github.com/TobikoData/sqlmesh/blob/main/sqlmesh/core/model/meta.py).

4. **Separate source metadata from warehouse observations.** Record provider/version, source revision, gateway, environment, observed relation and observation time. Expose whether data was declared, inferred, or observed. Local code can differ from what is deployed; SQLMesh environments can point at different model versions. [Environments](https://sqlmesh.readthedocs.io/en/stable/concepts/environments/). An old observation must not silently claim to describe newly edited SQL.

5. **Share services across extension and MCP.** Keep adapter code free of VS Code imports, retain existing dbt commands/settings as compatibility aliases, and introduce generic model-listing/refresh operations. Preserve Forge's logical-file contract; it does not need a SQLMesh runtime for its current functionality.

## Limitations and blockers

- **Relationship discovery needs an explicit contract.** SQLMesh's `depends_on` expresses transformation dependencies. `grain`/`references` describe keys and possible joins, including expressions and aliases; they do not demonstrate that FK values exist in a particular parent. [Model overview](https://sqlmesh.readthedocs.io/en/stable/concepts/models/overview/). The inspected [built-in audit source](https://github.com/TobikoData/sqlmesh/blob/main/sqlmesh/core/audit/builtin.py) contains a relationship audit only as commented-out code. Ship a tested custom audit convention and allow mappings for existing custom audits. Retain composite column pairs as a group even if the canvas draws individual edges. Preserve null/filter, blocking and interval semantics; audit declarations are not proof of a successful run. Incremental audits may cover only processed intervals. [Auditing behavior](https://sqlmesh.readthedocs.io/en/stable/concepts/audits/).

- **Full native loading adds a Python/runtime dependency.** SQLMesh configuration, macros and Python-generated models can execute project code; loading/rendering is not guaranteed to be offline or side-effect-free. Use the selected project environment, workspace trust, subprocess timeouts and an explicit refresh policy. A simple TypeScript SQL parser cannot provide full native parity. SQLMesh supports [Python-defined SQL models](https://sqlmesh.readthedocs.io/en/stable/concepts/models/sql_models/) and [Python models](https://sqlmesh.readthedocs.io/en/stable/concepts/models/python_models/), so source-file parsing alone is insufficient.

- **Observed schema is optional and engine-dependent.** Unbuilt/embedded models may have no relation to inspect; unavailable metadata is not evidence that a project model is absent. `external_models.yaml` describes external dependencies, not the warehouse schema of every SQLMesh output. `create_external_models` retrieves external metadata and writes that file; it is not a general catalog replacement. [External models](https://sqlmesh.readthedocs.io/en/stable/concepts/models/external_models/), [model kinds](https://sqlmesh.readthedocs.io/en/stable/concepts/models/model_kinds/).

- **Domain execution cannot be translated mechanically.** `--select-model` selects changes for a plan; downstream effects and backfill selection have separate rules. `run` processes an environment's missing intervals and does not deploy local edits. Generate reviewable framework-specific commands rather than replacing `dbt build` with one SQLMesh command. [Selection guide](https://sqlmesh.readthedocs.io/en/stable/guides/model_selection/), [CLI reference](https://sqlmesh.readthedocs.io/en/stable/reference/cli/). Keep domain membership outside model metadata so moving a model between diagrams does not itself rewrite transformation definitions.

- **Version compatibility and editing fidelity need testing.** Pin a supported SQLMesh/SQLGlot range and version the export contract. Some useful details, notably source `_path`, are internal implementation attributes. Generated models and macro-derived audit arguments may not have a simple editable declaration. Report unsupported cases; do not guess filenames or regenerate entire source files. Existing dbt type matching is deliberately tolerant, and the UI offers a small type menu, so parity alone does not guarantee lossless authoring of every warehouse type.

- **Distribution has a licensing constraint.** This repository uses [PolyForm Shield](LICENSE), including a restriction on providing competing products—even free ones. An integration contributed to ERD Studio is a different proposition from distributing a competing standalone fork. Resolve permission for the intended distribution model before committing to that route. [License text](https://polyformproject.org/licenses/shield/1.0.0).

## Implementation outline and acceptance gates

1. **Define the parity contract.** Inventory current dbt fixtures and user actions; specify supported SQLMesh versions, model kinds, dialects, audit forms, and offline/observed modes. Agree on bindings and relationship evidence before changing parsers.
2. **Extract the dbt adapter.** Refactor project detection, metadata merging and refresh without changing current dbt behavior. Preserve v4/v5 handling, legacy settings/commands, YAML comments, shared models and domain scoping. Existing dbt tests become the regression gate.
3. **Prove SQLMesh extraction.** Build the Python exporter and JSON contract using a disposable DuckDB fixture: SQL models, seed, Python/generated model, external source, disabled model, and duplicate basenames across schemas. Verify IDs, source paths, types, descriptions and diagnostics before UI work.
4. **Connect editor workflows.** Implement SQLMesh discovery/settings, explicit provider selection, Add Existing Model, source navigation, Physical view and comparisons. Replace dbt-only labels/provenance fields; add debounced watches for configuration, models, macros, audits, seeds and external declarations. Test timeout, malformed/partial artifacts, deletion, branch changes and stale-cache recovery.
5. **Complete relationships and observations.** Add the custom FK audit and adapters for recognized audits, including composite keys and conditional/non-blocking cases. Add optional environment-aware warehouse introspection. Verify inferred/declared/observed differences and metadata-access failures.
6. **Complete sync and domain execution.** Version sync plans; supply exact source locations and SQLMesh harness instructions for every existing action in both directions. Validate edited models, run fixture tests/audits as appropriate, regenerate metadata and compare again. Exercise SQLMesh plans only against disposable development environments; ordinary diagram refresh must not apply a plan.
7. **Finish all delivery surfaces.** Update MCP tools/setup text, README, schema/harness references, settings and package metadata. Package the companion deliberately: the existing [.vscodeignore](.vscodeignore) and [CI packaging gate](.github/workflows/ci.yml) assume a small JavaScript bundle. Validate installation/runtime discovery across supported OS and remote-workspace configurations; verify Forge still renders unchanged logical files.
8. **Prove parity before release.** Use equivalent dbt/SQLMesh fixtures to compare normalized physical models, edges, cardinality, discrepancies and sync resolutions. Include quoted names, custom paths, complex types, unknown columns, generated models, composite keys, multiple environments, and absent/stale/partial observations. Run the repository's compile/build/unit/package checks and MCP build/smoke checks locally. A read-only SQLMesh diagram is the first milestone; full parity requires steps 5–8.

Original assessment boundary: source and test review only. Subsequent first-draft validation is described below.

## First-draft implementation

The branch now contains the first working metadata/editor integration. It adds a
shared adapter boundary, native project detection and settings, an explicitly
invoked Python exporter, stable qualified identities and logical aliases, Add
Existing Model, Physical view, comparison, freshness/provenance diagnostics,
SQLMesh AI instructions, and read-only MCP `list_project_models`. dbt retains its
existing readers and workflows. See the [setup guide](integrations/sqlmesh/README.md).

A supplied `erd_relationship` audit provides single-column FK evidence. Recognized
unfiltered uniqueness audits determine cardinality. Unknown schemas and unsupported
audit arguments are reported without inventing columns or relationships. The export
is source metadata; it does not establish warehouse state or successful audit runs.
Opening diagrams, file watching and MCP reads never execute Python. Explicit refresh
requires a trusted workspace and runs in the selected project environment.

The implementation is deliberately short of full parity: warehouse observation,
composite FK semantics, automated sync/source editing, model-source navigation and
domain plan/run generation remain open. Freshness covers standard project paths,
not environment variables, arbitrary imported code, remote resources or warehouse
changes. Cross-platform/engine behavior and production-scale performance remain
unverified. The native fixture covers SQL, seed, external, Python/generated and
disabled models, duplicate basenames and an FK audit; exporter validation uses
SQLMesh 0.236.1, SQLGlot 30.8.0 and disposable DuckDB tables locally.

Validation completed: TypeScript checks, development/production builds, **1,582
JavaScript tests across 67 files**, **6 Python integration tests**, MCP type-check/
build/smoke checks, and a packaged VSIX (15 files, including the exporter). Both
runtime dependency audits reported zero vulnerabilities. A browser preview of the
real webview verified native model details/import options, FK rendering, comparison
and the disabled sync entry point. VS Code activation/editing is covered with the
repository's mocked host tests; installation in a real VS Code host has not been
tested. No SQLMesh deployment plan was applied and no warehouse was changed.
