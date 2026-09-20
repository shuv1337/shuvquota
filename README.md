# shuvquota

A zero-dependency, self-managed quota monitor for **Codex, Claude, Grok, and
Google AI Pro / Antigravity**. Keep multiple accounts, check their quotas together,
or watch them in a responsive full-screen terminal view.

Requires Node.js 18 or newer. Optional discovery from SQLite-backed harness stores
requires a Node version with `node:sqlite`.

## Install

```sh
npm install -g shuvquota
# or
bun add -g shuvquota
```

Both `cq` and `shuvquota` are installed.

## Quick start

```sh
cq codex add personal
cq claude add work
cq                         # one-shot quota view
cq watch                   # live full-screen view
cq codex work              # one provider/account
cq --compact               # one line per metric
cq --json                  # redacted v2 snapshot
```

Bare `cq` always runs once. Cards fill the available terminal width; short or
narrow terminals fall back to compact rows and scrolling in watch mode.

### Watch controls

| Key | Action |
| --- | --- |
| `q`, Ctrl-C | Quit and restore the terminal |
| `r` | Refresh now |
| `e` | Toggle email visibility |
| `?` | Toggle help |
| `1` | All providers |
| `2`–`5` | Codex, Claude, Grok, Antigravity |
| `j`/`k`, arrows | Scroll |
| PgUp/PgDn | Scroll a page |
| `+`/`-` | Increase/decrease refresh interval by 15 seconds |

The default interval is 60 seconds; the minimum is 15. `cq tui` and `cq -w` are
watch aliases. Use `--once` to force one-shot output. Redirected input or output
falls back to a static view. A failed scan preserves the last completed view and
shows a stale marker; individual account failures appear on their own cards.

When Anthropic rate-limits quota reads, Claude waits at least five minutes (or a
longer `Retry-After`) before another request. The card shows the remaining wait.
Grok quota requires Grok Code CLI permission; OAuth sign-in or a SuperGrok plan
alone does not establish that permission. A provider denial is shown explicitly.

## Managed accounts

Every provider supports the same commands:

```sh
cq <provider> add [label]
cq <provider> reauth <label>
cq <provider> rename <old> <new>
cq <provider> remove <label>
cq accounts
cq sources
```

`add` obtains a new OAuth session through provider login. `reauth` replaces the
selected managed credential with a new login. Rename and remove affect only
shuvquota's store.

| Provider | Owned store |
| --- | --- |
| `codex` | `~/.codex-accounts.json` |
| `claude` | `~/.claude-accounts.json` |
| `grok` | `~/.grok-accounts.json` |
| `antigravity` | `~/.antigravity-accounts.json` |

Writes are atomic and use file mode `0600`. Old `activeLabel` metadata is ignored
and removed on the next write. Legacy rows without independent-enrollment
provenance need `reauth` before shuvquota may refresh them.

### Credential ownership

Shuvquota refreshes independently enrolled credentials and persists rotated tokens
only in its own stores. It never selects an active identity or writes credentials
into Codex CLI, Claude Code, OpenCode, pi, Hermes, or other harness stores.

External stores and environment credentials are optional read-only quota sources.
Their usable access tokens can be queried; expired external credentials require
independent enrollment with `cq <provider> add`. Shuvquota does not refresh these
external sessions. `cq sources` lists every physical source, including duplicates;
quota views deduplicate account identities and prefer managed labels.

If you have exactly one account for a provider but older sessions lack matching
identity metadata, set `SHUVQUOTA_SINGLE_ACCOUNT_PROVIDERS=claude,antigravity` in
`~/.shuvquota.env` (list only providers where this is true). Quota views select one
session per listed provider, preferring an independently managed session or a
usable access token over expired copies. `cq sources` still lists every source.
Remove a provider from this setting when you add a second account.

`cq accounts` prints labels and ownership status, never credentials.
`cq sources --json` intentionally includes source paths; quota JSON and the web API
do not.

## Provider configuration

Optional environment settings can be loaded from `~/.shuvquota.env`. Existing
process environment values take precedence. Keep this file private.

- **Codex / Claude:** use their provider login flows. Headless login presents a
  URL and the callback/code instructions appropriate to that provider.
- **Grok:** uses xAI OAuth PKCE. The known loopback client uses port `56121`.
- **Antigravity:** configure `ANTIGRAVITY_CLIENT_ID` and
  `ANTIGRAVITY_CLIENT_SECRET` for the installed-app flow. No client secret is
  included in the package. The loopback redirect uses port `36742`.
- **proxx:** optional read-only Codex quota source, configured through
  `PROXX_BASE_URL` and `PROXX_AUTH_TOKEN`. It has no separate namespace or provider
  snapshot. Remote failures retain local results.
- **Grok display plan:** existing `~/.grok-plan-override.json` and `planOverride`
  metadata remain display-only; edit them directly if needed.

OAuth endpoints, source evidence, client assumptions, and unverified live checks
are recorded in [the OAuth validation notes](docs/v2-oauth.md). A successful login
does not guarantee every subscription has access to every provider service.

## Output and privacy

Emails are masked by default. Use `--show-email` to reveal the email field in local
terminal/JSON output. The web API always applies its public projection. ANSI and
control characters from remote display text are sanitized.

```sh
cq --json
cq quota work --compact
cq watch --interval 90
cq --show-email
cq --no-color
```

`NO_COLOR` is also honored. Reset clocks use Pacific Time (`America/Los_Angeles`),
with PST/PDT as appropriate; machine timestamps are ISO 8601.

Completed quota snapshots use `schemaVersion: 2`, a `generatedAt` timestamp, and
an ordered `providers` array. Accounts contain labels, optional email/plan,
`status` (`ok`, `error`, or `loading`), windows, and optional extras. Window fields
are `id`, `label`, `percentRemaining`, `resetsAt`, and optional `detail`.
Quota snapshots do not contain raw provider responses, tokens, or source paths.

## Web dashboard / PWA

```sh
shuvquota-server
# development
bun run app
```

The dashboard defaults to `http://127.0.0.1:4789`. It uses the same in-process
quota loader as the CLI, with a public-data projection, a short cache, and
single-flight requests. The host allowlist, security headers, and static-file
path restrictions remain enabled. `/api/health` and `/api/quota` use schema v2.

## Migrating from v1

v2 removes Factory, OpenCode Go, and Synthetic, the standalone proxx namespace,
and harness-switching/synchronization commands (`switch`, `sync`, `set-plan`).
Removed command forms exit 2 with a v1 migration hint.

The v1 command surface remains available through **`npx shuvquota@1 …`**. The local
`v1.1.25-final` tag preserves the pre-migration source.

`--local`, `--native`, `--no-factory`, `--billing-day`, `--oauth`, `--manual`,
`--dry-run`, `--no-browser`, `--base-url`, and `--token` are removed. Use the unified
ownership policy and environment configuration described above. Reauthenticate
legacy imported managed accounts before relying on automatic refresh.

The JSON shape is breaking: consume the v2 `providers[].accounts[].windows[]`
model, not v1's raw provider-keyed responses.

## Development

```sh
bun test
bun run preflight
bun run release:pack
```

Tests use fixture credentials and mocked HTTP calls. `lib/` contains the provider
adapters, owned credential store, snapshot pipeline, CLI, server, and terminal UI;
tests import modules directly. No runtime dependencies are required.
