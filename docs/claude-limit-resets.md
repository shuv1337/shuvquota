# Claude limit resets: read-only source evidence

## Source

Verified against Claude Code **2.1.319** and a live OAuth account on
**November 9, 2026 (PST)**.

- Ordinary `GET https://api.anthropic.com/api/oauth/usage` returned
  `cedar_ember: null`. The weekly limits alone do not expose held resets.
- Claude Code's installed bundle has a distinct status read:
  `GET /api/oauth/usage?cedar_ember=1&skip_spend=1`.
  Its `ne` path selector calls this the `cedar_ember` read;
  `re` uses `jt.get`; `m6n` reads `response.cedar_ember`.
- The usage HTTP client supplies the User-Agent
  `claude-cli/2.1.319 (external, cli)`. Without it (including with the
  unrelated `claude-code/2.1.319` profile-client User-Agent), the server
  returned HTTP 200 with `eligible: false`, `ineligible_reason: "surface"`.
- The same existing OAuth access token, with that usage-client User-Agent,
  returned HTTP 200 and four grants. shuvquota appends its own name to the
  compatibility User-Agent; the live CLI check confirmed that also works.
  This version string is a protocol compatibility hint, not a dependency on
  a locally installed Claude executable. The identity string lives in
  `lib/constants.js`; a lazy, process-cached `claude --version` probe uses
  `node:child_process.execFile` without a shell, with a 1.5-second timeout.
  Missing, malformed, older, or timed-out versions fall back to **2.1.319**;
  newer installed versions raise the User-Agent version. Failures are cached too.
  A blank reset section may mean the **User-Agent is out of date**, not that
  the account has no grants.
- `claude --help` exposes no non-interactive quota/status command. `--print`
  runs a model prompt, so it was not used for discovery.

The GET uses the existing OAuth bearer, `anthropic-version: 2023-06-01`, and
`anthropic-beta: oauth-2025-04-20`. No browser cookies or new credentials are needed.

## Fields and safety

`cedar_ember.eligible` gates the optional display. Each element of
`cedar_ember.grants` has:

- `resets_left`: remaining count (not the original `resets_total`).
- `ends_at`: expiry; `starts_at`: beginning of availability.
- `gives_back_weekly`: identifies a Fable reset, even when `type` is `full`.
- `type`: otherwise `session`, `weekly`, or `full`; older grants can be
  classified from `clears` (`five_hour` versus weekly limits).
- `paused`: paused grants are not counted as available.

Spent, expired, future, or malformed grants are omitted. A held reset may have
`usable_now: false` because it requires hitting a limit; that does **not** mean
it has been spent. Missing expiry remains unknown rather than inventing a date.
Groups preserve distinct expiry dates even when their types match.

**Read-only proof:** the installed client separates this GET status read from
its redemption function, which uses a POST to
`/api/organizations/{organization}/reset_rate_limits` with a program, grant
identifier, and request identifier. That route was **never called** during this
work, and no redemption function or action is implemented in shuvquota.
All live probes used GET; the final live CLI check rejected any non-GET fetch.
No external credential was refreshed or written.

## Implementation

- `lib/claude-usage.js`: fetch ordinary usage first, then optionally enrich only
  `cedar_ember`. The spend-skipping response never replaces normal limits or
  spend. Skip the extra request if usage already contains the block or failed.
  Optional HTTP/network/JSON failures leave normal usage intact. Reset reads
  have a five-second timeout and cache successful responses for 15 minutes in
  memory, keyed by a SHA-256 token hash (never the raw token). Reset 429s pause
  optional reads for at least five minutes, honoring longer Retry-After values;
  primary usage cooldowns also suppress reset reads. Expired cached grants are
  filtered during normalization.
- `lib/claude-limit-resets.js`: pure grouping and constructive projection;
  provider grant identifiers, labels, and telemetry never reach output.
- Snapshot extras contain a total and one entry per type/expiry group. Group
  entries include `reset: { type, count, expiresAt }` in both local and public
  JSON, alongside the existing `id`, `label`, and `value` fields. `expiresAt`
  is an ISO instant or null. Existing extras are unchanged.
- Display helpers format expiry at presentation time, honoring the terminal
  renderer's time zone (Pacific by default). Compact output includes year,
  clock, and zone; the TUI uses short dates to fit the detail pane.
- Credential ownership and refresh policy are unchanged. Both the v2 provider
  and the legacy read-only account helper use enrichment.

## Validation

The fixture in `test/fixtures/claude-limit-resets.json` records the observed
response shape and quota fields, with synthetic grant IDs/labels and telemetry
removed. It contains no tokens or account identifiers.

Tests cover GET-only enrichment, bearer isolation, optional failures, preservation
of spend, inline response support, type/expiry grouping, malformed/spent/paused
and future grants, privacy projection, JSON, compact/static/watch rendering,
time zones, and the real provider pipeline with isolated fixture credentials.

- Full `bun test`: **765 passed, 0 failed**.
- `bun run release:pack`: passed; `lib/` and `web/` remain packaged.
- `git diff --check`: passed.
- `bun run preflight`: passed on the clean committed tree. Before committing,
  only the expected uncommitted-work check failed; metadata/files passed.

Live worktree CLI output (`claude work --compact --no-color`, GET-only guard):

```text
Claude · work
  Weekly: 92% left, resets 09:59 Sun
  Fable weekly: 98% left, resets 09:59 Sun
  Limit resets: 4
  Fable resets: 3 · expire Mar 8, 2027, 11:59 PM PST
  Weekly reset: 1 · expires Dec 15, 2026, 8:59 PM PST
```

The current account usage differs from the earlier screenshot; the banked
counts and expiries match it. No reset was consumed.
