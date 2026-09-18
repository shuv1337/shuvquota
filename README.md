# shuvquota

The v1 command surface remains available with `npx shuvquota@1 …` during the v2
migration. The local `v1.1.25-final` tag preserves the pre-migration source.

Multi-provider quota monitor and account manager for OpenAI Codex CLI, Claude Code,
SuperGrok, and Google AI Pro / Antigravity. Add, switch, list, and remove supported accounts
with OAuth browser authentication, and inspect all configured quotas together.

Factory.ai, Synthetic, and OpenCode Go support was removed in v2. Invoking those
namespaces (`shuvquota factory …`, `shuvquota synthetic …`, `shuvquota opencode-go …`)
exits with status 2 and points at `npx shuvquota@1`.

By default, shuvquota now only reads and refreshes credentials from its own managed account files and env vars. Native app auth files from Codex CLI, OpenCode, Claude Code, and pi are no longer imported automatically, which avoids breaking those apps' tokens during refresh. Use `--native` to opt back into the old behavior when needed.

Zero dependencies - uses Node.js built-ins only.

## Installation

```bash
npm install -g shuvquota
```

Or with bun:

```bash
bun add -g shuvquota
```

After installation, both `shuvquota` and `cq` commands are available.

## Quick Start

```bash
# Add a new account (opens browser for OAuth)
shuvquota codex add personal

# Add a Claude credential (interactive)
shuvquota claude add work

# Check quota for all accounts
shuvquota

# Open the installable quota dashboard
shuvquota-server

# Switch active Codex account
shuvquota codex switch personal

# Switch Claude credentials
shuvquota claude switch work

# Sync activeLabel to CLI auth files
shuvquota codex sync
shuvquota claude sync

# Preview sync without writing files
shuvquota codex sync --dry-run
shuvquota claude sync --dry-run

# List accounts
shuvquota codex list
shuvquota claude list

# Remove an account
shuvquota codex remove old-account
shuvquota claude remove old-account
```

## shuvquota PWA

`shuvquota` is the installable, responsive companion app for the same quota data shown by
the CLI. It presents Codex, Claude, SuperGrok, and Antigravity usage in one
fast-scanning view.

```bash
# Starts on http://127.0.0.1:4789
shuvquota

# Equivalent when working from this checkout
bun run app
```

The web app is deliberately read-only. Its API returns a browser-safe snapshot and never
exposes access tokens, refresh tokens, account IDs, credential paths, or raw provider
responses. Quota values are never written to browser storage or the service-worker cache.
The installed shell works offline; current quota values still require a live connection.

Runtime settings are available as environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `SHUVQUOTA_HOST` | `127.0.0.1` | HTTP bind address |
| `SHUVQUOTA_PORT` | `4789` | HTTP port |
| `SHUVQUOTA_ALLOWED_HOSTS` | local hostnames | Comma-separated proxy/public host allowlist |

For a supervised local service from this source checkout, validate and apply its Oxmgr
configuration:

```bash
oxmgr validate ./oxfile.toml
oxmgr apply ./oxfile.toml
oxmgr status shuvquota
```

Keep remote access behind a trusted private network or authenticated HTTPS proxy. The
included server binds to loopback by default.

## Commands

Run `shuvquota` with no namespace to check all configured quota providers.

### codex quota

Check usage quota for Codex accounts.

```bash
shuvquota codex quota            # All Codex accounts
shuvquota codex quota personal   # Specific account
shuvquota codex quota --json     # JSON output
```

### claude quota

Check usage quota for Claude accounts.

```bash
shuvquota claude quota           # All Claude accounts
shuvquota claude quota work      # Specific credential
shuvquota claude quota --json    # JSON output
```

### antigravity quota

Check Google AI Pro / Antigravity Gemini 5-hour and weekly remaining quota, plus
unused Claude/GPT buckets. The quota request itself does not consume generate quota.

```bash
shuvquota antigravity
shuvquota antigravity quota --compact
shuvquota antigravity quota --json
```

Credentials are discovered from `ANTIGRAVITY_REFRESH` / `ANTIGRAVITY_ACCOUNTS`,
`~/.local/share/opencode/antigravity-accounts.json`, or the shuvcode `google-ai-pro`
OAuth credential. Token refresh stays in memory and is not written back.
Set `ANTIGRAVITY_CLIENT_ID` and `ANTIGRAVITY_CLIENT_SECRET` in `~/.shuvquota.env`
so expired access tokens can refresh.

