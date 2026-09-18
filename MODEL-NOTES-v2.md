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
| 2026-09-18 15:21 | `cursorprox/cursor-grok-4.6#high` | Bounded second OAuth feasibility check | Completed: found existing loopback/device-code xAI and Google installed-app implementations in local source, exact protocol/client requirements, distinguished source evidence from unperformed live enrollment. Sol had not returned after ~30 minutes; not classified as failed. |
| 2026-09-18 15:22 | `cursorprox/claude-fable-5-1#high` | Standalone Phase 4 layout/width/render modules and golden tests | Corrected after review: v2-only fields, string[] returns, ≤60 yellow, tier0 before scroll. Reports 153 focused tests passing including 12 parent tests. Initial wrong-field fixtures had masked contract drift; corrections include explicit legacy-field rejection tests. |
| 2026-09-18 15:29 | `cursorprox/claude-opus-5#high` | Shared snapshot and injected quota pipeline foundations | Corrected delivery: 125 focused tests pass, exactly three statuses, new safe toDisplaySnapshot. Initial unapproved v1 statuses were corrected. Final handoff retained stale assumptions about the OAuth gate/Q2 despite updated docs; parent explicitly reaffirmed strict external-no-refresh policy. |
| 2026-09-18 15:35 | `cursorprox/cursor-grok-4.6#high` | OAuth enrollment adapters and protocol tests | Failed delivery: ~600-line incomplete module, stray `mar` syntax token at line581, dead helpers, missing tests. Claimed editing-tool trouble. Parent independently confirmed `node --check` fails with Unexpected identifier. Reassigned completion to Fable rather than accepting or repeatedly retrying Grok. |
| 2026-09-18 15:35 | `cursorprox/claude-sonnet-5#high` | Credential store and production provider adapters | Incomplete: delivered store/util and one draft Codex adapter, no tests or remaining registry/providers. Draft duplicated normalization, persisted during login (double-write with CLI), used refresh-buffer expiry externally, and locked by label. Handoff/comment incorrectly suggested harness fan-out could be allowed. Reassigned adapters to Opus; parent corrected and tested store identity locks, refresh-first CAS, malformed/atomic writes. |
| 2026-09-18 15:41 | `cursorprox/gemini-3.1-pro#high` | Server/web v2 migration and regression tests | Delivered: reports 627 passing tests at that point, in-process loader/public projection and web v2 names. Follow-up privacy audit requested, including whether altered malicious fixture strings narrowed coverage. |
| 2026-09-18 | `cursorprox/gemini-3.8-flash#high` | Read-only independent CLI/app/terminal review | Delivered: reproduced -w removed-word label inconsistency (fixed), identified missing-accounts hardening (added), verified coalescing/rollback. Some coverage advice was stale after concurrent PTY-driven changes. Never-settling injected loader shutdown repro is a limitation, not a demonstrated production HTTP hang; production timeouts and safe refresh persistence must be checked. |
| 2026-09-18 | `cursorprox/gemini-3.7-flash#high` | Retained legacy test split and direct imports | Delivered:233 retained tests pass, direct module imports, obsolete v1 mutation/cookie/help suites pruned by purpose, main test split into six topic files. |
| 2026-09-18 | `cursorprox/claude-fable-5-1#high` | Real PTY watch QA with fixture-only credentials | Three rounds: found resumed-stdin exit hang, redraw residue, then last-column erase regression from initial fix. Parent fixes now verified on real PTYs: full-width borders, clean redraw, actual q/Ctrl-C exit, email toggle, sizes24–200, failures/recovery, NO_COLOR. Strong concrete QA findings; report `docs/v2-tui-qa.md`. |
| 2026-09-18 | `cursorprox/claude-opus-5#high` | Legacy production harness-mutation removal | Delivered after one continuation: handlers/sync deleted, display reduced to pure helpers, token persistence/fanout APIs and cookie path removed; import checks pass. Caught/corrected its own early-expiry buffer mistake. Full suite still red from obsolete imports under active test migration; not accepted as final green. |
| 2026-09-18 | `cursorprox/claude-fable-5-1#high` | Recover and test Grok's incomplete OAuth implementation | Delivered working recovery: syntax/import checks and35 focused tests pass; all4 mocked enrollment flows, JWT identity, callback state/timeout/abort/cleanup. Parent reran OAuth+store suites:67 pass/0fail. Live login remains unperformed. |
| 2026-09-18 | `cursorprox/gemini-3.1-pro#high` | Context-aware known-secret redaction | Failed verification: claimed implementation and restored short-secret fixtures, but parent found no scrubber in snapshot source and fixtures still held longer pattern-shaped values. Existing 12 server tests pass but do not substantiate claimed new behavior. Reassigned to Gemini3.8 Flash with explicit red-first repro. Parent also removed temporary skipIf(!hasSnapshot) guards that could hide broken projection imports. |
| 2026-09-18 | `cursorprox/gemini-3.8-flash#high` | Recover missing known-secret scrubbing implementation | Partial: delivered failing regressions and real collector/scrubber helpers, but returned handoff before wiring normalizers/public projection. Parent completed context scrubbing before truncation/allowlisting. Verified107 snapshot/server tests pass. Unlike Pro's prior claim, this partial implementation and red tests were present on disk. |
| 2026-09-18 | `cursorprox/claude-opus-5#high` | Recover incomplete production adapters | Failed to complete: returned another handoff/next-steps summary after exploration, with missing providers/registry/tests still unwritten despite explicit completion request. Reassigned to a fresh Fable context with bounded scope and concrete APIs to avoid the long-session handoff loop. |
| 2026-09-18 | `cursorprox/claude-fable-5-1#high` | Cross-module CLI/credential-store integration tests | Delivered19 tests:18pass,1 genuine draft-adapter failure (Codex used_percent ignored by duplicate normalizer). Preserved failing assertion, reproduced direct adapter vs canonical normalizer difference. CRUD, no external writes, malformed-store protection, accounts/source privacy and source duplicates passed. Adapter fix is already assigned to fresh Fable owner. |
| 2026-09-18 | `cursorprox/claude-fable-5-1#high` | Fresh-context four-provider adapter recovery | Delivered all4 adapters+registry with shared implementation, purelogin, canonical normalizers, hard external expiry and managed refresh fanout.13 provider tests pass; whole suite664pass. Parent independently reran664tests and isolated CLI/server smoke checks successfully. |
| 2026-09-18 | `cursorprox/claude-opus-5#high` | Fresh-context final credential-boundary review | Completed: confirmed malformed proxx URL/thrown client hides local Codex accounts and aborts sources; no other blockers in scope. Parent fixed both discovery fallbacks and added regression. Final suite666pass/0fail. Fresh narrow review produced actionable evidence rather than another handoff. |

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
- Fable's renderer tests did not catch a schema mismatch because its fixtures
  repeated the same wrong fields. This is a concrete example of passing unit
  tests not proving conformance; cross-module integration tests remain required.
