# Handoff 12 — native SQLMesh near-parity review

Branch: `sqlmesh-integration`. Implementation head: **2ba5690**. Whole new review
range: **5a4a023..2ba5690**; latest milestone: **6a9bf07..2ba5690**. The original
Claude fixes are already ancestors; do not restart from the old review branch.

## Changes to review

| Commit | Scope |
|---|---|
| 94b8f37 | Exact-first identifier pairing, observations/design badges, selected Python environment |
| d4732a6 | Real editor/Claude acceptance, comparison after undo, explicit state-free source validation |
| 6c3d1ba | Explicit native column bindings across editor, sync and MCP; stale selection invalidation |
| 6a9bf07 | User opt-in automatic refresh and read-only PostgreSQL inspection |
| 2ba5690 | Reviewed native domain planner; pending bindings/source creation; domain detachment; comparison reload fix |

Focus on: identifier mapping across both comparison directions; pending vs loaded
model identity; absent-target and stale-plan checks; one grouped logical edit that
preserves other domains/shared YAML; opt-in refresh serialization/cancellation;
read-only PostgreSQL connections before first query; and interactive planner scope.

## Verified

Compile; 1,713 JS tests (76 files); 31 Python tests (including five PostgreSQL);
MCP typecheck/build and 13 checks; production VSIX; 9 SQLMesh + 2 dbt actual VS Code
host checks. Installed VSIX acceptance used three real Claude source edits/creation,
quoted aliases, auto refresh, domain planner stopped at Apply, and canvas-focused
undo restoring exact domain bytes. Source-only creation/refresh and warehouse
inspection left DuckDB bytes unchanged. See [acceptance evidence](sqlmesh-editor-acceptance-results.md).

Run locally:

```sh
npm run compile
npm test
npm run test:host
.venv-sqlmesh/bin/python -m unittest discover -s integrations/sqlmesh -p 'test_*.py' -v
(cd mcp-server && npx tsc --noEmit && npm run build && node test-smoke.mjs)
npm run package
```

PostgreSQL tests require a disposable cluster and `ERD_TEST_POSTGRES_DSN`; without
it five tests skip. The session used PostgreSQL 17.11 built under `/tmp`, SQLMesh
0.236.1, SQLGlot 30.8.0, DuckDB 1.5.5, Python 3.13.15 and Linux VS Code 1.138.0.
The sibling `../erd-studio-sqlmesh-acceptance` is disposable, locally versioned,
contains the native creation fixture and has no remote. Usual VS Code settings
were not changed. Screenshots/logs in `/tmp` are transient, not test dependencies.

## Deliberate remaining gaps

True composite foreign keys need an explicit ordered tuple contract shared by both
providers. dbt's current model-pair uniqueness heuristic is not proof of tuple
membership; do not reproduce that inference as validated FK semantics. Native
source deletion, generated/Python/seed/external edits and additional warehouse
engines remain manual/unsupported. Windows/macOS, cloud TLS/auth, multiple gateways,
custom external loaders and production scale were not accepted in this session.
Metadata does not prove audit execution or deployment.

Recommended next work: review this range and pilot on one representative native
project, then choose tuple relationships or a concrete warehouse engine. Keep tests
local; do not start GitHub Actions, create a PR/release, use worktrees or deploy a
user warehouse as an incidental review step. [Current status](sqlmesh-parity-status.md)
and [setup guide](../integrations/sqlmesh/README.md) are authoritative over older notes.
