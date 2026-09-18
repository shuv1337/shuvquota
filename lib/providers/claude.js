/**
 * Claude (Anthropic OAuth) provider adapter.
 * Depends on: lib/claude-accounts.js, lib/claude-tokens.js, lib/claude-usage.js,
 * lib/token-match.js, lib/providers/_util.js
 *
 * Managed rows use the Claude field aliases (oauthToken / oauthRefreshToken /
 * oauthExpiresAt). Claude Code, OpenCode, and env credentials are read-only:
 * an expired one is reported, never rotated. Claude has no account id, so
 * identity is the refresh token (constant across rotations); sources expose
 * only a fingerprint of it.
 */

import { CLAUDE_MULTI_ACCOUNT_PATHS } from "../constants.js";
import { loadClaudeAccountsFromEnv, loadClaudeAccountsFromFile } from "../claude-accounts.js";
import { refreshClaudeToken, isClaudeOauthTokenExpiring } from "../claude-tokens.js";
import { loadClaudeOAuthFromClaudeCode, loadClaudeOAuthFromOpenCode, loadClaudeOAuthFromEnv, fetchClaudeOAuthUsage } from "../claude-usage.js";
import { getManagedStorePath } from "../credential-store.js";
import { CLAUDE_TOKEN_FIELDS } from "../token-match.js";
import { normalizeClaudeAccount } from "../snapshot.js";
import { defineProvider, numberValue, tokenFingerprint } from "./_util.js";

/** Rows from claude-usage.js loaders (accessToken/refreshToken/expiresAt). */
function fromOauthRow(raw, kind) {
	return {
		label: raw.label, kind, source: raw.source, access: raw.accessToken ?? null,
		refresh: raw.refreshToken ?? null, expires: numberValue(raw.expiresAt),
		subscriptionType: raw.subscriptionType ?? null, rateLimitTier: raw.rateLimitTier ?? null,
		planOverride: raw.planOverride ?? null,
	};
}

/** Rows from claude-accounts.js loaders (oauthToken/oauthRefreshToken/oauthExpiresAt). */
function fromStoreRow(raw, kind, source) {
	return {
		label: raw.label, kind, source, access: raw.oauthToken ?? null,
		refresh: raw.oauthRefreshToken ?? null, expires: numberValue(raw.oauthExpiresAt),
		subscriptionType: raw.subscriptionType ?? null, rateLimitTier: raw.rateLimitTier ?? null,
		planOverride: raw.planOverride ?? null,
	};
}

/** Every env/harness Claude credential, one row per physical location. */
function loadExternal(opts) {
	const managedPath = getManagedStorePath("claude", opts);
	const out = [
		...loadClaudeOAuthFromEnv().map(raw => fromOauthRow(raw, "env")),
		...loadClaudeAccountsFromEnv().map(raw => fromStoreRow(raw, "env", "env:CLAUDE_ACCOUNTS")),
	];
	for (const path of CLAUDE_MULTI_ACCOUNT_PATHS) {
		if (path === managedPath) continue;
		out.push(...loadClaudeAccountsFromFile(path).map(raw => fromStoreRow(raw, "harness", path)));
	}
	out.push(...loadClaudeOAuthFromClaudeCode().map(raw => fromOauthRow(raw, "harness")));
	out.push(...loadClaudeOAuthFromOpenCode().map(raw => fromOauthRow(raw, "harness")));
	return out;
}

/** @param {object} [deps] - Test injection seam; see _util.js `defineProvider`. */
export function createClaudeProvider(deps = {}) {
	return defineProvider({
		id: "claude",
		name: "Claude",
		fieldMap: CLAUDE_TOKEN_FIELDS,
		normalizeSnapshot: normalizeClaudeAccount,
		identityOf: account => account.refresh ?? account.access ?? null,
		identityKeyOf: account => tokenFingerprint(account.refresh ?? account.access),
		fromManaged: (base, raw) => ({
			...base,
			email: raw.email ?? null,
			subscriptionType: raw.subscriptionType ?? null,
			rateLimitTier: raw.rateLimitTier ?? null,
			planOverride: raw.planOverride ?? null,
		}),
		external: loadExternal,
		isExpiring: tokens => isClaudeOauthTokenExpiring(numberValue(tokens.expires)),
		refresh: async tokens => {
			const refreshed = await refreshClaudeToken(tokens.refresh);
			if (!refreshed?.accessToken) return null;
			return {
				access: refreshed.accessToken,
				refresh: refreshed.refreshToken ?? tokens.refresh,
				expires: Date.now() + refreshed.expiresIn * 1000,
			};
		},
		fetchUsage: async account => {
			const result = await fetchClaudeOAuthUsage(account.access);
			return result.success ? { usage: result.data } : { error: result.error ?? "Claude usage unavailable" };
		},
	}, deps);
}

export const claude = createClaudeProvider();
