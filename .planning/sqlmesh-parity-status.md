# SQLMesh parity — current status

Core workflow near parity on `sqlmesh-integration`; the implementation baseline is
**2ba5690**, followed by the review corrections recorded below.
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

## Review follow-up (2026-09-22)

Reviewed the five corrections against **420f267** and independently reran local
checks before committing. Physical viewing now tolerates unrepresentable observed
columns while import/sync guards remain; domain-plan artifacts no longer invalidate
sync or refresh canvases; environment/timeout settings preserve observations;
explicit refresh cancels automatic work and waits for cleanup before taking its
slot; selector punctuation/whitespace gets manual-selection guidance.

Latest validation: **1,745 JavaScript tests / 76 files**, compile, **26 Python passed
and 5 PostgreSQL skipped** (31 discovered), **13 MCP checks**, **9 SQLMesh + 2 dbt
real-host checks**, and production VSIX packaging. PostgreSQL was not restarted or
retested during this follow-up; the earlier five successful cases remain historical
acceptance evidence. Harness versions and schema content are unchanged.

Known display follow-up: a warehouse-only native column can fold onto an existing
logical alias (for example, binding `order_note: amount` plus observed `ORDER_NOTE`).
Physical can show two `order_note` rows with distinct `nativeName` values. The view
remains available and sync refuses the collision. Give conflicting observed rows
an explicit native identity/label without weakening write guards; this was left
outside the five reviewed fixes.

## Remaining limitations and next decisions

| Area | Boundary / next step |
|---|---|
| Composite FK | Shared schema stores single-column edges. Add explicit ordered tuple groups and a real tuple audit before claiming compound FK/cardinality parity. |
| Model deletion | Logical detachment retains shared YAML. Native deletion remains manual pending downstream/state/history impact review. |
| Source synthesis | Assisted SQL creation/edits require known expressions and model kind. Generated/Python/seed/external source changes stay manual. |
| Warehouse breadth | DuckDB files and PostgreSQL, single native project/gateway and built-in scheduler. Validate a specific next engine with restricted credentials. |
| Freshness | Standard local input hashes; external imports, environment variables, remote inputs and warehouse changes require explicit refresh/inspection. |
| Portability | Windows/macOS, other SQLMesh versions, production scale and cloud TLS/authentication remain unverified. |

Recommended next step: resolve the observed-column display ambiguity, then pilot
on a representative native SQLMesh project. The review begun with
[handoff 12](sqlmesh-review-handoff-12-near-parity.md) is covered above. Choose tuple
relationships or another warehouse engine after the pilot. No deployment is implied.
