# PLAN: shuvquota v2 — self-managed multi-account quota monitor with a responsive TUI

## Summary

Turn shuvquota into a multi-provider quota monitor with a btop-style responsive
terminal UI and a clear credential-ownership boundary. Shuvquota continues to own
multiple credentials per provider and keeps account enrollment, reauthentication,
rename, and removal. It stops switching or synchronizing credentials into coding-agent
harnesses and drops the second-class providers (Factory, OpenCode Go).

OAuth login is the enrollment path for Codex, Claude, Grok, and Antigravity. Zero runtime
dependencies stays a hard constraint. The TUI is hand-rolled on raw ANSI +
`process.stdout` resize events + readline raw mode.

This is a breaking release: **v2.0.0**.

---

## 1. Review findings

### Size and shape (as of `5908912`)

| Area | Lines | Notes |
|------|------:|-------|
| `lib/handlers.js` | 4,215 | Local account ownership and harness-mutation commands are interleaved; Factory CRUD is also embedded here |
| `lib/display.js` | 2,607 | ~1,000 lines are 30 `printHelp*` functions; box drawing + per-provider line builders |
| `lib/sync.js` | 1,446 | Divergence detection, reverse-sync, "fresher store" — all mutation-support code |
| `lib/claude-usage.js` | 982 | ~450 lines are legacy session-key / Chromium cookie decryption path |
| `lib/oauth.js` + `lib/claude-oauth.js` | 660 | PKCE browser login flows — retained and generalized for shuvquota-owned credentials |
| Factory (`factory-*.js`) | 882 | + ~1,300 lines of Factory handlers + ~4,500 lines of Factory tests |
| `lib/opencode-go-usage.js` | 415 | HTML scraping of a dashboard with a session cookie; brittle |
| `lib/shuvquota-server.js` | 1,175 | ~500 lines re-normalize the CLI's `--json` output into windows for the web UI |
| `shuvquota.js` | 635 | 250 lines routing + **385 lines of barrel re-exports** that exist only so tests can import from one file |
| `shuvquota.test.js` | 10,048 | 100 `describe` blocks; ~46 cover features slated for removal |
| Total (src + tests + web) | 31,468 | |

### Structural problems

1. **Rendering is hard-capped, not responsive.** `drawQuotaBox` clamps every card to
   `QUOTA_BOX_MAX_WIDTH = 50` and stacks cards vertically. A 200-column terminal shows
   one 50-wide column with 150 columns of nothing; a 45-column pane wraps lines inside the
   box with heuristic continuation indents (`wrapBoxLine`, ~150 lines of special-casing for
   `(resets …)`). Height is never considered. There is no live mode at all.
2. **Presentation is coupled to raw provider payloads.** Each provider has its own
   `build*UsageLines` in `display.js` that reads raw API shapes. The server then has a
   second, independent set of `normalize*Account` functions that turn the same raw JSON
   into `windows[]` for the web. Two normalizers, zero shared model.
3. **`handleQuota` is a 585-line straight-line function** with seven near-identical
   provider blocks (load → filter → not-found error → fetch → results), followed by seven
   near-identical JSON mappers and seven near-identical line-builder loops. Adding a
   provider means editing ~10 places.
4. **Fetching is mostly serial.** Codex, Factory, Grok, Antigravity loop with `await`
   per account. Only Claude uses `Promise.all`.
5. **Two mode flags fight each other.** `--local` (default) reads only shuvquota-managed
   files; `--native` also reads CLI auth stores and runs divergence checks. V2 needs one
   explicit rule instead: managed credentials are writable and authoritative; harness
   credentials are optional read-only sources.
6. **The barrel re-export + "tests import from `shuvquota.js`" rule** doubles the cost of
   every new export and keeps 385 lines of pure plumbing in the entry point.
