# SQLMesh integration — review follow-up handoffs

Branch `claude/sqlmesh-review-fixes` (from `sqlmesh-integration` @ `23292db`) addresses every finding of the independent review of `ecb9ba0..23292db`, one commit per finding, highest priority first. Each note below is a self-contained review handoff: the defect, the change, what to scrutinise, and what was (and was not) validated. Review the whole branch with `git diff 23292db..claude/sqlmesh-review-fixes`, or one commit at a time in this order.

| # | Commit | Finding | Note |
|---|---|---|---|
| 01 | `1fe7e5e` | **H1** a failed Physical switch locked the Logical canvas | [stage-switch-lock](sqlmesh-review-handoff-01-stage-switch-lock.md) |
| 02 | `1ac3c90` | **H2** generic `config.yaml` / `config.py` activation events (+ **L7** dead resolver) | [activation-events](sqlmesh-review-handoff-02-activation-events.md) |
| 03 | `dd66b55` | **H3** FK audit convention needs `depends_on` (+ **L1** separate harness version, **L3** fixture regenerated) | [fk-audit-depends-on](sqlmesh-review-handoff-03-fk-audit-depends-on.md) |
| 04 | `8b6c897` | **M1** identifier case policy (`identifierFolding`) | [identifier-folding](sqlmesh-review-handoff-04-identifier-folding.md) |
| 05 | `ee82b29` | **M2** unknown environment reported as "not-deployed" | [environment-not-found](sqlmesh-review-handoff-05-environment-not-found.md) |
| 06 | `b244f92` | **M3** hard-coded 120 s export timeout | [export-timeout](sqlmesh-review-handoff-06-export-timeout.md) |
| 07 | `54f7527` | **L2** hand-edited export passed as `ready` | [export-integrity](sqlmesh-review-handoff-07-export-integrity.md) |
| 08 | `13f62c4` | **L4** exporter/editor input listing disagreed on symlinks (+ CRLF pin) | [input-listing](sqlmesh-review-handoff-08-input-listing.md) |
| 09 | `50dfbcb` | **L5** Physical notice: no dismiss, raw timestamps | [physical-notice](sqlmesh-review-handoff-09-physical-notice.md) |
| 10 | `02dab98` | **L6** native Claude launch: bare `claude`, no project venv | [assistant-launch](sqlmesh-review-handoff-10-assistant-launch.md) |
| — | `fe553de` | changelog bullet for the above | — |

Validation at the branch head (after commit 10): `npm run compile` clean; `npx vitest run` 74 files / 1647 tests; `npm run package` OK with 13 files listed by `vsce ls`; Python suite 21/21 (`.venv-sqlmesh`, SQLMesh 0.236.1); `mcp-server` type-check, build and smoke 11/11; `npm audit --omit=dev --audit-level=high` clean. Nothing was run against a real warehouse; DuckDB tests used disposable databases only. Items that still lack live verification are named in each note's "What to check" section — chiefly a real launch from the extension development host (note 10) and Windows behaviour (notes 08 and 10).

Original handoff that started the review: `/tmp/erd-studio-claude-handoff-2026-09-20.md` (not in the repository).
