# ERD Studio review handoff 03 — H3: FK audit convention needs `depends_on` (+ L1 harness versions, L3 fixture)

Please independently review the change below. Report findings with severity, file/line references, impact and a concrete reproduction. Do not edit source, commit, push, deploy a warehouse other than disposable test databases, install the VSIX or trigger GitHub Actions.

## Repository state

- Checkout: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`
- Branch: `claude/sqlmesh-review-fixes` (from `sqlmesh-integration` @ `23292db`). Earlier commits: `1fe7e5e` (handoff 01), `1ac3c90` (handoff 02).
- Commit under review: `dd66b55` — *Diagnose FK audits whose parent is not a dependency; version SQLMesh harness separately*.
- Python environment: `.venv-sqlmesh` (SQLMesh 0.236.1, SQLGlot 30.8.0, DuckDB 1.5.5).
- Origin: independent Claude review findings **H3**, **L1** and **L3**.

## The defect (H3)

SQLMesh derives model dependencies from the rendered query (`Model.full_depends_on` → `find_tables`), never from audits. The shipped `erd_relationship` audit references the parent through `@to`, so on a child that does not `SELECT … FROM` the parent:

- a fresh `sqlmesh plan prod --auto-apply` fails — the child is evaluated in the same batch as the parent and its audit hits `"wh"."demo"."parent"` before the virtual layer exists (*"Catalog Error: Table with name "demo.parent" does not exist because schema "demo" does not exist"*, reproduced 3/3 on a two-model DuckDB project);
- on an existing prod, a dev environment's audit resolves to prod's virtual view instead of the environment's own parent.

Adding `depends_on (demo.parent)` to the child fixes both (verified: the same plan then applies). Neither the README, the audit file, nor the harness/sync instructions mentioned this, and the exporter was silent because the fixture's `fct_order` happens to select from `dim_customer`.

## The change

- `integrations/sqlmesh/export.py` (`erd_relationship` branch): after resolving `target`, `if target not in model.depends_on` append a diagnostic — *"erd_relationship on `<fqn>` targets `<fqn>`, which is not a dependency of the model; add depends_on (`<to as written>`) to the MODEL so the audit resolves to the environment's own table and runs after it exists"*. The edge is still exported (it is the declared intent; the hazard is a deployment concern surfaced next to it).
- `integrations/sqlmesh/audits/erd_relationship.sql` and the fixture copy: header comment documents the requirement with an example.
- `integrations/sqlmesh/README.md` "Model identity and relationships": new paragraph.
- `src/services/sqlmeshSync.ts` `SQLMESH_SYNC_INSTRUCTIONS[4]` and the SQLMesh branch of `HarnessService.generateDefaultContent`: tell assistants to add `depends_on` when introducing the audit on a child that does not select from the parent.
- `integrations/sqlmesh/test_export.py`: `test_fk_target_missing_from_dependencies_is_diagnosed_but_still_exported` (diagnosed without `depends_on`, edge kept; clean with `depends_on`; fixture `fct_order` stays clean).

### L1 — harness versions split per provider

`HARNESS_VERSION` had been bumped 17 → 19 although no dbt generator changed, so every existing dbt user would be prompted to "update" byte-identical files. Now:

- `HARNESS_VERSION = '17'` (dbt; unchanged content since 17).
- New `SQLMESH_HARNESS_VERSION = '1'`, `harnessVersionFor(provider)`, and `HarnessService.version`; the SQLMesh content embeds its own marker.
- `detectStale` compares a file against the version of the provider it carries (`<!-- erd-studio-provider: sqlmesh -->`), and a provider switch is always stale (existing behaviour).
- `src/extension.ts` uses `harnessService.version` in the three user-facing strings.
- Tests in `test/unit/sqlmeshAdapter.test.ts`: `versions the SQLMesh harness independently…`, `tells assistants the FK parent must be a declared dependency`. CLAUDE.md "Harness Versioning" updated.

### L3 — fixture export regenerated

`test/fixtures/sqlmesh-project/.erd-studio/sqlmesh.json` was still `schemaVersion: 1` while the exporter writes 2, and the audit file hash changed. Regenerated with `export.py --project test/fixtures/sqlmesh-project` (diff: `schemaVersion`, `generatedAt`, the audit hash, and `"warehouse": null`).

## What to check

- `model.depends_on` semantics: it returns `full_depends_on - {self.fqn}` for SQL models (explicit `depends_on_` ∪ tables found in the rendered query), `depends_on_` for seeds and an empty set for external models. Confirm `target` (from `normalize_model_name(...)`) and the members of `depends_on` are always in the same normalised, quoted-fqn form — including a project with `default_catalog`, a dialect that upper-cases identifiers, and a `to :=` written with or without a catalog.
- Whether the diagnostic should also fire for Python models (`depends_on` must be declared explicitly there; the check uses the same property, so it will — argue whether that is right).
- Is keeping the edge the right call, versus dropping it until the dependency is declared? My reasoning: the edge is what the user declared; the diagnostic is visible in the Physical notice and in `list_project_models`.
- `render_audit_query` is not called by the exporter; nothing here executes an audit. Confirm no new SQLMesh internal API is depended on (only `Model.depends_on`, public).
- Harness: any existing test or code path that assumed one global version (`extension.ts` QuickPick description, the "Update to vN?" prompt, `detectStale`) — confirm messages now show `17` for dbt and `1` for SQLMesh and that a SQLMesh install at marker `19` (the draft VSIX) is reported stale under the new scheme (it is, by version mismatch), which is the intended outcome since its text changed.
- Whether reverting `HARNESS_VERSION` to 17 could misfire for anyone who installed a v19 *dbt* harness from the draft VSIX: `detectStale` would prompt them once to "update to v17"; the content written is identical apart from the marker. Acceptable?

## Validation run

- Python: `.venv-sqlmesh/bin/python -m unittest discover -s integrations/sqlmesh -p 'test_*.py'` — 17 tests OK (was 16).
- `npx tsc --noEmit` clean; `npx vitest run` — 71 files, 1613 tests passing.
- `npm run build` OK; `mcp-server`: `npm run build` + `node test-smoke.mjs` all ✅ against the regenerated fixture.
- Manual: two-model DuckDB project in a scratch dir — plan fails without `depends_on`, applies with it (see defect section).

## Out of scope here

Identifier case policy (M1), environment-not-found diagnostic (M2), export timeout (M3), export self-hash (L2), symlink asymmetry (L4), notice dismissal (L5), Claude launch venv (L6) follow in later commits, each with its own `.planning/sqlmesh-review-handoff-NN-*.md`.
