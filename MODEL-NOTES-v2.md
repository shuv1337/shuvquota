# Cursorprox model notes — shuvquota v2

Running record for the implementation of `PLAN-v2-tui-readonly.md`.
Times are Pacific (`America/Los_Angeles`). Findings are observations from this
task, not general model benchmarks. Excluded: Luna, Terra, and every fast variant.

## Runs

| Started (PDT) | Model | Task | Outcome / evidence |
| --- | --- | --- | --- |
| 2026-09-18 14:50 | `cursorprox/claude-opus-5#high` | Repository-grounded migration/credential/privacy review | Completed: detailed file/line-backed review, useful migration and sequencing findings. OAuth impossibility claims require independent verification (see below). Session `ses_f497fdd4bffe3sIrVMfnNBSrIa`. |
| 2026-09-18 14:50 | `cursorprox/gpt-5.6-sol#high` | Independent OAuth feasibility gate and TUI validation gaps | Running; session `ses_f497fc1beffesL5454DsydENX3` |
| 2026-09-18 14:52 | `cursorprox/claude-fable-5-1#high` | Independent baseline test/preflight and regression coverage audit | Completed: independently confirmed 695 passing tests, pack success; preflight blocked only by expected dirty tree. Found obsolete-icon preflight sequencing issue and concrete coverage gaps. |
| 2026-09-18 14:56 | `cursorprox/claude-fable-5-1#high` | Phase 1 provider removal, regression repair | Delivered: reports 337 pass/0 fail, 1,060 assertions; pack 73 files, no removed-provider artifacts. Independent Opus review pending. Preserved parent changes and stayed within assigned scope. |
| 2026-09-18 15:20 | `cursorprox/claude-opus-5#high` | Independent Phase 1 implementation review | Passed: no blockers, reconciled deleted tests by body, 337 pass/0 fail, live server health/quota 200 with four providers. Corrected its earlier unsupported OAuth feasibility claims. |
| 2026-09-18 15:21 | `cursorprox/cursor-grok-4.6#high` | Bounded second OAuth feasibility check | Running; session `ses_f4963bf54ffeFYzOBvXUS8PNAZ`. Sol had not returned after roughly 30 minutes; not classified as a failed call. Added this independent check to avoid blocking all progress on one model. |
| 2026-09-18 15:22 | `cursorprox/claude-fable-5-1#high` | Standalone Phase 4 layout/width/render modules and golden tests | Running in original Fable session; isolated to `lib/tui/` and `test/tui/`, CLI integration deferred until shared snapshot exists. |

## Baseline

- Parent/orchestrator: GPT-6 Astra; delegated work explicitly targets Cursorprox.
- Repository baseline: `59089120` (`master`; there is no `main` bookmark).
- Existing working-copy change: user-provided `PLAN-v2-tui-readonly.md` only.
- `bun test`: **695 pass, 0 fail**, 1,917 assertions across 6 files.
- Full baseline test log: `/tmp/shuvcode/shuvquota-v2-baseline-tests.log`.

## Retry policy

Record failed calls, incomplete deliverables, and validation failures here. Switch
to another allowed Cursorprox model when a model cannot complete its assignment.
Transport success alone does not establish code correctness; record actual tests
and review findings separately from the model's claims.

## Review interpretations

- Fable's audit correctly distinguishes a dirty-tree preflight failure from a
  product failure. Obsolete icon requirements must move with Phase 1 deletion.
- Fable proposed treating all account fetch failures as a whole-scan failure.
  This is not adopted: the plan explicitly distinguishes account-level errors
  from orchestration failures, including when every account reports an error.
- Model audit suggested export-name matching for no-harness-write tests; behavioral
  byte-for-byte fixture checks are the useful acceptance criterion, not naming.
- Opus identified real harness-write paths in all rotating providers, the legacy
  Codex store under `.opencode`, unconditional `activeLabel` emission, proxx's
  replace-vs-merge and filter/identity gaps, and Phase 3/6 schema sequencing.
- Opus overstates feasibility: an absent login adapter does not prove a provider
  cannot support enrollment, and a configured Google client secret alone does
  not prove an installed-app flow is unavailable. Sol's independent protocol
  evidence is required before deciding the Phase 0 gate.
- Opus recommends a separate private-email side channel. The plan can instead
  retain internal email and use a constructive allowlisted public projection;
  the critical property is rebuilding permitted fields and sanitizing all text,
  rather than deleting a blacklist of fields.

## Tooling interruptions

- The Plannotator session was cancelled by a server restart; no user decision
  was returned. This is infrastructure interruption, not model failure or approval.
