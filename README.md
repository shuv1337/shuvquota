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

`shuvquota` is also installed as `cq` and `sq`.

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

Bare `cq` always runs once. Cards fill the available terminal width; short
terminals try more, narrower columns, then fall back to one aligned line per
quota window.

`cq watch` is a full-screen app: provider tabs across the top, an account
sidebar with each account's lowest remaining quota, a detail pane for the
selected account (limits with reset countdowns, then details), and a status
bar. Press `u` to list the soonest upcoming resets across all accounts, and `m`
to manage accounts without leaving the app.
Terminals under 72 columns drop the sidebar. Watch mode uses 24-bit colour;
`--no-color` or `NO_COLOR` renders the same layout without colour.

### Watch controls

| Key | Action |
| --- | --- |
| `q`, Ctrl-C | Quit and restore the terminal |
| `m` | Manage accounts (see below) |
| `r` | Refresh now |
| `u` | Show or hide upcoming resets across all accounts |
| `e` | Toggle email visibility |
| `?` | Toggle help |
| `1` | All providers |
| `2`–`6` | Codex, Claude, Grok, Antigravity, Cursor |
| `j`/`k`, arrows | Select the next/previous account |
| PgUp/PgDn | Jump several accounts |
| `+`/`-` | Increase/decrease refresh interval by 15 seconds |

The default interval is 3 minutes (180 seconds); the minimum is 15. `cq tui` and `cq -w` are
watch aliases. Use `--once` to force one-shot output. Redirected input or output
falls back to a static view. A failed scan preserves the last completed view and
shows a stale marker; individual account failures appear on their own cards.

### Managing accounts in watch mode

`m` opens the account panel, scoped to the current provider tab (all providers on
the All or Cursor tab) with the selected account preselected. Inside it:

| Key | Action |
| --- | --- |
| `a` | Add an account: pick the provider with ←/→, type a label, Enter to sign in |
| `r` | Reauthenticate the selected account |
| `n` | Rename the selected account |
| `d` | Remove the selected account (confirm with `y`) |
| `j`/`k`, arrows | Move the selection |
| Esc, `q`, `m` | Close the panel |

Sign-in runs inside the panel. Your browser opens to the provider's login page and
the panel shows the URL too: Ctrl-Y copies it to the clipboard (OSC 52, where the
terminal allows it) and Ctrl-O reopens the browser. When the provider shows a code
(Claude), or over SSH and without a display, paste the code or redirect URL into the
field and press Enter. Esc cancels; a cancelled sign-in never saves a credential.
The panel manages only shuvquota's own stores; Cursor and harness sessions stay
read-only. Every change triggers a rescan.

When Anthropic rate-limits quota reads, Claude waits at least five minutes (or a
longer `Retry-After`) before another request. The card shows the remaining wait.
Grok quota access can differ between OAuth sessions for the same account. Native
Grok Build sessions in `~/.grok/auth.json` (or `$GROK_HOME/auth.json`) are discovered
read-only. If a managed session gets a Code CLI permission denial, shuvquota can
query another unexpired session with the same verified account ID. It never
refreshes or modifies the native session. The quota card marks that fallback.

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
and removed on the next write. Pre-v2 rows without shuvquota's independent-enrollment
stamp are ignored and dropped on the next write; add those accounts again.

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
ownership policy and environment configuration described above. Pre-v2 rows in
the managed stores are ignored; add those accounts again.

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

### Cursor accounts from T3 Code

Cursor API keys are read from a T3 Code (shuv2code) state directory, set with
`SHUVQUOTA_T3_STATE_DIR=/path/to/t3/userdata` in `~/.shuvquota.env`. Both inline
keys and T3's `provider-env-*.bin` secret references are supported. Every Cursor
instance with a key becomes an account under its T3 display name, whether or not
it is enabled in T3; duplicate keys are fetched once, under the enabled instance's
name. Cursor's API-key session carries no email, so these cards show none. `cq cursor`
shows quota and `cq cursor sources` lists the physical sources. These accounts
are read-only: manage their keys and names in T3 Code, not `cq add` or `reauth`.
They do not use an owned shuvquota credential store.

The adapter exchanges each API key through Cursor's own API-key login endpoint,
then reads the dashboard usage endpoint. It never rotates a harness refresh token,
persists the returned session, or writes T3 configuration. Total usage, Auto, and API
windows use Cursor's reported percentages, with the reported billing-cycle reset.
These endpoints were verified with the installed Cursor CLI's protocol; they are
not a guaranteed public quota API.

`SHUVQUOTA_DISABLED_PROVIDERS=grok` hides a provider from default CLI/dashboard
scans without deleting its credentials. Explicit commands such as `cq grok`
remain available. Multiple provider IDs may be separated by commas.

Cursor's Total usage is its reported bonus-inclusive percentage, not the remaining
purchased allowance.
