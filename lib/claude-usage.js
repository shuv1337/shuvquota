/**
 * Claude OAuth usage API fetch and result deduplication.
 * Depends on: lib/constants.js, lib/paths.js, lib/claude-accounts.js
 *
 * OAuth only. The v1 browser-cookie path — Chrome safe-storage decryption, the
 * sqlite3 cookie dump, `sk-ant-` session keys, and the cookie/bearer fallback
 * ladder against the web API — is gone. Harness OAuth tokens are read-only:
 * an expired one is reported as needing re-enrollment, never refreshed here.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
	CLAUDE_CREDENTIALS_PATH,
	CLAUDE_MULTI_ACCOUNT_PATHS,
	CLAUDE_TIMEOUT_MS,
	CLAUDE_OAUTH_USAGE_URL,
	CLAUDE_OAUTH_VERSION,
	CLAUDE_OAUTH_BETA,
} from "./constants.js";
import { getOpencodeAuthPath } from "./paths.js";
import { loadClaudeAccountsFromFile } from "./claude-accounts.js";

/**
 * Read the Claude Code OAuth credential, if it can reach the usage API.
 * @returns {object[]}
 */
export function loadClaudeOAuthFromClaudeCode() {
	const credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || CLAUDE_CREDENTIALS_PATH;
	if (!existsSync(credentialsPath)) return [];

	try {
		const raw = readFileSync(credentialsPath, "utf-8");
		const parsed = JSON.parse(raw);
		const oauth = parsed?.claudeAiOauth ?? parsed?.claude_ai_oauth;

		if (!oauth?.accessToken) return [];

		// Check if token has user:profile scope (required for usage API)
		const scopes = oauth.scopes ?? [];
		if (!scopes.includes("user:profile")) {
			return [];
		}

		return [{
			label: "claude-code",
			accessToken: oauth.accessToken,
			refreshToken: oauth.refreshToken,
			expiresAt: oauth.expiresAt,
			subscriptionType: oauth.subscriptionType,
			rateLimitTier: oauth.rateLimitTier,
			scopes,
			source: credentialsPath,
		}];
	} catch {
		return [];
	}
}

/**
 * Load Claude OAuth account from OpenCode auth.json
 * @returns {Array<{ label: string, accessToken: string, refreshToken?: string, expiresAt?: number, source: string }>}
 */
export function loadClaudeOAuthFromOpenCode() {
	const authPath = getOpencodeAuthPath();
	if (!existsSync(authPath)) return [];

	try {
		const raw = readFileSync(authPath, "utf-8");
		const parsed = JSON.parse(raw);
		const anthropic = parsed?.anthropic;

		if (!anthropic?.access) return [];

		return [{
			label: "opencode",
			accessToken: anthropic.access,
			refreshToken: anthropic.refresh,
			expiresAt: anthropic.expires,
			source: authPath,
		}];
	} catch {
		return [];
	}
}

/**
 * Load Claude OAuth accounts from environment variable
 * Format: JSON array with { label, accessToken, refreshToken?, ... }
 * @returns {Array<{ label: string, accessToken: string, ... }>}
 */
export function loadClaudeOAuthFromEnv() {
	const envAccounts = process.env.CLAUDE_OAUTH_ACCOUNTS;
	if (!envAccounts) return [];

	try {
		const parsed = JSON.parse(envAccounts);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.filter(a => a?.label && a?.accessToken)
			.map(a => ({ ...a, source: "env:CLAUDE_OAUTH_ACCOUNTS" }));
	} catch {
		return [];
	}
}

/**
 * Deduplicate Claude OAuth accounts by refresh token
 * This handles the case where the same Claude account is sourced from multiple files
 * (e.g., claude-code and opencode both storing the same credentials)
 *
 * We use refreshToken because:
 * - Access tokens change on refresh, but refresh tokens stay constant
 * - Two entries with same refresh token are the same underlying account
 * @param {Array<{accessToken: string, refreshToken?: string, ...}>} accounts - Array of accounts
 * @returns {Array<{accessToken: string, ...}>} Deduplicated accounts
 */
export function deduplicateClaudeOAuthAccounts(accounts) {
	const seenTokens = new Set();
	return accounts.filter(account => {
		if (!account.accessToken) return true; // Keep accounts without token (shouldn't happen)
		// Use refresh token if available (stays constant), otherwise fall back to access token
		const tokenKey = account.refreshToken
			? account.refreshToken.substring(0, 50)
			: account.accessToken.substring(0, 50);
		if (seenTokens.has(tokenKey)) return false;
		seenTokens.add(tokenKey);
		return true;
	});
}