- Parent integration audit found `/api/health` still at schemaVersion1 with its
  test also asserting1, despite Gemini Pro's v2 completion claim. Both corrected
  to2. Parent also sanitized injected QuotaLoadError messages and disambiguated
  same-label web account keys; tested HTTP error privacy directly.

## Tooling interruptions

- The Plannotator session was cancelled by a server restart; no user decision
  was returned. This is infrastructure interruption, not model failure or approval.
- Parent connection was interrupted with WebSocket close 1006 during a patch
  invocation; resumed by checking `jj status`. No model deliverable was lost.

## Task-specific takeaways

- **Fable5.1** was the most dependable implementation/recovery worker in this
  run. It still needed explicit schema corrections, but its real-PTY QA found
  concrete bugs, its integration test retained a genuine failure, and a fresh
  context completed the provider layer that earlier handoffs left unfinished.
- **Opus5** gave useful detailed reviews and working snapshot/cleanup code.
  It needed correction on OAuth feasibility and v2 statuses; its long-lived
  session later returned repeated handoffs instead of completing adapters.
- **Grok4.6** supplied useful source-backed OAuth research. Its implementation
  delivery did not parse and lacked tests; Fable successfully recovered it.
- **Gemini3.7 Flash** completed the legacy regression-test split with233 retained
  tests passing.
- **Gemini3.8 Flash** produced a useful CLI repro and real red privacy tests,
  but its privacy implementation still needed parent completion.
- **Gemini3.1 Pro** delivered the server/web migration, but the claimed later
  privacy fix was absent on disk. Verify its deliverables against actual source
  and tests rather than treating a completion report as evidence.
- **Sol high** had not returned its initial protocol review by final integration;
  Grok's independent source review unblocked the task. No assertion is made about
  why that run did not return.

These are observations from this migration, not general rankings. No Luna,
Terra, or fast model variant was used. Gemini models named “Flash” are their
normal catalog models, not the excluded `-fast` variants.