### codex add

Add a new Codex account via OAuth browser authentication.

```bash
shuvquota codex add                # Label derived from email
shuvquota codex add work           # With explicit label
shuvquota codex add --no-browser   # Print URL (for SSH/headless)
```

### claude add

Add a Claude credential interactively.

```bash
shuvquota claude add               # Prompt for label + credentials
shuvquota claude add work          # With explicit label
shuvquota claude add work --json   # JSON output
```

### codex switch

Switch the active account for Codex CLI, OpenCode, and pi.

```bash
shuvquota codex switch personal
```

When you run `codex switch`:

1. **Codex CLI** - Updates `~/.codex/auth.json` with the selected account tokens
2. **OpenCode** - If `~/.local/share/opencode/auth.json` exists, updates the `openai` provider entry
3. **pi** - If `~/.pi/agent/auth.json` exists, updates the `openai-codex` provider entry

It also updates `activeLabel` in `~/.codex-accounts.json` when available.

### claude switch

Switch Claude Code, OpenCode, and pi to a stored Claude credential.

```bash
shuvquota claude switch work
```

This updates `activeLabel` in `~/.claude-accounts.json` when available. OAuth-based
credentials are required to update CLI auth files.

### codex list

List all Codex accounts from shuvquota-managed sources with status indicators.

```bash
shuvquota codex list
shuvquota codex list --json
```

Output shows:
- `*` = active account (from `activeLabel`)
- `~` = CLI auth account when it diverges from `activeLabel`
- Email, plan type, token expiry
- Source file for each account

If CLI auth diverges from the tracked `activeLabel`, `list` and `quota` print a warning and
suggest `shuvquota codex sync` to realign when `--native` is used.

### claude list

List Claude credentials from `CLAUDE_ACCOUNTS` or `~/.claude-accounts.json`.
By default this excludes native Claude Code / OpenCode auth files unless `--native` is used.

```bash
shuvquota claude list
shuvquota claude list --json
```

Output shows:
- `*` = active account (from `activeLabel`)
- Source file for each credential

For OAuth-based accounts, `list` and `quota` warn when stored tokens diverge from the
`activeLabel` account when `--native` is used. Session-key-only accounts are skipped.

### codex remove

Remove a Codex account from storage.

```bash
shuvquota codex remove old-account
```

Note: Accounts from `CODEX_ACCOUNTS` env var cannot be removed via CLI.

### claude remove

Remove a Claude credential from storage.

```bash
shuvquota claude remove old-account
```

Note: Accounts from `CLAUDE_ACCOUNTS` env var cannot be removed via CLI.

### codex sync

Sync the `activeLabel` Codex account to CLI auth files.

```bash
shuvquota codex sync
shuvquota codex sync --dry-run
shuvquota codex sync --json
```

This updates:
1. `~/.codex/auth.json`
2. `~/.local/share/opencode/auth.json` (if it exists)
3. `~/.pi/agent/auth.json` (if it exists)

Note: `sync` still writes native app auth files. What changed is the default read/import behavior for `list`/`quota` and other passive checks.

### claude sync

Sync the `activeLabel` Claude account to CLI auth files.

```bash
shuvquota claude sync
shuvquota claude sync --dry-run
shuvquota claude sync --json
```

Only OAuth-based Claude accounts can be synced. Session-key-only accounts are skipped with
a warning.

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output in JSON format |
| `--local` | Use only shuvquota-managed files; skip native app auth checks (default) |
| `--native` | Include native app auth files in reads/checks for list/quota/divergence |
| `--dry-run` | Preview sync without writing files |
| `--no-browser` | Print auth URL instead of opening browser |
| `--no-color` | Disable colored output |
| `--version, -v` | Show version number |
| `--help, -h` | Show help |

## Account Sources

Accounts are loaded from these locations (in order). Read/write indicates whether the CLI
reads from or writes to each path.

| Source | Purpose | Read | Write |
|--------|---------|------|-------|
| `CODEX_ACCOUNTS` env var | JSON array of accounts | Yes | No |
| `~/.codex-accounts.json` | Primary multi-account file (shared with OpenCode) | Yes | Yes (`add`, `remove`) |
| `~/.opencode/openai-codex-auth-accounts.json` | OpenCode accounts | Yes | No |
| `~/.codex/auth.json` | Codex CLI single-account fallback (`--native` only, label `codex-cli`) | Yes | Yes (`switch`, `sync`) |
| `~/.local/share/opencode/auth.json` | OpenCode auth file (`openai` provider) | No | Yes (`switch`, `sync` if it exists) |
| `~/.pi/agent/auth.json` | pi auth file (`openai-codex` provider) | No | Yes (`switch`, `sync` if it exists) |

