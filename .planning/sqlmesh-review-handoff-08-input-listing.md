# ERD Studio review handoff 08 — L4: exporter/editor input listing disagreed on symlinks (+ CRLF pin)

Please independently review the change below. Report findings with severity, file/line references, impact and a concrete reproduction. Do not edit source, commit, push, install the VSIX or trigger GitHub Actions; local checks are fine.

## Repository state

- Checkout: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`
- Branch: `claude/sqlmesh-review-fixes` (from `sqlmesh-integration` @ `23292db`). Earlier commits: `1fe7e5e`, `1ac3c90`, `dd66b55`, `8b6c897`, `ee82b29`, `b244f92`, `54f7527` (handoffs 01–07).
- Commit under review: `13f62c4` — *Make the exporter and the editor list the same input files*.
- Python environment: `.venv-sqlmesh` (Python 3.13).
- Origin: independent Claude review finding **L4**.

## The defect

`integrations/sqlmesh/export.py` `input_files()` used `Path.is_file()`, which follows symlinks; `SqlmeshProjectAdapter.inputsChanged` used `Dirent.isFile()`, which is false for a symlink. A project with a symlinked `.sql` model was therefore hashed by the exporter but not listed by the editor → file-count mismatch → permanently `stale`. A link pointing *outside* the project was hashed by the exporter and then refused by the editor's "never follow out of the workspace" guard → also permanently stale. Separately, the fixture's checked-in export records SHA-256 hashes of the fixture files; on a `core.autocrlf=true` checkout the bytes change and the entire JS suite would see the export as stale.

## The change

- One rule on both sides: a symlink to a file is an input when its target resolves inside the project; a symlink pointing outside, or dangling, is not; a symlink to a directory is never descended into (Python 3.13 `rglob` does not follow directory links when expanding `**`; the editor treats `Dirent.isDirectory()` false for links).
- `src/services/sqlmeshAdapter.ts`: new exported pure `sqlmeshInputFiles(root, semanticDir)` (sorted POSIX-relative paths; `readdir` failures → empty; `lstat`/`stat` used to classify links; root files and the bindings file go through the same rule). `inputsChanged` now compares this listing's length and hashes each file — the old per-file realpath guard moved into the listing.
- `integrations/sqlmesh/export.py` `input_files()`: `is_input()` helper applying the same rule (`resolve().is_relative_to(real_root)`), and the directory walk is now `os.walk(followlinks=False)` with hidden directories pruned, documented as the mirror of the TS function.
- Tests: `test_input_files_agree_with_the_editor_on_symlinks` (Python) and `lists exactly the files the exporter fingerprints…` (TS) build the same four links (inside, outside, directory, dangling) and assert the same inclusions/exclusions; the TS test additionally asserts the listing equals the fixture export's `inputs` keys.
- `.gitattributes` (new): `test/fixtures/sqlmesh-project/** text eol=lf`. `git add --renormalize` reported no content changes (everything was already LF).

## What to check

- Python version independence: `input_files` no longer uses `Path.rglob` (whose handling of directory symlinks changed in 3.13) but `os.walk(..., followlinks=False)` with hidden directories pruned in place, so the behaviour is the same on the 3.9–3.12 interpreters a project's own environment may use. Only 3.13 is available locally — if you have an older interpreter with SQLMesh, run `test_input_files_agree_with_the_editor_on_symlinks` there. Also check that `os.walk` order (sorted `dirs`, unsorted `names`) cannot affect the result — it cannot, the set is sorted at the end.
- `is_input()` returns False for a symlink whose target *is* the project root itself (`file.resolve() != real_root`); the TS `insideRoot` requires a non-empty relative path — equivalent. Check the empty-`rel` case in TS (`!!rel`).
- Windows: `fs.realpathSync` on junctions/symlinks and case-insensitive roots; `path.relative` of a different-drive target returns an absolute path, which `insideRoot` treats as outside. Both sides need Developer Mode or admin for symlinks anyway; the tests create real symlinks (`fs.symlinkSync`, `os.symlink`) and will fail on a Windows CI runner without that privilege — acceptable for a preview? Flag if a skip guard is warranted.
- `.gitattributes` scope: only the fixture tree. Confirm nothing else in the repo relies on CRLF and that `text eol=lf` (rather than `-text`) is the right choice for `.csv` seeds and `.json` in that tree.
- `sqlmeshInputFiles` is exported; confirm the MCP bundle (`mcp-server/`) still builds since it imports `sqlmeshAdapter.ts` (it does — build ran).

## Validation run

- Python: 21 tests OK. `npx tsc --noEmit` clean. `npx vitest run`: 73 files, 1637 tests. `npm run build` OK.

## Out of scope here

Notice dismissal (L5) and Claude launch venv (L6) follow in later commits, each with its own `.planning/sqlmesh-review-handoff-NN-*.md`.
