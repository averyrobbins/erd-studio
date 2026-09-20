# ERD Studio review handoff 10 — L6: native Claude launch (bare `claude`, no project venv)

Please independently review the change below. Report findings with severity, file/line references, impact and a concrete reproduction. Do not edit source, commit, push, install the VSIX or trigger GitHub Actions; local checks are fine. A live launch from the extension development host (F5, fixture project, prepare a Logical-direction plan, **Edit source with Claude**) is the one thing no test here covers and would be valuable if you can do it.

## Repository state

- Checkout: `/home/avery/Documents/personal/data-engineering/data-modeling/erd-resources/erd-studio`
- Branch: `claude/sqlmesh-review-fixes` (from `sqlmesh-integration` @ `23292db`). Earlier commits: `1fe7e5e`, `1ac3c90`, `dd66b55`, `8b6c897`, `ee82b29`, `b244f92`, `54f7527`, `13f62c4`, `50dfbcb` (handoffs 01–09).
- Commit under review: `02dab98` — *Resolve the assistant executable and hand it the project's Python environment*.
- Origin: independent Claude review finding **L6**.

## The defect

`handleLaunchClaudeSync` (native branch) created the terminal with `shellPath: 'claude'` and no `env`. Compared with the dbt flow (`source .venv/bin/activate && claude` typed into a shell) that dropped two things the shell provided: PATH resolution of a bare command (VS Code does not resolve a bare `shellPath` on every platform, and on Windows the command is `claude.cmd`), and the project venv on PATH, so the `sqlmesh` the assistant runs to validate could be a different installation or none.

## The change

- `src/services/assistantLaunch.ts` (new, pure, no vscode import):
  - `resolveExecutable(name, searchPath = PATH, platform, pathExt)` — first `isFile` hit on the search path; on `win32` tries `''` then each PATHEXT extension (lower-cased; default `.COM;.EXE;.BAT;.CMD`); absolute names are returned when they exist.
  - `findVenvBinDir(root, platform)` — `.venv`/`venv`/`env` → `bin` (`Scripts` on Windows).
  - `assistantEnvironment({ workspaceRoot, pythonPath, basePath, platform })` — `{ PATH, VIRTUAL_ENV }` with the configured interpreter's directory (absolute paths only) and then the venv bin prepended, de-duplicated; `{}` when nothing applies.
- `src/providers/SemanticEditorProvider.ts` native branch: resolves `claude`; if absent throws *"Claude Code (`claude`) was not found on PATH. Install it, or run the plan with another assistant: it is at <plan path>."* (surfaced as an error toast by the message boundary); passes `env` only when non-empty. Everything else (modal confirmation, plan re-validation, `--dangerously-skip-permissions`) is unchanged.
- Tests: `test/unit/assistantLaunch.test.ts` (8) — first match wins, directories/empty entries ignored, PATHEXT behaviour, absolute names, env assembly/dedup/relative-pythonPath. The provider launch test stubs `resolveExecutable` (CI has no Claude Code) and asserts `shellPath`, `env.PATH[0] === <root>/.venv/bin`, `VIRTUAL_ENV`, no `sendText`.
- README "Sync selected differences" describes the resolution and environment.

## What to check

- `TerminalOptions.env` semantics: VS Code merges the given env over the terminal's inherited environment, and `terminal.integrated.env.*` settings are applied on top — confirm the order (an `integrated.env.linux.PATH` setting could override ours) and whether `strictEnv` matters here (it is not set).
- Is resolving `claude` in the *extension host's* `process.env.PATH` the right environment? The host's PATH on macOS launched from the Dock can be narrower than a login shell's; the dbt flow's shell would have found `claude` where the host cannot. Assess whether to fall back to VS Code's shell-resolved environment (`vscode.env.shell` + `terminal.integrated.env`) or document the limitation.
- Windows: `shellPath: 'C:\\…\\claude.cmd'` with `shellArgs` — node-pty runs `.cmd` files through `cmd.exe` implicitly? If not, a `.cmd` shellPath may need `cmd.exe /c` wrapping; unverified here (Linux only). The prompt argument contains spaces and quotes-free text; check `shellArgs` quoting on Windows.
- `VIRTUAL_ENV` is set even when `pythonPath` points elsewhere; argue whether that could mislead tools when the configured interpreter is not the venv's.
- The error for a missing `claude` fires *after* the modal confirmation (the resolve happens on launch). Would resolving before the modal, and disabling/labelling the button, be preferable?

## Validation run

- `npx tsc --noEmit` clean; `npx vitest run`: 74 files, 1647 tests; `npm run build` and `mcp-server` build OK. Not run: a real launch.

## Status of the review findings after this commit

H1, H2, H3, M1, M2, M3, L1, L2, L3, L4, L5, L6, L7 are all addressed on this branch (handoffs 01–10). The branch has not been pushed.