/**
 * Fingerprint a usage payload by utilization values only.
 * Reset times are excluded since they differ by milliseconds between calls.
 * @param {object | null} usage
 * @returns {string}
 */
export function buildClaudeUsageFingerprint(usage) {
	if (!usage || typeof usage !== "object") return "null";

	const legacyParts = [
		usage.five_hour?.utilization ?? "null",
		usage.seven_day?.utilization ?? "null",
		usage.seven_day_opus?.utilization ?? "null",
		usage.seven_day_sonnet?.utilization ?? "null",
		usage.seven_day_fable?.utilization ?? "null",
	];

	const limits = Array.isArray(usage.limits)
		? usage.limits.map(limit => {
			const model = limit?.scope?.model;
			const modelName = typeof model === "string"
				? model
				: model?.display_name ?? model?.displayName ?? model?.name ?? model?.id ?? "";
			const surface = limit?.scope?.surface;
			const surfaceName = typeof surface === "string"
				? surface
				: surface?.display_name ?? surface?.displayName ?? surface?.name ?? surface?.id ?? "";
			const percent = limit?.percent ?? limit?.utilization ?? limit?.used_percent ?? "null";
			return [limit?.kind ?? "", limit?.group ?? "", modelName, surfaceName, percent].join(":");
		}).sort()
		: [];

	return `${legacyParts.join("|")}|limits=${limits.join(";")}`;
}

/**
 * Drop results that describe the same account reached through different tokens.
 * @param {Array<{success?: boolean, usage?: object}>} results
 * @returns {Array<object>}
 */
export function deduplicateClaudeResultsByUsage(results) {
	const seen = new Set();
	return results.filter(result => {
		if (!result.success || !result.usage) return true; // Keep errors/failures

		const fingerprint = buildClaudeUsageFingerprint(result.usage);

		if (seen.has(fingerprint)) return false;
		seen.add(fingerprint);
		return true;
	});
}

/**
 * Load all Claude OAuth accounts from all sources
 * Sources (in priority order):
 *   1. CLAUDE_OAUTH_ACCOUNTS env var
 *   2. ~/.claude-accounts.json (accounts with oauthToken field)
 *   3. ~/.claude/.credentials.json (Claude Code)       [skipped when local=true]
 *   4. ~/.local/share/opencode/auth.json (OpenCode)    [skipped when local=true]
 * Deduplicates by accessToken to prevent showing same account twice
 * @param {{ local?: boolean }} [options] - When local=true, skip harness auth files
 * @returns {Array<{ label: string, accessToken: string, refreshToken?: string, expiresAt?: number, subscriptionType?: string, rateLimitTier?: string, source: string }>}
 */
export function loadAllClaudeOAuthAccounts(options = {}) {
	const all = [];
	const seenLabels = new Set();

	// 1. Environment variable
	for (const account of loadClaudeOAuthFromEnv()) {
		if (!seenLabels.has(account.label)) {
			seenLabels.add(account.label);
			all.push(account);
		}
	}

	// 2. Multi-account file (accounts with oauthToken)
	// When SKU fields are missing, backfill from Claude Code credentials if the
	// refresh/access token matches (common after oauth import without plan metadata).
	const credentialSkuByRefresh = new Map();
	const credentialSkuByAccess = new Map();
	for (const cred of loadClaudeOAuthFromClaudeCode()) {
		if (cred.refreshToken) {
			credentialSkuByRefresh.set(cred.refreshToken, {
				subscriptionType: cred.subscriptionType ?? null,
				rateLimitTier: cred.rateLimitTier ?? null,
			});
		}
		if (cred.accessToken) {
			credentialSkuByAccess.set(cred.accessToken, {
				subscriptionType: cred.subscriptionType ?? null,
				rateLimitTier: cred.rateLimitTier ?? null,
			});
		}
	}
	for (const path of CLAUDE_MULTI_ACCOUNT_PATHS) {
		const accounts = loadClaudeAccountsFromFile(path);
		for (const account of accounts) {
			if (account.oauthToken && !seenLabels.has(account.label)) {
				seenLabels.add(account.label);
				const sku = (
					account.subscriptionType || account.rateLimitTier
						? null
						: credentialSkuByRefresh.get(account.oauthRefreshToken)
							?? credentialSkuByAccess.get(account.oauthToken)
							?? null
				);
				all.push({
					label: account.label,
					accessToken: account.oauthToken,
					// Pass through new OAuth metadata fields (optional, may be null for legacy accounts)
					refreshToken: account.oauthRefreshToken || null,
					expiresAt: account.oauthExpiresAt || null,
					scopes: account.oauthScopes || null,
					subscriptionType: account.subscriptionType || sku?.subscriptionType || null,
					rateLimitTier: account.rateLimitTier || sku?.rateLimitTier || null,
					planOverride: account.planOverride || null,
					source: account.source,
				});
			}
		}
	}

	// 3. Claude Code credentials (skip in local mode)
	if (!options.local) {
		for (const account of loadClaudeOAuthFromClaudeCode()) {
			if (!seenLabels.has(account.label)) {
				seenLabels.add(account.label);
				all.push(account);
			}
		}
	}

	// 4. OpenCode credentials (skip in local mode)
	if (!options.local) {
		for (const account of loadClaudeOAuthFromOpenCode()) {
			if (!seenLabels.has(account.label)) {
				seenLabels.add(account.label);
				all.push(account);
			}
		}
	}

	// 5. Deduplicate by accessToken (same account from multiple sources with different labels)
	return deduplicateClaudeOAuthAccounts(all);
}

