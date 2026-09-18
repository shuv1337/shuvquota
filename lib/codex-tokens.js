/**
 * OpenAI token refresh.
 * Depends on: lib/constants.js
 *
 * A pure HTTP exchange plus an expiry predicate. The v1 fan-out writers that
 * pushed rotated tokens into Codex CLI, OpenCode, pi, and the legacy
 * multi-account stores are gone: harness credentials are read-only, and owned
 * rows are persisted by lib/credential-store.js.
 */

import { TOKEN_URL, CLIENT_ID, OPENAI_OAUTH_REFRESH_BUFFER_MS } from "./constants.js";

/**
 * Exchange a refresh token for a fresh OpenAI OAuth token set.
 * @param {string} refreshTokenValue
 * @returns {Promise<{ access: string, refresh: string, expires: number } | null>}
 */
export async function refreshToken(refreshTokenValue) {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshTokenValue,
			client_id: CLIENT_ID,
		}),
	});
	if (!res.ok) return null;
	const json = await res.json();
	if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
		return null;
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

/**
 * @param {number | null | undefined} expires
 * @returns {boolean}
 */
export function isOpenAiOauthTokenExpiring(expires) {
	if (!expires) return true;
	return expires <= Date.now() + OPENAI_OAUTH_REFRESH_BUFFER_MS;
}
