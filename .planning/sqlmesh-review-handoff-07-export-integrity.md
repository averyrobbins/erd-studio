# ERD Studio review handoff 07 — L2: a hand-edited export passed as `ready`

Please independently review the change below. Report findings with severity, file/line references, impact and a concrete reproduction. Do not edit source, commit, push, install the VSIX or trigger GitHub Actions; local checks are fine.

## Repository state

- Checkout: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`
- Branch: `claude/sqlmesh-review-fixes` (from `sqlmesh-integration` @ `23292db`). Earlier commits: `1fe7e5e`, `1ac3c90`, `dd66b55`, `8b6c897`, `ee82b29`, `b244f92` (handoffs 01–06).
- Commit under review: `54f7527` — *Stamp the SQLMesh export with an integrity hash and refuse edited artifacts*.
- Python environment: `.venv-sqlmesh`.
- Origin: independent Claude review finding **L2**.

## The defect

`SqlmeshProjectAdapter.inputsChanged` hashes the project's source inputs against `snapshot.inputs`; nothing hashed the export itself. A `sqlmesh.json` edited by hand kept `status: 'ready'` and satisfied `sqlmeshSyncContext`, so a sync plan could be built from invented metadata. The provider test at `semanticEditorProvider.sqlmeshSync.test.ts` (shared-column removal) relied on exactly that.

## The change

- `integrations/sqlmesh/export.py`: `canonical_json(value)` = `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`; `with_integrity(snapshot)` adds `integrity: "sha256:<hex>"` over the canonical JSON of every other field. `export_project` returns the stamped dict.
- `src/services/sqlmeshAdapter.ts`: `canonicalJson` (sorted keys recursively, `JSON.stringify`, then every UTF-16 code unit ≥ U+007F escaped as lowercase `\uXXXX`) and `snapshotIntegrity`. `parseSqlmeshSnapshot` verifies the stamp *before* any other validation when the field is present (wrong shape or mismatch → *"SQLMesh metadata was modified after export (integrity check failed)…"*); absent stamp → accepted as before. `load()`'s existing error path then keeps the last good snapshot with `status: 'stale'`, or `'invalid'` when there was none.
- `src/types/project.ts`: `SqlmeshSnapshot.integrity?: string`.
- Fixture: `models/other_customer.sql` gained a non-ASCII description (`… für Support — UTF-8 ✓ 😀`, i.e. Latin-1, em dash, BMP symbol and an astral emoji) so the regenerated `sqlmesh.json` exercises the escape path; the JS suite loads that fixture and asserts `snapshotIntegrity(original) === original.integrity` on every run.
- Tests: TS — fixture verifies; tampered copy → `stale` + diagnostic + previous data kept; tamper with the stamp removed (legacy export) → accepted; malformed stamps rejected; `canonicalJson` golden string. Python — stamp shape, re-stamp stability, tamper changes the hash, `canonical_json` golden string. Tests that mutate the artifact now either re-stamp (`editArtifact`, `makeSnowflake` — "as another exporter run would write it") or strip the stamp (provider shared-removal test — "as an older exporter would write it").

## What to check — the cross-language canonical form is the whole risk

Both implementations were compared byte-for-byte on `{"z":["é","日本","😀","\x7f","\x01\n\t\"\\/","a b","\ud83d"],"a":{…},"Zed":1,"zed":2,"_u":3}` (Latin-1, CJK, astral, DEL, control chars, quote/backslash/slash, U+2028, a lone surrogate, mixed-case and underscore keys) and were identical. Please try to break it:

- Key ordering: Python sorts `str` by code point; a plain JS `sort()` compares UTF-16 code units, which diverges once an astral character meets a BMP character in U+E000–U+FFFF. `inputs` keys are user-controlled file names, so `canonicalJson` sorts keys with an explicit code-point comparator (`byCodePoint`); verified identical to Python on `{"\ue000","😀","z","\uffff","a😀","a\ue000","","ab","a"}` and covered by a golden assertion. Check the comparator for correctness on empty strings and prefixes.
- Numbers: the export holds only integers and `null`/booleans. Confirm no float can appear (a float would print `1.0` in Python vs `1` in JS).
- `ensure_ascii` escapes `[^\x20-\x7e]` — DEL (U+007F) *is* escaped by Python and *not* by `JSON.stringify`, which is why the JS regex starts at `\u007f`. Confirm the lower bound and that nothing below U+0020 differs (`\b \f \n \r \t` short forms in both, others `\u00XX` lowercase in both).
- Lone surrogates: ES2019 well-formed `JSON.stringify` emits `\udXXX`; Python with `ensure_ascii` also emits `\udXXX`. Confirm for the Node that VS Code 1.85 embeds (18.x — well-formed stringify has been in V8 since 7.2).
- `JSON.parse` round trip: hashing happens on the *parsed object*, so formatting of the file (indentation, key order on disk) is irrelevant by design; a byte-identical re-serialisation is not required. Confirm that is acceptable, and that a duplicated key in the file (last wins in both parsers) cannot be exploited to pass the check while changing meaning.
- The `integrity` field is validated even when `schemaVersion` is 1 (older reader shape); it can only be present on files written by the new exporter, which always writes 2. Fine, but flag if you disagree.
- Behavioural: an edited export now reports `stale` with the last good data (if any) or `invalid`. Refreshing overwrites it. Confirm the toast/notice wording is clear enough for someone who edited the file deliberately.

## Validation run

- Python: 20 tests OK. `npm run compile` clean. `npx vitest run`: 73 files, 1636 tests. `npm run build` OK; `mcp-server` build + smoke 11/11 ✅ (fixture regenerated: description text, inputs hash for `other_customer.sql`, `integrity`).

## Out of scope here

Symlink asymmetry (L4), notice dismissal (L5), Claude launch venv (L6) follow in later commits, each with its own `.planning/sqlmesh-review-handoff-NN-*.md`.
