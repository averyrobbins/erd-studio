# ERD Studio review handoff 09 — L5: SQLMesh physical notice (no dismiss, raw timestamps)

Please independently review the change below. Report findings with severity, file/line references, impact and a concrete reproduction. Do not edit source, commit, push, install the VSIX or trigger GitHub Actions; local checks are fine, and the Chrome preview workflow in CLAUDE.md ("Testing the Webview UI in Chrome") is welcome if you want to look at it.

## Repository state

- Checkout: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`
- Branch: `claude/sqlmesh-review-fixes` (from `sqlmesh-integration` @ `23292db`). Earlier commits: `1fe7e5e`, `1ac3c90`, `dd66b55`, `8b6c897`, `ee82b29`, `b244f92`, `54f7527`, `13f62c4` (handoffs 01–08).
- Commit under review: `50dfbcb` — *Let the SQLMesh physical notice be dismissed and speak plainly*.
- Origin: independent Claude review finding **L5**.

## The defect

`webview/components/Canvas/PhysicalSourceNotice.tsx`'s SQLMesh branch returned before the `dismissed` check and rendered no dismiss button, so the strip was permanent on the Physical stage; it printed `integration.status` verbatim ("SQLMesh metadata — stale.") and raw ISO-8601 timestamps.

## The change

- `PhysicalSourceNotice.tsx`: the SQLMesh branch now honours `physicalSourceNoticeDismissed`, renders the same icon and `×` button as the dbt strip, maps each status to a sentence that names the command to run (`STATUS_TEXT`: current / stale / unreadable / missing), and formats timestamps with the exported `formatWhen(iso)` (`toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })`, raw text when unparseable). Sentence order for a failed inspection changed to "…inspection of `<env>` at `<time>` failed: `<reason>`".
- `webview/store/editorStore.ts`: `setDomain` resets the dismissal when `sameIntegration(prev, next)` is false — provider, status, `generatedAt`, `warehouse.observedAt` or `warehouse.diagnostic` changed — in addition to the existing `samePhysicalSources` rule, so a drag (which re-sets the same domain) keeps the strip dismissed while a new export/inspection re-shows it.
- Tests (`test/unit/sqlmeshUi.test.tsx`): wording for stale, locale-formatted time present and raw ISO absent, dismiss hides it, re-setting the same payload keeps it hidden, a new export re-shows it; `formatWhen` fallback. The existing failed-inspection test was adjusted to the new sentence order.

## What to check

- `toLocaleString` with `dateStyle`/`timeStyle` needs Intl support; VS Code's webview runtime has full ICU. The `try/catch` falls back to plain `toLocaleString()`; confirm the fallback is reachable only on engines without those options.
- The strip keeps the warning colours (`--warning-bg`) even for `status: 'ready'` with no diagnostics. The dbt strip only appears when something is *missing*; the SQLMesh strip always appears on Physical because it is the only place the provenance/observation summary lives. Argue whether a `ready` export with no warehouse block warrants the warning styling or a neutral/info variant (no info token exists in `theme.css` today).
- `sameIntegration` ignores `integration.diagnostics` content; a refresh that produces a different diagnostic list but the same `generatedAt` cannot happen (a new export has a new timestamp). Confirm.
- The DetailPanel still shows `model.warehouse.status`/relation/diagnostic per model — unchanged; confirm the strip and the panel do not now contradict each other for `unavailable` models.
- Accessibility: `role="status"` on a strip that includes a `<details>` disclosure — check screen-reader behaviour is acceptable (unchanged from the previous preview).

## Validation run

- `npx tsc --noEmit -p tsconfig.webview.json` clean; `npx vitest run`: 73 files, 1639 tests; `npm run build` OK. No visual check in a browser was done for this commit.

## Out of scope here

Claude launch venv (L6) follows in the next commit with its own `.planning/sqlmesh-review-handoff-10-assistant-launch.md`.
