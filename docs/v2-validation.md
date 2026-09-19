# v2 validation record

## Baseline — 2026-09-18 (PDT)

- Baseline revision: `59089120`, current trunk bookmark `master`.
- Local preservation tag: `v1.1.25-final` (not pushed).
- v1 compatibility invocation: `npx shuvquota@1 …`.
- `bun test`: 695 passed, 0 failed; 1,917 assertions, 6 files.
- `node shuvquota.js --version`: `1.1.25`.
- `node shuvquota.js --help`: exit 0; captured in
  `/tmp/shuvcode/shuvquota-v1-help.txt`.
- Independent Fable run: same 695 passing tests; `bun pm pack --dry-run` passed
  (82 files). Preflight passed 4/5 checks; clean-tree check failed as expected due
  to the in-progress documentation changes.
- Live credential-backed JSON capture remains pending ownership review: the v1
  fetch path can refresh and write credentials as part of a quota read.

## Final smoke checklist

- [x] `bun test`
- [x] `node shuvquota.js --version`
- [x] `node shuvquota.js --help`
- [x] One-shot default output with fixture/isolated credentials
- [x] `--json`: parseable, correct schema, redacted identity, no secrets
- [x] `--compact`: one metric per line
- [x] `claude`: provider filtering
- [x] Server entry and `/api/quota`: schema and public projection
- [x] Removed namespaces/commands/flags: exit 2 and v1 migration hint

## Release validation

- [x] Golden layouts and Unicode cell bounds
- [x] Real PTY watch, resize, refresh, quit, Ctrl-C, terminal restoration
- [x] Non-TTY fallback and `NO_COLOR`
- [x] Managed refresh serialization; external stores byte-for-byte unchanged
- [x] Server privacy, host checks, cache, and single-flight regressions
- [x] `bun run preflight`
- [x] `bun run release:pack`

OAuth feasibility evidence and model-specific outcomes are recorded separately.

## Phase 1 implementation — independently verified

Fable reports 337 passing tests, 0 failures, 1,060 assertions across 4 files.
Package dry-run succeeds (73 files, 0.89 MB); removed-provider modules/icons are
absent. Preflight passes every check except the expected uncommitted-tree check.
Removed namespace subprocess tests assert exit 2 and the v1 hint while preserving
account labels that happen to match a removed provider name.

Opus independently found no blockers, reconciled removed test bodies, and
verified `/api/health` and `/api/quota` return 200 with four providers. Parent
reran `bun test`: 337 passed, 0 failed, 1,060 assertions (log:
`/tmp/shuvcode/shuvquota-v2-phase1-tests.log`).

Committed as `db07f261`; review/baseline documentation is `a00834b2`.
Post-commit preflight again passes 4/5 checks; clean-tree check is blocked by
the new in-progress `lib/tui/width.js`, not by the committed Phase 1 files.

Pure Phase 4 rendering work is proceeding independently in new files while the
OAuth gate is evaluated. CLI wiring and legacy-renderer removal stay deferred to
the shared-snapshot integration; this does not mark Phase 4 complete.

## Integrated terminal and persistence checks

- Fable completed three real-PTY QA rounds. Exit handling, stale redraw residue,
  and last-column erasure were reproduced, fixed, and reverified. Widths 24–200,
  resize, failure/recovery, email toggle, help/filter/scroll, interval floor, and
  `NO_COLOR` passed. Details: `v2-tui-qa.md`.
- Parent focused integration run: **82 pass, 0 fail** across CLI, app, terminal,
  and quota tests (`/tmp/shuvcode/shuvquota-v2-integration-check.log`).
- Parent managed-write regression run: **4 pass, 0 fail**. Writes preserve unknown
  metadata, drop activeLabel, create private files atomically, refuse malformed
  stores and symlink redirection, and clean failed temporary writes.
- Source-backed OAuth feasibility is recorded in `v2-oauth.md`. Live enrollment
  remains unperformed. Grok's first implementation failed syntax checking and
  was reassigned to Fable; that delivery has not been accepted yet.
- Legacy-production cleanup is delivered; full-suite failures currently include
  stale test imports being migrated by another agent. They are not counted as
  successful final validation.

## Final integrated validation — 2026-09-18 PDT

- Parent final `bun test`: **666 pass, 0 fail**, 5,573 assertions across22 files.
  Log: `/tmp/shuvcode/shuvquota-v2-final-tests.log`.
- Isolated empty HOME, cleared provider environment: `--version` reports2.0.0;
  help, default, JSON, compact, Claude, accounts JSON and sources JSON all exit0.
  Non-TTY `watch` exits0 with static output and a stderr hint. Removed `codex
  switch work` exits2, empty stdout, v1 hint.
- Isolated production server entry: `/api/health`, `/api/quota`, `/` all HTTP200.
  Both APIs report schema2; quota contains the four ordered providers with no
  accounts or errors for the empty fixture home.
- `bun run release:pack`: successful dry-run,87 files,0.77MB unpacked;
  `lib/` and `web/` included. Log `/tmp/shuvcode/shuvquota-v2-pack.log`.
- Implementation size:43 JavaScript files /9,785 lines in `lib/`,20-line CLI
  entry. Runtime dependencies remain zero.
- Live credential-backed baseline capture and browser OAuth enrollment were not
  performed. Independent OAuth source evidence and35 mocked protocol tests are
  distinct from live provider validation.
- Phase2–7 work was interleaved across bounded agent file ownership and will land
  as an integrated migration commit so intermediate entry/adapter/schema states
  are not recorded as green release commits. This supersedes the original
  per-phase commit schedule; the Phase1 deletion commit remains separate.
- Final independent credential-boundary review found one blocker: throwing proxx
  discovery could suppress local accounts/sources. Both discovery paths now catch
  optional remote failures and retain local results; regression covers malformed
  base URLs and injected throwing clients. Full suite passed after this fix.
- Integrated migration committed as `2c353b3f`. Post-commit `bun run preflight`
  passed all five checks, including clean tree. `bun run release:pack` was rerun
  successfully after the final proxx fix. No package was published or pushed.
