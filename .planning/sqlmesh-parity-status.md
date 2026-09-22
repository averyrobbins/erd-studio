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

## Pilot and composite relationships (2026-09-22)

The display follow-up is fixed in **3930c47**: conflicting warehouse-only rows get
native display labels while source aliases, comparisons and write guards remain intact.

The new sibling `../erd-studio-sqlmesh-pilot` contains 10 native models, 40 customers
and 300 order lines. Installed-extension acceptance covered import, tuple editing
and undo, automatic source refresh, metadata-to-logical sync, read-only warehouse
inspection, alias-conflict refusal and a reviewed domain-plan artifact. Final
Logical/Physical comparison is all matched after an explicit disposable dev deployment.

Composite FKs now preserve complete ordered `columnPairs` across both adapters,
editor mutations, display, comparison, sync and MCP. Executable SQLMesh audits and
dbt generic tests check whole parent tuples with MATCH SIMPLE null semantics.
Independent single-column tests no longer imply composite uniqueness. Shared
harness versions are **dbt 18 / SQLMesh 6**; v5 single-column domains remain compatible.

Current verification: **1,772 JS tests / 78 files**, **28 Python passed + 5 PostgreSQL
skipped**, **one real dbt/DuckDB integration test**, **16 MCP smoke checks**, **10 SQLMesh
+ 2 dbt real-host checks**, TypeScript and production VSIX. Tuple execution is verified
on DuckDB in both engines; PostgreSQL was not restarted. See
[pilot evidence and review scope](sqlmesh-pilot-composite-results.md).

## Remaining limitations and next decisions

| Area | Boundary / next step |
|---|---|
| Composite FK portability | Implemented and tested with SQLMesh/dbt on DuckDB. Verify tuple audits/tests against each additional warehouse; custom audit/test conventions are not automatically mapped. |
| Model deletion | Logical detachment retains shared YAML. Native deletion remains manual pending downstream/state/history impact review. |
| Source synthesis | Assisted SQL creation/edits require known expressions and model kind. Generated/Python/seed/external source changes stay manual. |
| Warehouse breadth | DuckDB files and PostgreSQL, single native project/gateway and built-in scheduler. Validate a specific next engine with restricted credentials. |
| Freshness | Standard local input hashes; external imports, environment variables, remote inputs and warehouse changes require explicit refresh/inspection. |
| Portability | Windows/macOS, other SQLMesh versions, production scale and cloud TLS/authentication remain unverified. |

Recommended next step: independent review of the tuple change, then select a real
warehouse/project for a restricted-credential acceptance run. Native source deletion
remains a separate design decision. No production deployment is implied.
