/**
 * SuperGrok / xAI OAuth token refresh.
 * Depends on: lib/constants.js, lib/jwt.js
 *
 * A pure HTTP exchange, an expiry predicate, and shared-session detection.
 * xAI rotates refresh tokens, so the v1 fan-out that rewrote every pi,
 * OpenCode, and Hermes store holding the previous refresh is gone: those are
 * read-only harness credentials. `sourceMatchesRotatedTokens` remains so the
 * owner of a credential can tell which rows are the *same* session and
 * refuse to rotate a copy it does not own.
 */

import {
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_TOKEN_URL,
	XAI_OAUTH_REFRESH_BUFFER_MS,
	GROK_TIMEOUT_MS,
} from "./constants.js";
import { decodeJWT } from "./jwt.js";

/**
 * @param {string | null | undefined} accessToken
 * @param {number | null | undefined} expiresAt
 * @param {number} [bufferMs]
 * @returns {boolean}
 */
export function isGrokTokenExpiring(accessToken, expiresAt, bufferMs = XAI_OAUTH_REFRESH_BUFFER_MS) {
	if (typeof expiresAt === "number" && expiresAt > 0) {
		return expiresAt <= Date.now() + bufferMs;
	}
	if (!accessToken) return true;
	const payload = decodeJWT(accessToken);
	if (!payload?.exp) return true;
	return payload.exp * 1000 <= Date.now() + bufferMs;
}

/**
 * Refresh an xAI SuperGrok OAuth access token.
 * @param {string} refreshToken
 * @param {{ tokenEndpoint?: string | null, fetchFn?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ access_token: string, refresh_token: string, expires_in: number } | { error: string }>}
 */
export async function refreshGrokToken(refreshToken, options = {}) {
	if (!refreshToken) {
		return { error: "No refresh token available" };
	}

	const fetchFn = options.fetchFn ?? fetch;
	const tokenEndpoint = (typeof options.tokenEndpoint === "string" && options.tokenEndpoint.trim())
		? options.tokenEndpoint.trim()
		: XAI_OAUTH_TOKEN_URL;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? GROK_TIMEOUT_MS);

	try {
		const res = await fetchFn(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: XAI_OAUTH_CLIENT_ID,
				refresh_token: refreshToken,
			}),
			signal: controller.signal,
		});

		const text = await res.text();
		if (!res.ok) {
			return {
				error: `Token refresh failed: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
			};
		}

		let body;
		try {
			body = JSON.parse(text);
		} catch {
			return { error: "Token refresh failed: invalid JSON response" };
		}

		if (!body?.access_token) {
			return { error: "Token refresh failed: missing access_token in response" };
		}

		return {
			access_token: body.access_token,
			// xAI rotates refresh tokens — always prefer the new one when present
			refresh_token: body.refresh_token ?? refreshToken,
			expires_in: Number(body.expires_in ?? 21600),
		};
	} catch (e) {
		const message = e?.name === "AbortError" ? "Token refresh timed out" : (e?.message ?? String(e));
		return { error: message };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Whether two credential locations hold the same xAI session.
 * Prefer an exact previous-refresh match so independently rotated sessions are
 * never conflated. Fall back to previous-access only when either side lacks a
 * refresh token.
 * @param {{ previousAccess?: string | null, previousRefresh?: string | null }} source
 * @param {{ previousAccess?: string | null, previousRefresh?: string | null }} used
 * @returns {boolean}
 */
export function sourceMatchesRotatedTokens(source, used) {
	if (used.previousRefresh && source.previousRefresh) {
		return source.previousRefresh === used.previousRefresh;
	}
	if (used.previousAccess && source.previousAccess && source.previousAccess === used.previousAccess) {
		return true;
	}
	return false;
}
