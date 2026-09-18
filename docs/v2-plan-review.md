# v2 plan review

Reviewed against baseline `59089120`; 2026-09-18 PDT.

## Adopted execution corrections

1. **Phase 1 preflight**: remove the deleted OpenCode Go icon requirement in the
   same phase as the icon (`scripts/preflight.js:40` at baseline). Remove Factory
   barrel-completeness tests by content as well as named provider tests.
2. **Server transition**: drop each removed CLI flag from `executeQuotaCli` in
   the phase that removes it (`lib/shuvquota-server.js:823–830`). Implement the
   Phase 6 server/web schema transition alongside Phase 3, so the v2 CLI payload
   is never fed into the v1 normalizer on a supposedly green phase boundary.
3. **Credential migration**: distinguish independently enrolled credentials from
   legacy imported/shared sessions. A physical managed-file path alone does not
   establish independent ownership. Treat the legacy `.opencode` multi-account
   source as external until a safe migration policy is established.
4. **Container semantics**: remove unconditional `activeLabel` emission from
   `buildMultiAccountPayload` (`lib/container.js:96–108`); preserve other root
   metadata and enforce mode 0600 on managed writes.
5. **proxx**: merge rather than replace local accounts; apply label filtering
   after merging. Merge only on a verified stable identity; missing IDs never
   collapse unrelated records (`lib/handlers.js:3506–3520` and
   `lib/proxx-usage.js:38–44`).
6. **Privacy**: construct public snapshots field-by-field from an allowlist,
   sanitizing labels, errors, details, and extras as well as the email field.
   Internal unredacted email does not license copying arbitrary internal fields
   into the public projection. Test success and failure payloads.
7. **Phase 2 documentation**: update removed-behavior README assertions with the
   behavior change, rather than leaving them until Phase 7.
8. **TUI semantics**: non-TTY watch falls back to static, exit 0, with its hint
   on stderr. Enforce the 15-second interval floor. Account-level failures remain
   account errors even if all accounts fail; whole-scan failures retain prior data.

## OAuth gate — pending independent protocol evidence

The existing repository has login flows for Codex and Claude, but only discovery
and refresh for Grok and Antigravity. Their missing adapters are implementation
work, not proof of protocol impossibility. The configured Google client secret
also does not by itself rule out an installed-app flow.

Before Phase 2, establish supported authorize/token endpoints, redirect method,
scopes, client configuration, and session rotation for all four providers. Clearly
separate source-code evidence, provider policy, and actual live enrollment checks.
Do not silently classify legacy imported rotating sessions as independent.

The plan's stricter recommended Q2/Q8 behavior remains the default: external
credentials are usable only while their access token is usable. Allowing Google
external in-memory refresh would be a product-policy amendment, not a necessary
technical fix, and has not been adopted implicitly.

## Evidence sources

- Opus: repository-grounded migration review.
- Fable: independent 695-test baseline and pack/preflight audit.
- Sol: protocol feasibility review (pending).
- Individual model outcomes and corrections: `../MODEL-NOTES-v2.md`.
