# SQLMesh parity work — current status

Active work on `sqlmesh-integration`. This is the current execution checklist;
the numbered review handoffs remain historical records. User authorized steps
1–5 in order, disposable sibling projects, local testing and periodic commits/pushes.
No worktrees. Do not mark full parity from fixture-only or mocked evidence.

## Acceptance sequence

1. **Correctness and review** — implemented. Relationship endpoints, observed
   columns and design badges now use one-to-one matching. The selected Python
   environment owns PATH/VIRTUAL_ENV consistently. Typechecks, 1,673 JS tests,
   production build and 11 MCP smoke checks pass. Review of `0543a6c..5a4a023`
   found these additional identity/environment issues; source navigation bounds,
   import/sync rejection paths and existing dbt regressions remain covered.
2. **Complete editor workflow** — passed on Linux. A UV-created SQLMesh/DuckDB
   sibling exercised the installed custom editor, two real Claude source edits,
   refresh/comparison, canvas-focused undo and deployed schema inspection.
   See [acceptance evidence](sqlmesh-editor-acceptance-results.md).
3. **Consolidated evidence** — documented. Current status and acceptance evidence
   are linked from the historical handoffs and setup guide.
4. **Explicit column bindings** — passed. Map safe logical names to exact native
   identifiers consistently in import, display, comparison, relationships, both
   sync directions and AI/MCP guidance, with invalid/ambiguous mappings rejected.
   Installed editor imported a spaced identifier, displayed its native hint, and
   generated the correct alias-to-native source plan. 1,684 full JS tests plus
   a stale-selection regression, 24 Python tests and 12 MCP smoke checks pass.
5. **Automation and warehouse parity** — pending. Add optional metadata refresh
   after source edits; support and verify one remote-protocol warehouse adapter;
   work through domain execution, model lifecycle, composite relationships and
   other gaps against the actual dbt workflow baseline.

## Completion gates

- Native SQLMesh and dbt share the existing logical-file/editor contract.
- Supported model kinds, quoted identifiers, audit evidence, source vs deployed
  metadata, unknown/unavailable state and stale-plan handling have acceptance cases.
- Source-edit plans and metadata-to-logical changes preserve design annotations,
  source semantics and correct identifiers. User warehouse deployment is separate.
- Existing dbt checks, SQLMesh Python checks, MCP checks and real editor checks pass.
- Packaging is current; remaining platform/version/model-kind limitations are
  stated without describing unverified behavior as supported.
- Remote branches include validated work. Local test evidence is preferred; no
  GitHub Actions are deliberately triggered as part of this work.

The computer may be suspended only after the full goal has passed its completion
audit, then a ten-second wait, as requested by the user. An intermediate checkpoint
is not permission to suspend.
