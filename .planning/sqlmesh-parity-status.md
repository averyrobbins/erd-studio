# SQLMesh parity — current status

Core workflow near parity, implemented through **2ba5690** on `sqlmesh-integration`.
The accepted steps 1–5 were pursued in order with disposable projects and local
validation. This is a development preview, not a claim of universal dbt/SQLMesh parity.

## Completed sequence

1. **Review/correctness:** reviewed `0543a6c..5a4a023`; fixed identifier matching,
   source/observed column identity, design badges and assistant Python environment.
2. **Installed editor:** verified real Claude source edits, refresh/comparison,
   grouped undo and deployed DuckDB inspection in an isolated VS Code profile.
3. **Evidence:** consolidated the original analysis, current setup/status and
   acceptance results; historical handoffs remain linked for provenance.
4. **Column bindings:** exact native identifiers map to safe logical aliases through
   import, display, comparison, relationships, sync, assistant plans and MCP.
5. **Remaining workflow:** opt-in automatic metadata refresh; read-only PostgreSQL;
   reviewed interactive domain planning; assisted native model creation and undoable
   domain detachment. Reviewed composite relationships and retained an explicit gap
   rather than infer tuple validity from independent single-column checks.

## Validation at completion

- TypeScript compilation and production packaging passed.
- 1,713 JavaScript tests / 76 files; 31 Python tests, including five PostgreSQL cases.
- MCP typecheck/build and 13 smoke checks; 9 SQLMesh + 2 dbt real VS Code host checks.
- Installed VSIX: three real Claude edits/creation, quoted alias import, automatic
  refresh in both comparisons, domain planner reaching its Apply prompt (answered
  no), and model detachment/native undo restoring exact domain bytes.
- DuckDB bytes unchanged across source-only creation/refresh and read-only inspection.
- Linux, VS Code 1.138.0, SQLMesh 0.236.1, SQLGlot 30.8.0, DuckDB 1.5.5,
  Python 3.13.15; disposable PostgreSQL 17.11 loopback TCP acceptance.
- No worktrees, PR, release, production deployment or deliberate GitHub Actions run.

## Remaining limitations and next decisions

| Area | Boundary / next step |
|---|---|
| Composite FK | Shared schema stores single-column edges. Add explicit ordered tuple groups and a real tuple audit before claiming compound FK/cardinality parity. |
| Model deletion | Logical detachment retains shared YAML. Native deletion remains manual pending downstream/state/history impact review. |
| Source synthesis | Assisted SQL creation/edits require known expressions and model kind. Generated/Python/seed/external source changes stay manual. |
| Warehouse breadth | DuckDB files and PostgreSQL, single native project/gateway and built-in scheduler. Validate a specific next engine with restricted credentials. |
| Freshness | Standard local input hashes; external imports, environment variables, remote inputs and warehouse changes require explicit refresh/inspection. |
| Portability | Windows/macOS, other SQLMesh versions, production scale and cloud TLS/authentication remain unverified. |

Recommended next step: independent review using [handoff 12](sqlmesh-review-handoff-12-near-parity.md),
then a pilot on a representative native SQLMesh project. Choose composite relationships
or a concrete warehouse engine after that review. No additional deployment is implied.
