/**
 * Claude token refresh.
 * Depends on: lib/constants.js
 *
 * A pure HTTP exchange plus an expiry predicate. The v1 fan-out writers that
 * pushed rotated tokens into Claude Code credentials, OpenCode, pi, and the
 * legacy multi-account stores are gone: harness credentials are read-only, and
 * owned rows are persisted by lib/credential-store.js.
 */

import {
	CLAUDE_OAUTH_TOKEN_URL,
	CLAUDE_OAUTH_CLIENT_ID,
	CLAUDE_OAUTH_REFRESH_BUFFER_MS,
	OAUTH_TIMEOUT_MS,
} from "./constants.js";

/**
 * Exchange a refresh token for a fresh Claude OAuth token set.
 * @param {string} refreshTokenValue
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>}
 */
export async function refreshClaudeToken(refreshTokenValue) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);

	try {
		const body = {
			grant_type: "refresh_token",
			refresh_token: refreshTokenValue,
			client_id: CLAUDE_OAUTH_CLIENT_ID,
		};

		const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Token refresh failed: ${response.status} ${text}`);
		}

		const data = await response.json();

		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token || refreshTokenValue,
			expiresIn: data.expires_in || 3600,
		};
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * @param {number | null | undefined} expiresAt
 * @returns {boolean}
 */
export function isClaudeOauthTokenExpiring(expiresAt) {
	if (!expiresAt) return false;
	return expiresAt <= Date.now() + CLAUDE_OAUTH_REFRESH_BUFFER_MS;
}
