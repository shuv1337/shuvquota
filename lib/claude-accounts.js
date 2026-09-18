/**
 * Claude account discovery. Read-only: nothing here writes.
 *
 * OAuth only — the v1 `sk-ant-` session-key and browser-cookie path is gone,
 * so a row without an OAuth token is not a usable account.
 * Depends on: lib/constants.js, lib/container.js
 */

import { existsSync, readFileSync } from "node:fs";
import { CLAUDE_CREDENTIALS_PATH, CLAUDE_MULTI_ACCOUNT_PATHS } from "./constants.js";
import { readMultiAccountContainer } from "./container.js";

/**
 * Project a raw store row onto the fields the Claude adapter reads.
 * @param {unknown} raw
 * @param {string} source
 * @returns {object | null}
 */
export function normalizeClaudeAccount(raw, source) {
	if (!raw || typeof raw !== "object") return null;
	const label = raw.label ?? null;
	const oauthToken = raw.oauthToken ?? raw.oauth_token ?? raw.accessToken ?? raw.access_token ?? null;
	const orgId = raw.orgId ?? raw.org_id ?? null;
	const oauthRefreshToken = raw.oauthRefreshToken ?? raw.oauth_refresh_token ?? null;
	const oauthExpiresAt = raw.oauthExpiresAt ?? raw.oauth_expires_at ?? null;
	const oauthScopes = raw.oauthScopes ?? raw.oauth_scopes ?? null;
	const subscriptionType = raw.subscriptionType ?? raw.subscription_type ?? null;
	const rateLimitTier = raw.rateLimitTier ?? raw.rate_limit_tier ?? null;
	const planOverride = raw.planOverride ?? raw.plan_override ?? raw.displayPlan ?? null;
	return {
		label,
		oauthToken,
		orgId,
		oauthRefreshToken,
		oauthExpiresAt,
		oauthScopes,
		subscriptionType,
		rateLimitTier,
		planOverride,
		source,
	};
}

/**
 * @param {object | null} account
 * @returns {boolean}
 */
export function isValidClaudeAccount(account) {
	if (!account?.label) return false;
	return Boolean(account.oauthToken);
}

export function loadClaudeAccountsFromEnv() {
	const envAccounts = process.env.CLAUDE_ACCOUNTS;
	if (!envAccounts) return [];

	try {
		const parsed = JSON.parse(envAccounts);
		const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
		return accounts
			.map(a => normalizeClaudeAccount(a, "env"))
			.filter(a => a && isValidClaudeAccount(a));
	} catch {
		console.error("Warning: CLAUDE_ACCOUNTS env var is not valid JSON");
		return [];
	}
}

export function loadClaudeAccountsFromFile(filePath) {
	const container = readMultiAccountContainer(filePath);
	if (!container.exists) return [];
	return container.accounts
		.map(a => normalizeClaudeAccount(a, filePath))
		.filter(a => a && isValidClaudeAccount(a));
}

export function loadClaudeAccounts() {
	const all = [];
	all.push(...loadClaudeAccountsFromEnv());
	for (const path of CLAUDE_MULTI_ACCOUNT_PATHS) {
		all.push(...loadClaudeAccountsFromFile(path));
	}
	return all;
}

/**
 * Read the Claude Code OAuth access token. Read-only: the harness file is
 * never written back, so an expired token is reported, not rotated.
 * @returns {{ token: string | null, source: string, error?: string }}
 */
export function loadClaudeOAuthToken() {
	const credentialsPath = process.env.CLAUDE_CREDENTIALS_PATH || CLAUDE_CREDENTIALS_PATH;
	if (!existsSync(credentialsPath)) {
		return { token: null, source: credentialsPath, error: `Claude credentials not found at ${credentialsPath}` };
	}

	try {
		const raw = readFileSync(credentialsPath, "utf-8");
		const parsed = JSON.parse(raw);
		const token =
			parsed?.claudeAiOauth?.accessToken
			?? parsed?.claude_ai_oauth?.accessToken
			?? parsed?.accessToken
			?? parsed?.access_token
			?? null;
		if (!token) {
			return { token: null, source: credentialsPath, error: "No Claude OAuth accessToken found" };
		}
		return { token, source: credentialsPath };
	} catch (err) {
		return {
			token: null,
			source: credentialsPath,
			error: `Failed to read Claude credentials: ${err?.message ?? String(err)}`,
		};
	}
}

/**
 * Find a Claude account by label from supported sources
 * @param {string} label
 * @returns {object | null}
 */
export function findClaudeAccountByLabel(label) {
	const accounts = loadClaudeAccounts();
	return accounts.find(account => account.label === label) ?? null;
}

/**
 * Get all Claude labels from supported sources
 * @returns {string[]}
 */
export function getClaudeLabels() {
	const accounts = loadClaudeAccounts();
	return [...new Set(accounts.map(account => account.label))];
}