7. **Repo hygiene.** Stale plan files (`plan.md`, `PLAN-modularize-refactor.md`,
   `design-qa.md`), a committed `.factory/` validation tree, `.claude/settings.local.json`,
   `antigravity.test.js` is mode 0600, README still leads with
   `codex add` / `switch`.

### What is already good and should be kept

- Zero dependencies, ESM, Node built-ins with `node:` prefix, tabs, JSDoc.
- Per-provider account discovery modules (`*-accounts.js`) and fetchers (`*-usage.js`)
  are cleanly separated and mostly pure.
- Token refresh modules are correct about the dangerous cases (xAI refresh-token
  rotation fan-out; Antigravity in-memory only). These rules must survive during
  migration to shuvquota-owned stores.
- OAuth login and shuvquota-owned multi-account containers are product capabilities,
  not deletion targets. The problematic behavior is mutating harness credentials to
  select an active identity.
- The server's `buildQuotaSnapshot` window model (`{ id, label, percentRemaining,
  resetsAt, … }`) is the right abstraction — it just lives in the wrong place.
- `web/` dashboard, single-flight loader, host allow-listing.
- Test discipline (Bun, env restore in `afterEach`, fixture-based).

---

## 2. Target product

### Command surface (v2)

```
cq                      # one-shot responsive quota view, all providers (default)
cq watch                # live full-screen TUI, auto-refresh (alias: cq tui, cq -w)
cq quota [label]        # same as `cq`
cq <provider> [quota] [label]      # codex | claude | grok | antigravity
cq <provider> add [label]           # OAuth login into shuvquota's managed store
cq <provider> reauth <label>        # replace that shuvquota-owned credential
cq <provider> rename <old> <new>    # rename only in shuvquota's store
cq <provider> remove <label>        # remove only from shuvquota's store
cq accounts             # managed accounts, labels, and provider; never prints secrets
cq sources              # every physical credential source, including read-only external sources

Flags
  --json           machine-readable snapshot (new v2 shape, schemaVersion: 2)
  --compact        one line per metric, no boxes (unchanged semantics)
  --once           force one-shot even if a TTY (for `watch` scripts / aliases)
  --interval <s>   watch refresh interval (default 60)
  --show-email     unredacted emails
  --no-color       (also honours NO_COLOR)
  --version, --help
```

Removed: namespaces `factory`, `opencode-go`; subcommands `switch`, `sync`, `set-plan`;
flags `--local`, `--native`, `--no-factory`, `--billing-day`, `--oauth`, `--manual`,
`--dry-run`, `--no-browser`, `--base-url`, `--token` (proxx uses env only).

Removed commands and namespaces print a one-line error pointing at
`npx shuvquota@1 …`. The guard covers top-level and provider-qualified forms and exits 2.

### Credential ownership boundary

- **Does** create, reauthenticate, rename, and remove credentials in shuvquota-owned
  multi-account stores.
- **Never** changes the active identity or writes selected credentials into Codex,
  Claude Code, OpenCode, pi, Hermes, or other harness auth stores.
- Shuvquota-owned OAuth sessions are acquired independently through provider login.
  They are not copied rotating refresh-token sessions from harness stores.
- **Does** refresh shuvquota-owned access tokens and writes rotated tokens back only to
  shuvquota's store. Refresh for one account is serialized by credential identity.
- External harness stores may be discovered for `sources` and optional quota fallback,
  but are read-only. A rotating refresh token found only in an external store is not
  refreshed; the account reports that local enrollment is required.
- No `activeLabel` concept. All discovered accounts are peers; dedup by identity
  (email / accountId / usage fingerprint) as today.

### Providers

First-class, kept: **Codex (OpenAI)**, **Claude**, **Grok / SuperGrok**, and
**Antigravity (Google AI Pro)**.

Dropped: **Factory** (needs account CRUD + AES auth.v2 crypto to be useful; ~40% of the
main test file), **OpenCode Go** (HTML scraping with a manually-copied cookie), and
**Synthetic** (API-key-only enrollment does not fit the v2 OAuth-owned account model).

Kept as an optional read-only Codex source: **proxx**. It is folded into the Codex
provider and has no standalone namespace or provider snapshot.

Candidate cut (Q4): Claude legacy session-key / Chromium cookie path
(`readClaudeCookiesFromDb`, `decryptChromeCookie`, `fetchClaudeUsage` legacy). Keep the
OAuth path for shuvquota-managed accounts; Claude Code, OpenCode, and pi remain optional
read-only sources under the external-source policy.

---

## 3. Architecture

### 3.1 Shared snapshot model (`lib/snapshot.js`)

Move the server's normalizers into `lib/` and make them the single source of truth for
CLI static output, TUI, `--json`, and the server.

```js
/** @typedef {{
 *   schemaVersion: 2,
 *   generatedAt: string,           // ISO
 *   providers: ProviderSnapshot[],
 * }} Snapshot */

