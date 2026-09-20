# ERD Studio review handoff 01 — H1: failed Physical switch locked the Logical canvas

Please independently review the change below. Report findings with severity, file/line references, impact and a concrete reproduction. Do not edit source, commit, push, install the VSIX or trigger GitHub Actions; local checks are fine.

## Repository state

- Checkout: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`
- Branch: `claude/sqlmesh-review-fixes`, branched from `sqlmesh-integration` at `23292db`.
- Commit under review: `1fe7e5e` — *Commit the active stage only after its payload is built*. Review with `git show 1fe7e5e` (or `git diff 23292db..1fe7e5e`).
- Origin of the finding: the independent Claude review of `ecb9ba0..23292db` (finding **H1**).

## The defect

`SemanticEditorProvider.handleSwitchStage` set `panel.activeStage = targetStage` *before* deriving the payload. `SqlmeshProjectAdapter.buildPhysical` throws when the export is `missing` or `invalid` (the ordinary first-run state), so the host flipped to `physical`, posted an `error`, and never sent `stageData`. The webview changes stage only on `stageData` (`webview/App.tsx` `case 'stageData'`), so it still showed Logical while the host's physical-stage guard refused every mutation as *"Physical stage is read-only"*. Neither `StageTabs.handleTabClick` nor the Alt+1 shortcut resends a switch to the stage the webview believes it is on, so the only recovery was producing an export or reopening the editor. dbt never hit this because `buildPhysicalDomain` treats a missing manifest as data, not as an exception.

## The change

`src/providers/SemanticEditorProvider.ts`

1. `handleSwitchStage` now builds the payload first, then commits `panel.activeStage` and posts `stageData` in one step. On any throw the host stays on the previous stage and posts the existing `Failed to switch stage: …` error.
2. A new optional `stageSwitchSeq` field on the `openPanels` entry is bumped on every call; after the (async) build, a switch whose sequence is no longer current — or whose panel entry was replaced — returns without posting or committing. This mirrors the webview's own `isStaleStageReply` so the two sides cannot disagree when two switches overlap (including a host-initiated switch, which carries no `requestId`, racing a webview one).

`test/unit/semanticEditorProvider.stageSwitch.test.ts` (new, 3 tests): failed physical build leaves logical edits working; a successful switch commits and the guard then applies; an overtaken switch posts no reply and the host stays on the newer stage. Both regression tests fail against `23292db` (verified by stashing the source change).

## What to check

- Every caller of `handleSwitchStage`: the webview `switchStage` message, `refreshAllOpenDomains` (physical panels), `switchStageForUri` (tree "open in physical"). Confirm none relied on `activeStage` being set before the build (for example a refresh path that reads `activeStage` mid-build).
- The message listener reads `this.openPanels.get(panelKey)?.activeStage` per message; messages arriving during a slow build are now judged against the *old* stage. Argue whether that is right (I believe it is — the webview is still showing the old stage).
- The overtaken-switch rule: a host-initiated refresh (`refreshAllOpenDomains` → `handleSwitchStage(…,'physical')`) that is overtaken by a webview switch to logical is now dropped instead of flipping the canvas back to physical. Is there any host path that *needs* its reply delivered even when a newer switch exists?
- `sendDomainData` (initial load/refresh) still builds the physical payload when `activeStage === 'physical'` and posts a load error on failure. With the fix, `activeStage` can only be `physical` after a successful build, so the only way to reach that error is an export deleted/invalidated afterwards. Confirm the resulting state (host physical, webview physical, error toast) is acceptable.
- Whether a `stageData`-less failure should additionally tell the webview to clear any pending UI (there appears to be no loading indicator for a stage switch; confirm).

## Validation run

- `npx tsc --noEmit` clean.
- `npx vitest run`: 70 files, 1605 tests passing (was 69/1602 before the new file).
- Not run for this commit: `npm run build`, `npm run package`, Python suite (unchanged code).

## Out of scope here

The remaining review findings (activation globs, FK-audit `depends_on`, identifier case policy, environment-not-found diagnostic, export timeout, harness version churn, export self-hash, stale fixture snapshot, symlink asymmetry, notice dismissal, Claude launch venv, dead `resolveDbtProjectRoot`) are being addressed in later commits on this branch, each with its own handoff note in `.planning/sqlmesh-review-handoff-NN-*.md`.
