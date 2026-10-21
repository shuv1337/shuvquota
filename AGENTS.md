# shuvquota agent guide

## Product and runtime

`shuvquota` is a self-managed multi-account quota monitor for Codex, Claude, Grok,
and Antigravity. Node.js >=18, ESM, **zero runtime dependencies**. Use Bun for tests
and the commands in `package.json`. Commit only after the
relevant checks and full `bun test` pass.

The migration plan is `PLAN-v2-tui-readonly.md`. Check its progress and
`docs/v2-plan-review.md` before interpreting incomplete migration work. Actual
validation evidence is in `docs/v2-validation.md`; model outcomes are in
`MODEL-NOTES-v2.md`.

## Ownership boundary

- Only independently enrolled shuvquota credentials are refreshable and writable.
  Managed-store rows without `enrollment: "independent"` are ignored on read and
  dropped on the next write; there is no legacy-row support. Re-adding the
  account creates the owned session.
- Harness and environment sources are read-only. Query a usable access token;
  return an enrollment-required error when it expires. Never refresh an external
  credential, including non-rotating Google sessions.
- xAI rotates refresh tokens. Serialize refresh by credential identity; update all
  owned entries holding the previous refresh token. External stores are never
  fan-out targets. Detect known shared sessions rather than rotating one copy.
- Google may omit a replacement refresh token; preserve the previous token.
- Managed writes preserve unknown root metadata, drop `activeLabel`, use atomic
  replacement and mode `0600`. Malformed existing files must not be silently
  overwritten as empty stores.
- There is no active identity or harness switch/sync operation in v2.

## Module boundaries

| Concern | Location |
| --- | --- |
| Entry/config bootstrap | `shuvquota.js`, `lib/env.js` |
| Command parsing/routing | `lib/cli.js` |
| Owned account CRUD/persistence | `lib/credential-store.js` |
| Account operations shared by CLI and TUI | `lib/accounts.js` |
| Provider registry/adapters | `lib/providers/` |
| Independent enrollment | `lib/provider-oauth.js`, existing OAuth helpers |
| Read-only discovery / raw provider HTTP | `lib/*-accounts.js`, `lib/*-usage.js`, `lib/*-tokens.js` |
| Normalization and public/display projection | `lib/snapshot.js` |
| Parallel discovery/fetch/single-flight | `lib/quota.js` |
| Width/layout/rendering (one-shot cards and list) | `lib/tui/{width,layout,render}.js` |
| Watch shell (cell canvas, sidebar, detail pane) | `lib/tui/{canvas,shell}.js` |
| Watch state / terminal lifecycle and key parsing | `lib/tui/{app,terminal}.js` |
| Watch account panel state (pure) | `lib/tui/manage.js` |
| HTTP boundary / static serving | `lib/shuvquota-server.js` |
| Dashboard | `web/` |

The entry point has no barrel re-exports. Tests import the relevant `lib/` module
directly. Put new tests under `test/`; fixtures contain no real credentials.

## Shared contracts

Provider adapters expose `id`, `name`, `discoverAccounts`, `discoverSources`,
`fetch`, `normalize`, and `login`. Sources are physical and non-deduplicated;
accounts are deduplicated identities. proxx is an internal read-only Codex source,
merged by stable identity; it is not a separate provider. Missing remote identity
never collapses unrelated local records.

`loadSnapshot({ providers, labelFilter, onProgress })` takes provider objects.
Flights are keyed by provider identity/set and normalized label filter. Each
provider has at most four concurrent account fetches. Late subscribers receive
progress; callback failures must not abort the scan.

Snapshot schema is v2. Account status is exactly **`ok`, `error`, or `loading`**.
Low quota is successful data, not another status. Windows use
**`percentRemaining` and `resetsAt`**. Derive severity in presentation code.

Public projection is constructive: copy permitted fields, sanitize every display
string, and always mask email. `toPublicSnapshot()` never accepts an email reveal
option. Local JSON/terminal use `toDisplaySnapshot({…}, { showEmail })`; reveal
only email, not paths, tokens, account IDs, or arbitrary raw fields. Source paths
are exposed only by explicit `sources` output. Preserve this boundary for injected
server loaders and error responses as well as the default loader.

`renderStatic` and `renderCompact` return arrays of lines. Layout is pure and
bounded by terminal cell width, including CJK/combining/emoji sequences. Test
actual v2 snapshot fixtures across module boundaries; fixture-only unit tests can
hide schema drift. Terminal lifecycle changes require real PTY checks in addition
to fake-stream unit tests: full-width final cells, stale redraw tails, process
exit, raw mode, and paused stdin have all produced bugs during this migration.
Keys are parsed in `terminal.js` (`parseKeys`), not readline: Bun's keypress
decoder holds a lone ESC, so Esc never arrives and the next key becomes Alt+key.
Check modal keys under both `bun` and `node` in a PTY.

## Adding a provider

1. Establish an independent login protocol and ownership policy before adding a
   refresh path. Record source evidence and unverified live assumptions separately.
2. Add the adapter and explicit owned-store mapping; reuse generic token field
   normalization and atomic store operations.
3. Add snapshot normalization without raw payloads or credential provenance.
4. Test discovery, physical source duplicates, managed refresh serialization,
   external-file immutability, public privacy, and renderer integration.
5. Update CLI/provider ordering, dashboard mapping, and user documentation together.

OAuth client secrets stay out of source. Antigravity uses
`ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` from the environment. See
`docs/v2-oauth.md` when changing enrollment protocols or client assumptions.

## Style and validation

- Tabs, double quotes, semicolons, trailing newline; use `node:` built-in imports.
- Exported functions have concise JSDoc. Keep pure normalization separate from I/O.
- Optional reads may return empty results; destructive writes reject malformed
  stores. Provider HTTP calls use timeouts and clean up timers in `finally`.
- Restore environment variables and fetch mocks after tests. Avoid live credential
  access in tests and smoke checks; use an isolated home and fixture loaders.
  Under Bun, `os.homedir()` ignores `process.env.HOME` assigned at runtime: set
  `HOME` when launching a smoke harness and assert `homedir()` before importing
  store code, or pass `home` explicitly.
- `bun test`, `bun run preflight`, and `bun run release:pack` are release checks.
  The preflight clean-tree check can fail during work; report that separately from
  code failures. `package.json` must continue publishing `lib/` and `web/`.