/** @typedef {{
 *   id: "codex"|"claude"|"grok"|"antigravity",
 *   name: string,                   // "Codex", "Claude", …
 *   accounts: AccountSnapshot[],
 *   error?: string,                 // provider-level failure (e.g. config incomplete)
 * }} ProviderSnapshot */

/** @typedef {{
 *   label: string, email: string|null, plan: string|null,
 *   status: "ok"|"error"|"loading",
 *   error?: string,
 *   windows: Window[],              // ordered: short → long
 *   extras?: Array<{ label: string, value: string }>,  // banked resets, overage, tier…
 * }} AccountSnapshot */

/** @typedef {{
 *   id: string, label: string,      // "5h", "Weekly", "Credits", "Search/hr"
 *   percentRemaining: number|null,  // 0–100, null when unknown
 *   resetsAt: string|null,          // ISO
 *   detail?: string,                // "1.2M / 5M tokens"
 * }} Window */
```

The internal snapshot may retain full email for terminal rendering, but it never contains
tokens, raw provider payloads, or filesystem paths. Terminal rendering redacts email unless
`--show-email` is set. `--json` is redacted by default. The server runs a separate
`toPublicSnapshot()` projection that always masks email and is covered by tests proving
that paths, IDs, tokens, and full emails cannot reach `/api/quota`.

Credential provenance is modeled separately from quota snapshots:

```js
/** @typedef {{
 *   provider: string, label: string, kind: "managed"|"env"|"harness"|"remote",
 *   location: string, identityKey: string|null, writable: boolean,
 * }} CredentialSource */
