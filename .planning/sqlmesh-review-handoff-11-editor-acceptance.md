# Claude handoff: SQLMesh integration hardening and editor acceptance

**Historical checkpoint:** the Linux installed-editor and real-Claude checks have
now been completed; see [acceptance results](sqlmesh-editor-acceptance-results.md)
and [current parity status](sqlmesh-parity-status.md).

## Requested review

Independently review the latest changes, report concrete defects with severity,
file/line references and reproduction steps, and recommend the next milestone.
Review only: do not edit source, switch branches, commit, push, deploy models,
open a PR, or trigger GitHub Actions as part of this handoff. Local checks are
appropriate; preserve unrelated work and use disposable fixtures.

## Repository and review range

- Workspace: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`.
- Active branch: `sqlmesh-integration`.
- Code HEAD and GitHub branch at handoff: `5a4a023dbf396feab64781b60e086337e0f26ff2`.
- Your earlier branch, `claude/sqlmesh-review-fixes`, remains at `0543a6c`.
  All its fixes and handoff notes are now ancestors of the integration branch.
- Focus on `git diff 0543a6c..5a4a023`; use `ecb9ba0..5a4a023` for the complete
  integration. Recheck status before starting. The tree was clean before adding
  this handoff and its index entry; those documentation changes are uncommitted.

The original goal is eventual dbt/SQLMesh feature parity. This remains a native
SQLMesh preview, with explicit metadata refresh, logical/physical comparison,
reviewed sync plans, and read-only local DuckDB inspection. Full parity is not
claimed. Background: [feasibility and progress](../sql-mesh-integration.md),
[setup and supported behavior](../integrations/sqlmesh/README.md), and
[your preceding review fixes](sqlmesh-review-handoffs.md).

## Latest implementation

1. **Prevent lossy column mappings.** Snowflake `ID` and distinct quoted `"id"`
   previously both imported as logical `id`. `assertLogicalColumnMapping` now
   rejects collisions and names outside the logical schema's lowercase naming
   rules before import or either sync direction writes anything. Coverage includes
   v4/v5 import, auto-added relationship endpoints, source/observed columns, and
   apply-time checks. Physical viewing and comparison remain available. Explicit
   column bindings are still needed to support these models fully.
2. **Correct uniqueness evidence.** Relationship cardinality resolves the actual
   column with exact-first matching, then checks uniqueness for that exact name.
   A quoted case-distinct sibling must not inherit another column's unique audit.
3. **Open model source.** Both stages expose an **Open model source** button using
   the exported source location. The provider accepts model identity, reloads
   metadata, and resolves the path server-side. Realpath checks reject missing
   files, non-files, and paths/symlinks outside the project. Generated models may
   share a source file; absent source locations produce no button.
4. **Real VS Code acceptance tests.** `npm run test:host` launches separate SQLMesh
   and dbt fixture windows with isolated profiles. It exercises production React
   webviews, command activation, the exporter subprocess, real documents,
   WorkspaceEdit/undo, source navigation, stale-plan refusal, cancellation,
   terminal argument/environment handling, and failed stage-switch recovery.

Start with `src/services/identifierMatching.ts`, `sqlmeshAdapter.ts`,
`sqlmeshSync.ts`, `src/providers/SemanticEditorProvider.ts`,
`webview/components/DetailPanel/DetailPanel.tsx`, and
`test/integration/index.ts` plus `scripts/test-extension-host.cjs`.

## Validation already completed

The implementation turn passed 1,664 JavaScript tests across 74 files, 21 Python
tests, TypeScript checks, development/production builds, MCP typecheck/build and
11 smoke checks, and both runtime dependency audits. The real host suite passed
8 SQLMesh checks and 2 dbt checks on Linux with VS Code 1.138.0. Existing React
`act` warnings were non-failing. No real warehouse was changed.

Existing environments use SQLMesh 0.236.1, SQLGlot 30.8.0, DuckDB 1.5.5 and Python
3.13. Useful rerun commands from the repository root:

```sh
npm run compile
npm test
.venv-sqlmesh/bin/python -m unittest discover -s integrations/sqlmesh -p 'test_*.py' -v
npm run test:host
```

Host tests accept absolute `VSCODE_EXECUTABLE` and `SQLMESH_PYTHON` overrides.
Previous evidence, re-read when preparing this handoff:
`/tmp/erd-sqlmesh-final-unit.log`, `/tmp/erd-sqlmesh-final-python.log`,
`/tmp/erd-host-sqlmesh-O6LH4L/results.json`, and
`/tmp/erd-host-dbt-CLYQl0/results.json`. These temporary files are not durable.

The rebuilt, ignored `erd-studio-sqlmesh-draft.vsix` was checked against the
production bundles and exporter; it was not published or installed in the normal
profile. SHA-256:
`f5d4026ee2f3bb9e52687e4e61dcf785e3f02f64a74a661533693b7dd624c673`.

## Review priorities and limits

- Check every import/sync entry point for bypasses or excessive rejection,
  especially existing logical models and relationship endpoints. Look for any
  remaining quoted-sibling ambiguity in comparison and relationship matching.
- Check source navigation's identity/path boundary, stale metadata, symlinks,
  shared generated sources, and dbt regressions.
- Scrutinize the host test bridge: it filters test observation packets and supplies
  a welcome-state flag. Undo explicitly focuses the domain text document; this
  does not prove every custom-editor focus behavior. The terminal test uses an
  inert Node probe, **not a real Claude editing session**. Windows/macOS and the
  minimum supported VS Code 1.85 were not exercised as real hosts.
- Retain the explicit-refresh boundary: opening/watching/MCP reads do not execute
  project Python. DuckDB inspection is read-only, restricted to supported local
  files, and keeps source metadata separate from observations. Config/macros
  execute trusted project code; this is not a sandbox.

Suggested next milestone: resolve review findings, then verify one real
Claude-assisted logical-to-source edit in a disposable SQLMesh project through
refresh and comparison. After that, prioritize explicit column bindings,
composite relationships, broader model lifecycle support, and one selected remote
warehouse adapter. Domain execution and generated/Python/seed/external source-edit
workflows also remain incomplete; confirm priorities with the user before expanding.