New accounts added via `shuvquota codex add` are saved to `~/.codex-accounts.json`, which is
shared with OpenCode.

Claude sources (in order):

| Source | Purpose | Read | Write |
|--------|---------|------|-------|
| `CLAUDE_ACCOUNTS` env var | JSON array of credentials | Yes | No |
| `~/.claude-accounts.json` | Claude multi-account file | Yes | Yes (`add`, `remove`) |
| `~/.claude/.credentials.json` | Claude Code credentials (`--native` only) | Yes | Yes (`switch`, `sync`) |
| `~/.local/share/opencode/auth.json` | OpenCode auth file (`anthropic` provider) | No | Yes (`switch`, `sync` if it exists) |
| `~/.pi/agent/auth.json` | pi auth file (`anthropic` provider) | No | Yes (`switch`, `sync` if it exists) |

Antigravity sources (in order):

| Source | Purpose | Read | Write |
|--------|---------|------|-------|
| `ANTIGRAVITY_REFRESH` env var | Single Google AI Pro refresh token | Yes | No |
| `ANTIGRAVITY_ACCOUNTS` env var | JSON array of labeled OAuth credentials | Yes | No |
| `~/.local/share/opencode/antigravity-accounts.json` | V1 Antigravity accounts file | Yes | No |
| `~/.local/share/opencode/opencode.db` | shuvcode `google-ai-pro` OAuth | Yes | No |

## Multi-Account JSON Schema

File: `~/.codex-accounts.json`

```json
{
  "schemaVersion": 1,
  "activeLabel": "personal",
  "accounts": [
    {
      "label": "personal",
      "accountId": "chatgpt-account-uuid",
      "access": "access-token",
      "refresh": "refresh-token",
      "idToken": "id-token-or-null",
      "expires": 1234567890000
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | number | Schema version marker (root field) |
| `activeLabel` | string\|null | Active account label (root field) |
| `label` | string | Unique identifier for the account |
| `accountId` | string | ChatGPT account UUID |
| `access` | string | OAuth access token |
| `refresh` | string | OAuth refresh token |
| `idToken` | string\|null | OAuth ID token (optional, for email extraction) |
| `expires` | number | Token expiry timestamp in milliseconds |

Root-level fields are preserved on write; unknown root fields are kept intact.

Claude multi-account files (`~/.claude-accounts.json`) use the same root fields
(`schemaVersion`, `activeLabel`) and store account entries that include a
`sessionKey` or OAuth tokens.

## OAuth Flow

The `codex add` command uses OAuth 2.0 with PKCE for secure browser authentication:

1. Generates PKCE code verifier and challenge
2. Starts local callback server on `http://127.0.0.1:1455`
3. Opens browser to OpenAI authorization page
4. User authenticates in browser
5. Callback server receives authorization code
6. Exchanges code for tokens using PKCE verifier
7. Saves tokens to `~/.codex-accounts.json`

### Headless/SSH Mode

In SSH sessions or headless environments (detected via `SSH_CLIENT`, `SSH_TTY`, or missing `DISPLAY`), the auth URL is printed instead of opening a browser:

```bash
shuvquota codex add --no-browser
# Prints: Open this URL in your browser: https://auth.openai.com/authorize?...
```

Copy the URL to a browser on another machine, complete authentication, and the callback will be received by the local server.

## Troubleshooting

### Port 1455 in use

```
Error: Port 1455 is in use. Close other shuvquota instances and retry.
```

Another process is using port 1455. Check for:
- Other `shuvquota codex add` commands running
- OpenCode or Codex CLI auth processes

Find and kill the process:
```bash
lsof -i :1455
kill <pid>
```

### SSH/Headless authentication

If browser doesn't open in SSH session:

1. Use `--no-browser` flag: `shuvquota codex add --no-browser`
2. Copy the printed URL to a browser on another machine
3. Complete authentication in browser
4. The callback is received by the server running over SSH

### Token refresh failures

If token refresh fails:
```
Error: Failed to refresh token. Re-authenticate with 'shuvquota codex add'.
```