```

`cq sources` uses the physical, non-deduplicated `CredentialSource[]`; quota views use
deduplicated account identities. Human output may shorten paths, while `--json` includes
paths only for the explicitly invoked `sources` command. The web API never exposes them.

### 3.2 Provider interface (`lib/providers/*.js`)

Each provider exports one object with the same shape; `lib/quota.js` becomes a generic
pipeline.

```js
export const codex = {
	id: "codex",
	name: "Codex",
	/** Deduplicated identities for quota fetching. */
	discoverAccounts(),
	/** Physical credentials for `cq sources`; never deduplicated. */
	discoverSources(),
	/** refresh-if-needed + fetch; never throws */
	fetch(account, ctx) → { usage } | { error },
	/** raw → AccountSnapshot */
	normalize(account, result, now) → AccountSnapshot,
	/** Provider-specific OAuth enrollment into shuvquota's store. */
	login(ctx) → ManagedCredential,
};
```

Account rename/remove are generic store operations after provider validation. Proxx is an
internal Codex source adapter: Codex merges local and remote results, deduplicates by stable
account identity, prefers shuvquota-managed labels, and retains a local account when proxx
fails.

`lib/quota.js`:

```js
export async function loadSnapshot({ providers, labelFilter, onProgress })
```

- Discovers all providers in parallel, fetches all accounts in parallel
  (`Promise.allSettled`), with a per-provider concurrency cap of 4 to be polite.
- `onProgress(partialSnapshot)` fires as each account resolves so the TUI can paint
  cards incrementally.
- Single-flight applies to the normalized provider set and label filter, not globally.
  Each flight owns a subscriber set so overlapping callers receive subsequent progress
  events. Credential refresh is additionally serialized by provider + credential identity;
  this protects rotation within one parallel scan as well as across scans.

Existing `*-accounts.js`, `*-tokens.js`, `*-usage.js`, and OAuth helpers are kept and
become the implementation behind each provider object; `handlers.js` shrinks to CLI
plumbing only. `lib/credential-store.js` owns generic list/rename/remove and atomic writes
for shuvquota-managed credentials; it has no harness-auth write APIs.

### 3.3 Layout engine (`lib/tui/layout.js`) — pure, testable

Input: `Snapshot`, `{ cols, rows }`, options. Output: a list of positioned cards with a
density tier and the exact lines to draw. No terminal access; unit-tested with fixed
sizes.

**Card widths.** `cardWidth` is the outer width including borders. Target outer width is
48 (46 content columns). Columns:

```
gap = 2
columns = clamp(floor((cols + gap) / (48 + gap)), 1, cardCount)
cardWidth = floor((cols - gap * (columns - 1)) / columns)
```

Cards fill the row (stretch), so a 120-col terminal gets two 59-wide cards and 200 cols
gets four 48-wide cards. Row-major placement; cards in a row share height. Total grid
height is the sum of each row's maximum card height plus inter-row gaps.

**Density tiers**, chosen per frame so the grid fits `rows` (fall down a tier when total
grid height would overflow; below tier 0, enable scrolling):

| Tier | Card width | Content |
|------|-----------:|---------|
| 3 full | ≥ 44 | header (provider · label · plan · email), one bar row per window with `NN% left (resets 12:01 Thu)`, extras |
| 2 | 36–43 | header, bar row per window with short reset (`3h`, `2d`), no extras |
| 1 | 28–35 | header, one compact line per window `5h  64%  3h` (no bar) |
| 0 table | any | one line per account: `Codex   work   5h 64%  wk 22%` — a ruled table, not cards |

Bar width scales with card width: `clamp(cardWidth - labelWidth - 12, 8, 30)`.

**Height fallback order when rows are short:** drop extras → tier 2 → tier 1 → tier 0 →
scroll (with a `▲/▼ N more` indicator in the footer).

**Very narrow (< 28 cols):** tier 0 with label truncation (`…`), never overflow. Never
rely on terminal auto-wrap (PRODUCT.md principle).

**Ordering:** providers in fixed order (codex, claude, grok, antigravity),
accounts by label. Deterministic output for tests and scripts.

**Colour:** percent thresholds unchanged (≤20 red, ≤60 yellow, else green). Meaning never
depends on colour: percent text is always present; error cards show `error:` text.

### 3.4 Static renderer (`lib/tui/render.js`)

`renderStatic(snapshot, { cols, color })` → `string[]`. Used by `cq` one-shot. Uses the
layout engine at `process.stdout.columns ?? 80` with unlimited rows (no height fallback,
always tier 3 unless width forces lower). Replaces `drawBox`, `drawQuotaBox`,
`wrapBoxLine`, `sharedBoxMinWidth`, `continuationIndent`, and every `build*UsageLines`.
Boxes keep the current rounded style (`╭─╮│╰─╯`).

`--compact` renders tier 1 lines without borders (keeps today's grep-friendly semantics).

### 3.5 Live TUI (`lib/tui/app.js`, `lib/tui/terminal.js`)

`terminal.js` (thin, ~150 lines):
- enter/leave alternate screen (`\x1b[?1049h/l`), hide/show cursor, clear.
- `readline.emitKeypressEvents` + raw mode; key parsing for `q`, `r`, `e`, `?`,
  `j/k`/arrows/PgUp/PgDn, `1–5`, `Ctrl-C`.
- `process.stdout.on("resize")` → re-layout.
- guaranteed restore on `exit`, `SIGINT`, `SIGTERM`, uncaught error.
- refuse to start when `!process.stdout.isTTY` (print a hint and fall back to static).

`app.js` state machine:
```
{ snapshot, loading, lastUpdatedAt, nextRefreshAt, error, scroll, showEmail,
  providerFilter, showHelp }
```
- Frame = header (title · last updated · next refresh countdown · `?` hint) + grid +
  footer (key hints / scroll indicator / transient error).
- Full-frame redraw on each tick (simple; frames are small). Coalesce redraws with
  `setImmediate`; tick once per second for the countdown only when visible.
- Cards render `loading…` skeletons on first paint, then fill in via `onProgress`.
- A whole-scan failure keeps the last good snapshot and shows the error in the footer with
  a stale marker. Account-level failures update only that account to an error card; they do
  not make the whole frame stale. `generatedAt` advances after a completed scan, while
  `lastSuccessfulAt` advances only when at least one requested account succeeds.
- Keys: `q` quit · `r` refresh now · `e` toggle email redaction · `1–5` toggle provider ·
  `?` help overlay · `j/k`/arrows scroll · `+/-` interval.

### 3.6 Server and web

- `lib/shuvquota-server.js` imports `loadSnapshot()` in-process instead of spawning the
  CLI (Q6), then calls `toPublicSnapshot()` before caching or responding. Delete
  `executeQuotaCli` and move provider normalizers into `lib/snapshot.js`. Keep the server
  cache, host allow-list, static file serving, security headers, and privacy regression
  tests.
- `web/app.js` reads `schemaVersion: 2` snapshot; delete Factory / OpenCode Go branches
  and `web/icons/providers/opencode-go.svg`.
- `oxfile.toml` unchanged.

### 3.7 Entry point and tests

- `shuvquota.js` → arg parsing + routing only (~120 lines). **No barrel re-exports.**
- Tests import from `lib/` directly. Split `shuvquota.test.js` into per-module files
  under `test/` (`test/providers/codex.test.js`, `test/tui/layout.test.js`, …). Bun
  picks up `test/**/*.test.js`; update `package.json` `test` script if needed.
- Layout engine gets golden tests at fixed sizes: 200×50, 120×40, 80×24, 60×20, 45×30,
  30×12, 24×8, and a "many accounts, short terminal" case that must trigger tier
  fallback and scrolling. Golden output stored as fixtures, `--no-color`.
- Keep and adapt existing pure-function tests (JWT, dedup, token match, refresh rules,
  reset formatting, redaction, server host checks). Add assertions that public snapshots
  contain no source paths or full emails and that `sources` preserves duplicate physical
  credentials.

---

## 4. Phased execution

Execution notes (2026-09-18 PDT): review corrections are recorded in
`docs/v2-plan-review.md`; validation evidence in `docs/v2-validation.md`; model
outcomes in `MODEL-NOTES-v2.md`. Use the recommended Q1–Q8 defaults. The Phase 6
server/web schema migration must land alongside Phase 3. Pure renderer modules
may be developed independently, with integration deferred until Phase 3.

Each phase ends with `bun test` green, smoke checks, and one commit. Phase 1 is deletion.
Phase 2 is a behavior-changing credential-boundary migration and must add tests alongside
each removal.

### Phase 0 — Baseline and guardrails
- [x] Tag current `main` as `v1.1.25-final`; note in README that v1 is `npx shuvquota@1`.
      Actual trunk is `master`; local tag points at `59089120`.
- [ ] Capture `cq --json --local` and `cq --json --native` output for every provider you
      have credentials for, redacted, into `/tmp/` as a manual regression reference
      (not committed).
- [ ] Verify and document a direct installed-app OAuth flow for Codex, Claude, Grok, and
      Antigravity: authorization/token endpoints, redirect method, scopes, client
      configuration, refresh rotation, and provider-policy constraints. Stop before Phase
      2 if any provider cannot issue an independent shuvquota-owned session.
- [x] Record smoke checklist: `--version`, `--help`, `cq`, `cq --json`, `cq --compact`,
      `cq claude`, `bun run app` + `curl /api/quota`.
      Recorded in `docs/v2-validation.md`; recording is distinct from passing all gates.
- [ ] Commit: `chore: tag v1 baseline and record v2 smoke checklist`

### Phase 1 — Remove second-class providers
- [x] Delete `lib/factory-*.js`, `lib/opencode-go-usage.js`,
      `lib/synthetic-accounts.js`, `lib/synthetic-usage.js`, `opencode-go.test.js`, and
      `synthetic.test.js`.
- [x] Remove Factory / OpenCode Go / Synthetic from `handlers.js`, `display.js`, `constants.js`,
      `token-match.js` (`FACTORY_TOKEN_FIELDS`), `shuvquota.js` routing + barrel.
- [x] Remove Factory / OpenCode Go / Synthetic `describe` blocks from `shuvquota.test.js`
      (≈ lines 331–1401, 5630–9186 region — verify by name, not by line).
- [x] Server: drop `--no-factory` from `executeQuotaCli` args; delete
      `normalizeOpenCodeGoAccount` and `normalizeSyntheticAccount`; web: remove provider
      branches and icons.
- [x] README/AGENTS.md: remove sections. Delete `.factory/`.
- [ ] Commit: `feat!: drop Factory and OpenCode Go providers`

### Phase 2 — Establish shuvquota-owned credential management
- [ ] Keep `lib/oauth.js`, `lib/claude-oauth.js`, and the prompt/browser helpers. Extract
      reusable PKCE, callback, manual-code, timeout, and headless behavior rather than
      deleting their tests.
- [ ] Delete `lib/sync.js` and all `switch`/`sync` handlers that write credentials or an
      active identity into Codex, Claude Code, OpenCode, pi, or Hermes stores.
- [ ] Explicitly remove `maybeImportClaudeOauthStores`; quota display must never prompt or
      import harness credentials as a side effect.
- [ ] Create `lib/credential-store.js` for shuvquota-owned containers: atomic add,
      replace-on-reauth, rename, remove, list, and token-refresh updates. Preserve unknown
      root fields and file mode 0600; never expose a harness-auth write function.
- [ ] Keep and simplify provider commands `add`, `reauth`, `rename`, and `remove` for
      Codex and Claude. Add the same managed-account contract for Grok and Antigravity.
- [ ] Add direct OAuth login adapters for Grok and Antigravity. Document required OAuth
      client configuration without committing client secrets.
- [ ] Remove `--local/--native` and divergence checks. Managed accounts are authoritative;
      external harness stores are read-only discovery/fallback sources and are never
      refreshed when doing so would rotate their token.
- [ ] Remove `activeLabel` behavior from loaders and managed stores. Existing fields are
      tolerated during migration but ignored and removed on the next managed-store write.
- [ ] Add `cq accounts` for deduplicated managed identities and `cq sources` for every
      physical source. Neither command prints credentials.
- [ ] Removed-command guard: `switch|sync|set-plan`, plus the removed `factory` and
      `opencode-go` namespaces → stderr v1 hint + exit 2 in top-level and provider forms.
- [ ] Consolidate help into `printHelp()`, `printHelpProvider(id)`, and one generic
      account-management help template.
- [ ] Tests: remove switch/sync/divergence/active-label tests; retain OAuth and local CRUD
      tests; add no-harness-write tests, rotating-external-token refusal tests, and generic
      credential-store contract tests for every provider.
- [ ] Decide Q4 (Claude cookie path) and apply.
- [ ] Commit: `feat!: own provider credentials without mutating harness auth`

Expected size after Phase 2 must be re-measured; retaining and expanding OAuth means the
previous 12–14k-line estimate is no longer credible.

### Phase 3 — Provider interface + shared snapshot
- [ ] Create `lib/snapshot.js` by moving `buildQuotaSnapshot` + `normalize*` +
      `normalizeWindowValues` + `sanitizeDisplayText` + `maskEmail` out of the server.
- [ ] Create `lib/providers/{codex,claude,grok,antigravity}.js`
      implementing the interface in §3.2 on top of existing modules.
- [ ] Implement proxx as an internal read-only source of the Codex provider, with fixture
      tests for merge, deduplication, and remote failure fallback.
- [ ] Create `lib/quota.js` with `loadSnapshot()` (parallel, single-flight,
      `onProgress`).
- [ ] `--json` now emits the v2 snapshot. Add `schemaVersion: 2`.
- [ ] `handleQuota` → `lib/cli.js`: parse → `loadSnapshot` → render/JSON. Delete the
      seven duplicated blocks.
- [ ] Tests: snapshot normalizers (moved from `shuvquota-server.test.js`), one
      contract test per provider (`discover` on fixtures, `normalize` on captured
      payloads), `loadSnapshot` single-flight + partial-failure behaviour.
- [ ] Commit: `refactor: unify providers behind one interface and shared snapshot`

### Phase 4 — Responsive static renderer
- [ ] `lib/tui/layout.js` (grid + density tiers + height fallback) and
      `lib/tui/render.js` (cards, table mode, bars, borders).
- [ ] `lib/tui/width.js`: ANSI stripping, terminal cell width, and truncation with `…`.
      Handle CJK wide characters, combining marks, emoji/surrogate pairs, and control
      removal without runtime dependencies; test dynamic labels and emails.
- [ ] `cq` one-shot uses `renderStatic`. Delete `drawBox`, `drawQuotaBox`,
      `wrapBoxLine`, `continuationIndent`, `sharedBoxMinWidth`, `QUOTA_BOX_MAX_WIDTH`,
      all `build*UsageLines`, `formatCompactMetric` (folded into tier 1).
- [ ] Golden layout tests at the sizes listed in §3.7.
- [ ] Commit: `feat: responsive multi-column quota layout`

### Phase 5 — Live TUI
- [ ] `lib/tui/terminal.js` (alt screen, raw keys, resize, restore-on-exit).
- [ ] `lib/tui/app.js` (state, refresh loop, keybindings, help overlay, incremental
      paint, stale/error footer).
- [ ] `cq watch` / `cq tui` / `-w`, `--interval`, `--once`.
- [ ] Manual QA matrix: tmux split panes at 40/60/80/120/200 cols; resize while
      loading; refresh failure mid-session; `Ctrl-C` restores terminal; non-TTY falls
      back to static; `NO_COLOR`.
- [ ] Unit tests for key parsing and app state transitions (no real TTY needed).
- [ ] Commit: `feat: live full-screen quota TUI (cq watch)`

### Phase 6 — Server and web alignment
- [ ] Server imports `loadSnapshot` in-process (Q6), projects it through
      `toPublicSnapshot()`, and removes `executeQuotaCli` and
      `DEFAULT_SHUVQUOTA_CLI_PATH`.
- [ ] `web/app.js` consumes v2 snapshot; drop v1 shape handling and explicitly migrate
      `remainingPercent`/`resetAt`, status severity, summary, divergence removal, and the
      `/api/health` schema version.
- [ ] Update `shuvquota-server.test.js` for the new loader seam.
- [ ] Commit: `refactor(server): serve shared snapshot in-process`

### Phase 7 — Docs, hygiene, release
- [ ] Split remaining `shuvquota.test.js` into `test/**`; delete barrel exports.
- [ ] Rewrite README for v2 (install, `cq`, `cq watch`, managed account login and CRUD,
      providers, credential ownership, sources, JSON schema, PWA, migration from v1).
      Rewrite AGENTS.md (structure, provider interface, OAuth/store contracts, "how to
      add a provider", test layout). Update PRODUCT.md purpose line.
- [ ] Delete `plan.md`, `PLAN-modularize-refactor.md`, `design-qa.md`, this file's
      completed sections (or move to `docs/`), `.claude/settings.local.json` (add to
      `.gitignore`), fix 0600 test file modes.
- [ ] `scripts/preflight.js`: require `lib/`, `web/`; drop Factory checks.
- [ ] `package.json`: version `2.0.0`, description "Self-managed multi-provider quota
      monitor…", `files`, `test` script glob.
- [ ] Commit: `chore: v2.0.0 docs, test split, repo cleanup`

---

## 5. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Users relying on `cq codex switch` / harness sync | Major version; clear stderr hint to `npx shuvquota@1`; v1 tag |
| Token rotation races in `watch` mode | Request-keyed single-flight plus per-credential refresh lock; interval floor 15 s |
| Refreshing an external rotating token invalidates a harness session | Never refresh external-only sessions; require independent managed OAuth enrollment |
| Provider OAuth does not support a suitable public/native client flow | Validate each provider before Phase 2 and document required client configuration |
| Alt-screen / raw mode quirks (Windows Terminal, mosh) | Fallback to static when `!isTTY`; `--once`; restore on every exit path |
| Unicode width miscalculation | Zero-dependency terminal cell-width helper; fixtures for CJK, combining marks, and emoji |
| Web API leaks local paths or full identity | Separate public projection; retain current privacy regression tests and add v2 fixtures |
| Layout regressions at odd sizes | Golden tests at nine sizes incl. degenerate 24×8 |
| Server behaviour change (in-process) | Same single-flight/cache semantics; timeout via `AbortController` in each fetcher |
| Deleting the wrong tests | Remove by `describe` name, never by line range; run `bun test` after each deletion batch |

---

## 6. Decisions needed before starting

**Q1. Default for bare `cq` on a TTY: one-shot (recommended) or live TUI?**
Recommended: one-shot, because the primary use is a quick glance mid-workflow; `cq watch`
for the btop-style view. Alternative: TTY → TUI, non-TTY → static, `--once` to override.

**Q2. Credential ownership and refresh.**
Recommended: refresh and persist only independently enrolled shuvquota-managed sessions.
Never rotate an external harness session because doing so would require writing the new
token back into that harness. External-only expired accounts show an enrollment-required
error. This replaces the old cross-store xAI fan-out rule at the product boundary; fan-out
still applies within duplicate physical entries in shuvquota's own managed stores.

**Q3. Keep `proxx`?** Recommended: keep as an optional Codex source configured via
`PROXX_AUTH_TOKEN` / `PROXX_BASE_URL` in `~/.shuvquota.env`; drop the `--base-url/--token`
flags and the separate namespace. The Codex provider merges it with managed/local results.

**Q4. Drop Claude session-key / browser-cookie path?** Recommended: yes — it decrypts
Chromium's cookie DB, is ~450 lines, and is the most fragile code in the repo. Keep
managed OAuth accounts only for writable credentials. Alternative: keep
`CLAUDE_ACCOUNTS` `sessionKey` support without the cookie-DB scraping.

**Q5. Plan overrides.** `set-plan` commands are removed. Keep *reading*
`~/.grok-plan-override.json` and `planOverride` fields (display-only metadata)?
Recommended: yes, document editing the file by hand.

**Q6. Server loader: in-process (recommended) or keep spawning the CLI?** Spawning gives
crash isolation but duplicates parsing and costs a process per refresh.

**Q7. Refresh interval default for `watch`: 60 s?** Providers are rate-limited and quota
changes slowly; 60 s with `r` for manual refresh seems right.

**Q8. External harness credentials in quota output.** Recommended: show them only while
their access token remains usable, mark them read-only, and direct expired accounts to
`cq <provider> add`. Alternative: exclude harness credentials entirely and show them only
in `cq sources`.
