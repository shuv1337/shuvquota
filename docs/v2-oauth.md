# Independent OAuth enrollment feasibility

Source verification: 2026-09-18 PDT. Implementation is feasible for all four
providers. **Live enrollment has not been performed** in this migration run.
Fixture tests validate our protocol handling; they do not establish provider
policy approval, client allowlisting, or availability for every subscription.

An independent session is acquired through a new authorization flow, rather
than copying or refreshing a harness's existing session. Existing provider CLI
client identifiers do not imply shuvquota owns the OAuth client registration.

## Codex

Existing `lib/oauth.js` implements authorization-code PKCE with the Codex public
client, `https://auth.openai.com/oauth/authorize` and `/oauth/token`, and
`http://localhost:1455/auth/callback`. Preserve state validation, callback timeout,
and headless URL presentation. Token rotation must be treated conservatively:
refresh only independently enrolled managed credentials and persist the returned
pair atomically. Fixed-port enrollment reports an actionable bind error.

## Claude

Existing `lib/claude-oauth.js` implements authorization-code PKCE using the Claude
Code client and console-hosted redirect/manual code entry. Preserve code/state
validation and the existing scope/endpoint contract. Refresh only independent
managed sessions; all discovered external sessions remain read-only.

## Grok / xAI

Live follow-up: a managed OAuth session received a Code CLI permission denial
from billing while the native Grok Build OIDC session for the same verified user
ID received HTTP200 at the identical endpoint. Treat that denial as session-level
evidence, not proof the account lacks access. The native `auth.json` stores OIDC
records with `key`, `refresh_token`, `expires_at`, and `user_id`; these are now
read-only discovery sources. A valid same-account session can supply quota after
a managed-session permission denial, without copying or refreshing its tokens.
The precise authorization difference between the two issued sessions remains
unverified; this fallback does not establish parity of the enrollment flows.

Local source: `opencode/packages/opencode/src/plugin/xai.ts` and its plugin tests;
device-code alternatives exist in pi/shuvpi `packages/ai/src/auth/oauth/xai.ts`
and Hermes `hermes_cli/auth_xai.py`.

- Authorize: `https://auth.x.ai/oauth2/authorize`
- Token: `https://auth.x.ai/oauth2/token`
- Public client ID: existing `GROK_CLIENT_ID` configuration; no client secret.
- Loopback redirect: `http://127.0.0.1:56121/callback` (pinned by the known client).
- Scopes: `openid profile email offline_access grok-cli:access api:access`.
- PKCE S256, state, nonce, and `plan=generic`.
- Refresh rotates: serialize by credential identity and update all matching
  physical entries inside owned stores, never external stores.

Use loopback PKCE for the initial adapter, consistent with the plan. A new
device-code flow is feasible but not required for this implementation. Source
comments about client allowlisting and tier-specific inference failures are not
live-verified provider policy. Quota enrollment is not a promise of inference
access.

## Antigravity / Google AI Pro

Local source: `shuvcode/packages/antigravity-plugin/src/oauth.ts` and `src/index.ts`,
plus `shuvpi/packages/ai/src/auth/oauth/google-antigravity.ts`.

- Authorize: `https://accounts.google.com/o/oauth2/v2/auth`
- Token: `https://oauth2.googleapis.com/token`
- Redirect: `http://localhost:36742/oauth-callback`
- Client configuration: `ANTIGRAVITY_CLIENT_ID` and
  `ANTIGRAVITY_CLIENT_SECRET`, environment only; no client secret copied in-tree.
- Scopes: Google `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`,
  and `experimentsandconfigs` scopes from the installed-client implementation.
- PKCE S256, `access_type=offline`, `prompt=consent`.
- Resolve the Cloud Code project via `loadCodeAssist` after login.
- Preserve the current refresh token when Google omits a replacement.

Installed-app Google flows can use a client-secret parameter; its presence does
not establish that browser enrollment is unavailable. The configured client must
support the redirect and scopes. The source uses the existing Antigravity CLI
client; we retain the plan's environment-only configuration policy.

## Ownership gate

Source evidence clears implementation of the missing adapters. Any live login
requiring browser interaction remains a separate user-driven validation step.
Legacy imported sessions are not relabeled independent. Their managed location
is insufficient evidence of ownership, so stores ignore unstamped rows and drop
them on the next write; adding the account again is the migration path. The recommended strict external policy remains unchanged:
external access tokens may be used while valid, but are never refreshed.
