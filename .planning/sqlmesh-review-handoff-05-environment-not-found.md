# ERD Studio review handoff 05 — M2: unknown environment reported as "not-deployed"

Please independently review the change below. Report findings with severity, file/line references, impact and a concrete reproduction. Do not edit source, commit, push, install the VSIX or trigger GitHub Actions; disposable DuckDB databases are fine.

## Repository state

- Checkout: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`
- Branch: `claude/sqlmesh-review-fixes` (from `sqlmesh-integration` @ `23292db`). Earlier commits: `1fe7e5e`, `1ac3c90`, `dd66b55`, `8b6c897` (handoffs 01–04).
- Commit under review: `ee82b29` — *Report an unknown environment as unavailable, not as "nothing deployed"*.
- Python environment: `.venv-sqlmesh`.
- Origin: independent Claude review finding **M2**.

## The defect

`inspect_warehouse` (`integrations/sqlmesh/export.py`) did `promoted = {…} if env else {}`, so `state.get_environment('prdo')` returning `None` made every model `not-deployed` with no diagnostic. The canvas notice then read "prdo, 0/7 models observed" — indistinguishable from a real environment with nothing promoted. `test_missing_environment_is_not_deployed` enshrined it.

## The change

- `export.py`: `env is None` now raises `InspectionUnavailable("Environment '<name>' was not found in SQLMesh state; check erdStudio.sqlmesh.environment or deploy that environment first")`. The generic `except` branch additionally stores the reason once at `warehouse.diagnostic` (in addition to every model's `diagnostic`, unchanged). The sanitised environment name is what is reported (`Environment.sanitize_name`), same string as `warehouse.environment`.
- `src/types/project.ts`: `WarehouseObservation.diagnostic?: string`. `src/types/display.ts`: `integration.warehouse.diagnostic?: string`.
- `src/services/sqlmeshAdapter.ts`: parser accepts the optional string (rejects non-strings); `integration` passes it through.
- `webview/components/Canvas/PhysicalSourceNotice.tsx`: when the diagnostic is set the notice says *"Warehouse inspection of <env> failed at <time>: <reason> Types shown are declared or inferred from source."* instead of the coverage sentence.
- README "Inspect a deployed DuckDB environment": states when `not-deployed` vs `unavailable` is reported.
- Tests: Python `test_missing_environment_is_reported_not_read_as_undeployed` (replaces the old assertion) and `test_undeployed_model_in_an_existing_environment_is_not_deployed` (a model added after deployment is `not-deployed`, no top-level diagnostic); TS parser rejects a non-string diagnostic, `integration.warehouse` carries it and source columns are untouched; UI test asserts the notice text and that "0/3 models observed" is not shown.

## What to check

- Every raise inside `inspect_warehouse` (`InspectionUnavailable` and unexpected exceptions) now lands in the same branch and sets the top-level diagnostic. Confirm nothing else in the pipeline expected the `warehouse` block to have exactly three keys (the TS parser is the only consumer I found).
- The `finalized_ts` / `expiration_ts` check moved out of the `env and (...)` guard because `env` is now known non-None; verify there is no behavioural change for a finalized, unexpired environment.
- Whether `not-deployed` should also carry a per-model diagnostic (currently none) — the README now explains the semantics; argue if a chip/tooltip is warranted.
- The DetailPanel already shows per-model `warehouse.diagnostic`; the notice now shows the top-level one. Confirm both are the same string for whole-inspection failures and that a per-model `unavailable` (e.g. a dropped view for one model) still leaves the top level clean (`test_relation_failure_is_not_treated_as_column_deletion` covers the model side).

## Validation run

- Python: 19 tests OK. `npm run compile` clean. `npx vitest run`: 73 files, 1632 tests. `npm run build` OK.

## Out of scope here

Export timeout (M3), export self-hash (L2), symlink asymmetry (L4), notice dismissal (L5), Claude launch venv (L6) follow in later commits, each with its own `.planning/sqlmesh-review-handoff-NN-*.md`.
