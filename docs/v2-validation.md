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

## Smoke checklist for each completed phase

- [ ] `bun test`
- [ ] `node shuvquota.js --version`
- [ ] `node shuvquota.js --help`
- [ ] One-shot default output with fixture/isolated credentials
- [ ] `--json`: parseable, correct schema, redacted identity, no secrets
- [ ] `--compact`: one metric per line
- [ ] `claude`: provider filtering
- [ ] `bun run app` and `/api/quota`: schema and public projection
- [ ] Removed namespaces/commands/flags: exit 2 and v1 migration hint

## Release validation

- [ ] Golden layouts and Unicode cell bounds
- [ ] Real PTY watch, resize, refresh, quit, Ctrl-C, terminal restoration
- [ ] Non-TTY fallback and `NO_COLOR`
- [ ] Managed refresh serialization; external stores byte-for-byte unchanged
- [ ] Server privacy, host checks, cache, and single-flight regressions
- [ ] `bun run preflight`
- [ ] `bun run release:pack`

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

Pure Phase 4 rendering work is proceeding independently in new files while the
OAuth gate is evaluated. CLI wiring and legacy-renderer removal stay deferred to
the shared-snapshot integration; this does not mark Phase 4 complete.