The refresh token may have expired. Add the account again:
```bash
shuvquota codex remove expired-account
shuvquota codex add new-label
```

### Environment variable accounts

Accounts from `CODEX_ACCOUNTS` env var cannot be removed via CLI:
```
Error: Cannot remove account from CODEX_ACCOUNTS env var. Modify the env var directly.
```

Edit your shell configuration to remove the account from the env var.

## JSON Output

All commands support `--json` for scripting:

```bash
# Quota (combined)
shuvquota --json
# {"codex":[...],"claude":[...],"grok":[...],"antigravity":[...],"divergence":{...}}

# List (Codex)
shuvquota codex list --json
# {"accounts":[{"label":"personal","isActive":true,"email":"...","source":"..."}]}

# Add (Codex, success)
shuvquota codex add work --json
# {"success":true,"label":"work","email":"user@example.com","accountId":"...","source":"~/.codex-accounts.json"}

# Switch (Codex)
shuvquota codex switch personal --json
# {"success":true,"label":"personal","email":"...","authPath":"~/.codex/auth.json"}

# Sync (Codex)
shuvquota codex sync --json
# {"success":true,"activeLabel":"work","updated":["~/.codex/auth.json",...],"skipped":[...]}

# Errors include structured data
shuvquota codex switch nonexistent --json
# {"success":false,"error":"Account not found","availableLabels":["personal","work"]}
```

## Claude Code Usage (Optional)

Use the `claude` namespace to check Claude usage alongside OpenAI quotas:

```bash
shuvquota claude quota
```

If multiple Claude accounts are configured, each account is fetched and displayed separately.

To add a Claude credential interactively:

```bash
shuvquota claude add
```

This uses your local Claude session to call:
- `https://claude.ai/api/organizations`
- `https://claude.ai/api/organizations/{orgId}/usage`
- `https://claude.ai/api/organizations/{orgId}/overage_spend_limit`
- `https://claude.ai/api/account`

Authentication sources (in order):
1. `CLAUDE_ACCOUNTS` env var (JSON array or `{ accounts: [...] }`)
2. `~/.claude-accounts.json` (multi-account format)
3. Browser cookies (Chromium/Chrome) to read `sessionKey` and `lastActiveOrg`
4. `~/.claude/.credentials.json` OAuth `accessToken`

Multi-account format (Claude):
```json
{
  "accounts": [
    {
      "label": "personal",
      "sessionKey": "sk-ant-oat...",
      "cfClearance": "cf_clearance...",
      "oauthToken": "claude-ai-access-token",
      "orgId": "org_uuid_optional"
    }
  ]
}
```

Notes:
- Only `label` plus one of `sessionKey` or `oauthToken` is required.
- `cfClearance`, `orgId`, and `cookies` are optional.

Environment overrides:
- `CLAUDE_ACCOUNTS` to supply multi-account JSON directly
- `CLAUDE_CREDENTIALS_PATH` to point to a different credentials file
- `CLAUDE_COOKIE_DB_PATH` to point to a specific Chromium/Chrome Cookies DB

Codex overrides:
- `CODEX_ACCOUNTS` to supply multi-account JSON directly (read-only)
- `CODEX_AUTH_PATH` to point to a different Codex CLI auth file
- `XDG_DATA_HOME` to relocate OpenCode auth paths
- `PI_AUTH_PATH` to point to a different pi auth file

Antigravity overrides:
- `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` for in-memory token refresh
- `ANTIGRAVITY_REFRESH` / `ANTIGRAVITY_ACCESS` to supply one Google AI Pro OAuth session
- `ANTIGRAVITY_ACCOUNTS` to supply labeled OAuth credentials as JSON
- `ANTIGRAVITY_PROJECT` to set the Cloud Code project id
- `ANTIGRAVITY_INTEGRATION_DB_PATH` to point to a different shuvcode database
- `ANTIGRAVITY_V1_ACCOUNTS_PATH` to point to a different V1 accounts file

Notes:
- On Linux, cookie access requires `sqlite3` and `secret-tool` (libsecret) to decrypt cookies.
- For best results, keep `claude.ai` logged in within your Chromium/Chrome profile.

## Releasing

- Run `bun test` and `bun run preflight` before publishing.
- Bump version with `bun pm version patch|minor|major`.
- Dry-run the package with `bun run release:pack`.
- Publish with `bun run release:publish` (local publish, no provenance).
- Ensure the git working tree is clean.

## License

MIT
