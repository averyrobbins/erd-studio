# ERD Studio review handoff 02 — H2: generic activation events (+ L7 dead resolver)

Please independently review the change below. Report findings with severity, file/line references, impact and a concrete reproduction. Do not edit source, commit, push, install the VSIX or trigger GitHub Actions; local checks are fine.

## Repository state

- Checkout: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`
- Branch: `claude/sqlmesh-review-fixes` (from `sqlmesh-integration` @ `23292db`).
- Commit under review: `1ac3c90` — *Activate only on ERD Studio or dbt files, not on any config.yaml*. Previous commit on the branch: `1fe7e5e` (handoff 01).
- Origin: independent Claude review of `ecb9ba0..23292db`, findings **H2** and **L7**.

## The defect

`package.json` `activationEvents` gained `workspaceContains:**/config.yaml`, `**/config.yml`, `**/config.py`. Almost every workspace has one (Flask/Django `config.py`, K8s/mkdocs/Rails `config.yaml`…), so ERD Studio activated everywhere, `resolveProjectRoot` ran a synchronous depth-5 BFS that `readFileSync` + YAML-parsed every `config.yaml` it met (`src/services/projectDetection.ts`), found nothing, and `activate()` showed *"ERD Studio: No supported project found…"* on every open. This regressed the existing dbt install base, not only SQLMesh users. Separately, `resolveDbtProjectRoot` in `src/extension.ts` was dead code kept alive only by its own test, while the live `resolveProjectRoot` had lost the venv skips and gone from depth 3 to depth 5.

## The change

- `package.json`: activation events are now `**/dbt_project.yml`, `**/.erd-studio/layers.json`, `**/.erd-studio/sqlmesh.json`. `layers.json` is new: it marks any workspace that already uses ERD Studio regardless of provider. VS Code ≥1.74 auto-generates `onView`/`onCommand`/`onCustomEditor` activation for contributed views, commands and editors, so a brand-new SQLMesh project (no `.erd-studio/` yet) still activates when the user opens the sidebar or runs any ERD Studio command.
- `src/services/projectDetection.ts`: `PROJECT_SEARCH_MAX_DEPTH = 3`, `PROJECT_SEARCH_SKIP_DIRS` = `node_modules, dbt_packages, dbt_modules, target, dist, venv, site-packages` (hidden dirs skipped by prefix, as before). Same shallowest-match, name-ordered BFS. A `projectPath` that holds no project logs a `console.warn` before falling back (the old resolver did this too).
- `src/extension.ts`: `resolveDbtProjectRoot`, `hasDbtProjectFile`, `DBT_SEARCH_*` removed; the `findDbtProjectRoot` doc comment now points at `projectDetection.ts`.
- Tests: `test/unit/projectDetection.test.ts` (new, 17 tests) ports every case from the old `resolveDbtProjectRoot` suite to `resolveProjectRoot` and adds SQLMesh-root, sibling-ordering, provider-preference, unrelated-`config.yaml`/`config.py` and custom-`semanticDir` cases. `test/unit/extension.test.ts` keeps only the activate/deactivate assertions.
- Docs: CLAUDE.md "Project detection" bullet rewritten (names the narrow activation events and why); `integrations/sqlmesh/README.md` step 2 explains how a fresh SQLMesh project activates.

## What to check

- Is `**/.erd-studio/layers.json` an acceptable activation trigger? It fires for every ERD Studio user (they all have it), which is the same population `dbt_project.yml` already covered plus SQLMesh users. It does **not** respect a custom `erdStudio.semanticDir`; argue whether that matters given the command/view fallback.
- Confirm implicit activation actually covers the SQLMesh first-run path in VS Code 1.85 (`engines.vscode ^1.85.0`): contributed `commands`, `views` (`erdStudio.domainTree`, `erdStudio.modelLibrary`) and `customEditors` should all generate activation without being listed. If you can run the dev host: open a folder with only a SQLMesh `config.yaml`, click the ERD Studio activity bar icon, and check the tree provider registers and `Refresh Project Metadata` works.
- `findDbtProjectRoot()` still shows the no-project toast at activation. With the narrowed events it can only fire when a `dbt_project.yml` / `.erd-studio` exists but resolves to nothing (for example a `dbt_project.yml` deeper than 3 levels, or an `.erd-studio/` in a folder with neither framework), or when the user invoked a command in a random folder (pre-existing behaviour). Confirm you agree that is the right set of cases to warn about.
- The depth change (5 → 3) could stop finding a SQLMesh project nested 4–5 levels deep that the previous preview found. That matches the pre-existing dbt contract and CLAUDE.md; flag if you think SQLMesh monorepos warrant more.
- `venv` / `site-packages` are skipped by name; `.venv` by hidden prefix. Any other common Python environment directory names worth adding?

## Validation run

- `npm run compile` clean.
- `npx vitest run`: 71 files, 1611 tests passing.
- Not run for this commit: `npm run build` / `npm run package`, dev host, Python suite (no Python change).

## Out of scope here

Remaining findings (FK-audit `depends_on`, identifier case policy, environment-not-found diagnostic, export timeout, harness version churn, export self-hash, stale fixture snapshot, symlink asymmetry, notice dismissal, Claude launch venv) follow in later commits, each with its own `.planning/sqlmesh-review-handoff-NN-*.md`.