/**
 * Fetch Claude usage via OAuth API (official endpoint)
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Required headers:
 *   - Authorization: Bearer <access_token>
 *   - anthropic-version: 2023-06-01
 *   - anthropic-beta: oauth-2025-04-20
 * @param {string} accessToken - OAuth access token with user:profile scope
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
const usageCooldowns = new Map();
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

function rateLimitResult(retryAt, now) {
	return { success: false, status: 429, retryAt,
		error: `Rate limited; retry in ${Math.max(1, Math.ceil((retryAt - now) / 1000))} seconds` };
}

/** Fetch usage, respecting an account-specific cooldown after HTTP 429. */
export async function fetchClaudeOAuthUsage(accessToken, options = {}) {
	const now = options.now?.() ?? Date.now();
	const key = createHash("sha256").update(accessToken).digest("hex");
	const retryAt = usageCooldowns.get(key);
	if (retryAt > now) return rateLimitResult(retryAt, now);
	for (const [storedKey, deadline] of usageCooldowns) {
		if (deadline <= now) usageCooldowns.delete(storedKey);
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

	try {
		const res = await (options.fetchFn ?? fetch)(CLAUDE_OAUTH_USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-version": CLAUDE_OAUTH_VERSION,
				"anthropic-beta": CLAUDE_OAUTH_BETA,
			},
			signal: controller.signal,
		});

		if (res.status === 429) {
			const header = res.headers?.get("retry-after");
			const seconds = header === null || header === undefined ? NaN : Number(header);
			const requestedAt = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header ?? "");
			const deadline = Math.max(now + RATE_LIMIT_COOLDOWN_MS, Number.isFinite(requestedAt) ? requestedAt : 0);
			usageCooldowns.set(key, deadline);
			await res.body?.cancel();
			return rateLimitResult(deadline, now);
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return {
				success: false,
				error: `HTTP ${res.status}: ${body.slice(0, 200) || res.statusText}`,
			};
		}

		const data = await res.json();
		return { success: true, data };
	} catch (err) {
		const message = err.name === "AbortError" ? "Request timed out" : err.message;
		return { success: false, error: message };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Query usage for a discovered Claude OAuth account.
 *
 * Read-only: these credentials belong to Claude Code, OpenCode, or the
 * environment, so an expired token is reported rather than refreshed. Owned
 * accounts are refreshed by the provider adapter before reaching this call.
 *
 * The check is hard expiry, not the refresh buffer: a token inside the buffer
 * is still accepted by the usage endpoint, and since nothing here can rotate
 * it, rejecting it early would report a failure the API would not have given.
 * @param {{ label: string, accessToken: string, expiresAt?: number | null }} account
 * @returns {Promise<{ success: boolean, label: string, source: string, usage?: object, error?: string }>}
 */
export async function fetchClaudeOAuthUsageForAccount(account) {
	const describe = extra => ({
		label: account.label,
		source: account.source,
		subscriptionType: account.subscriptionType,
		rateLimitTier: account.rateLimitTier,
		planOverride: account.planOverride ?? null,
		...extra,
	});

	if (typeof account.expiresAt === "number" && account.expiresAt <= Date.now()) {
		return describe({
			success: false,
			error: account.refreshToken
				? "OAuth token expired - refresh token cannot be rotated for a read-only credential, run 'claude /login'"
				: "OAuth token expired - refresh token missing, run 'claude /login'",
		});
	}

	const result = await fetchClaudeOAuthUsage(account.accessToken);
	if (!result.success) {
		return describe({ success: false, error: result.error });
	}
	return describe({ success: true, usage: result.data });
}
