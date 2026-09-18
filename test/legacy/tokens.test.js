/**
 * Legacy token refresh and expiry tests migrated from shuvquota.test.js
 * Run with: bun test test/legacy/tokens.test.js
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	CLAUDE_OAUTH_TOKEN_URL,
	CLAUDE_OAUTH_CLIENT_ID,
	CLAUDE_OAUTH_REFRESH_BUFFER_MS,
	TOKEN_URL,
	CLIENT_ID,
	OPENAI_OAUTH_REFRESH_BUFFER_MS,
} from "../../lib/constants.js";
import { fetchClaudeOAuthUsageForAccount } from "../../lib/claude-usage.js";
import {
	refreshClaudeToken,
	isClaudeOauthTokenExpiring,
} from "../../lib/claude-tokens.js";
import {
	refreshToken,
	isOpenAiOauthTokenExpiring,
} from "../../lib/codex-tokens.js";

describe("fetchClaudeOAuthUsageForAccount", () => {
	let originalFetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("fetches usage when token is valid", async () => {
		globalThis.fetch = async (url, options) => {
			if (url === "https://api.anthropic.com/api/oauth/usage") {
				expect(options.headers.Authorization).toBe("Bearer sk-ant-oat-valid");
				return new Response(JSON.stringify({
					five_hour: { utilization: 0.1 },
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		};

		const account = {
			label: "valid-account",
			accessToken: "sk-ant-oat-valid",
			expiresAt: Date.now() + 60000,
			source: "test",
		};

		const result = await fetchClaudeOAuthUsageForAccount(account);
		expect(result.success).toBe(true);
		expect(result.usage).toBeDefined();
		expect(result.label).toBe("valid-account");
	});

	test("returns error when token is expired with refresh token", async () => {
		const account = {
			label: "expired-account",
			accessToken: "sk-ant-oat-expired",
			refreshToken: "sk-ant-ort-present",
			expiresAt: Date.now() - 1000,
			source: "test",
		};

		const result = await fetchClaudeOAuthUsageForAccount(account);
		expect(result.success).toBe(false);
		expect(result.error).toContain("expired");
		expect(result.error).toContain("claude /login");
		expect(result.label).toBe("expired-account");
	});

	test("returns error when token is expired without refresh token", async () => {
		const account = {
			label: "expired-account-no-refresh",
			accessToken: "sk-ant-oat-expired",
			expiresAt: Date.now() - 1000,
			source: "test",
		};

		const result = await fetchClaudeOAuthUsageForAccount(account);
		expect(result.success).toBe(false);
		expect(result.error).toContain("expired");
		expect(result.error).toContain("missing");
		expect(result.label).toBe("expired-account-no-refresh");
	});
});

describe("refreshClaudeToken", () => {
	let originalFetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("posts refresh_token grant to CLAUDE_OAUTH_TOKEN_URL", async () => {
		let requestBody;
		globalThis.fetch = async (url, options) => {
			if (url === CLAUDE_OAUTH_TOKEN_URL) {
				requestBody = JSON.parse(options.body);
				return new Response(JSON.stringify({
					access_token: "sk-ant-oat-new",
					refresh_token: "sk-ant-ort-new",
					expires_in: 3600,
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		};

		const result = await refreshClaudeToken("sk-ant-ort-old");
		expect(result.accessToken).toBe("sk-ant-oat-new");
		expect(result.refreshToken).toBe("sk-ant-ort-new");
		expect(result.expiresIn).toBe(3600);
		expect(requestBody.grant_type).toBe("refresh_token");
		expect(requestBody.refresh_token).toBe("sk-ant-ort-old");
		expect(requestBody.client_id).toBe(CLAUDE_OAUTH_CLIENT_ID);
	});

	test("throws error when refresh fails", async () => {
		globalThis.fetch = async () => new Response("Bad request", { status: 400 });
		expect(refreshClaudeToken("bad-refresh")).rejects.toThrow("Token refresh failed: 400");
	});
});

describe("isClaudeOauthTokenExpiring", () => {
	test("returns false when expiresAt is null or undefined", () => {
		expect(isClaudeOauthTokenExpiring(null)).toBe(false);
		expect(isClaudeOauthTokenExpiring(undefined)).toBe(false);
	});

	test("returns true when expiresAt is within buffer", () => {
		const soon = Date.now() + CLAUDE_OAUTH_REFRESH_BUFFER_MS - 1000;
		expect(isClaudeOauthTokenExpiring(soon)).toBe(true);
	});

	test("returns false when expiresAt is beyond buffer", () => {
		const later = Date.now() + CLAUDE_OAUTH_REFRESH_BUFFER_MS + 60000;
		expect(isClaudeOauthTokenExpiring(later)).toBe(false);
	});
});

describe("refreshToken (OpenAI)", () => {
	let originalFetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("posts refresh_token grant to TOKEN_URL", async () => {
		let requestParams;
		globalThis.fetch = async (url, options) => {
			if (url === TOKEN_URL) {
				requestParams = new URLSearchParams(options.body);
				return new Response(JSON.stringify({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 3600,
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		};

		const result = await refreshToken("old-refresh-token");
		expect(result).not.toBeNull();
		expect(result.access).toBe("new-access-token");
		expect(result.refresh).toBe("new-refresh-token");
		expect(result.expires).toBeGreaterThan(Date.now());
		expect(requestParams.get("grant_type")).toBe("refresh_token");
		expect(requestParams.get("refresh_token")).toBe("old-refresh-token");
		expect(requestParams.get("client_id")).toBe(CLIENT_ID);
	});

	test("returns null when HTTP request fails", async () => {
		globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
		const result = await refreshToken("invalid-refresh");
		expect(result).toBeNull();
	});

	test("returns null when response lacks required tokens", async () => {
		globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "token" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
		const result = await refreshToken("refresh");
		expect(result).toBeNull();
	});
});

describe("isOpenAiOauthTokenExpiring", () => {
	test("returns true when expires is null or undefined", () => {
		expect(isOpenAiOauthTokenExpiring(null)).toBe(true);
		expect(isOpenAiOauthTokenExpiring(undefined)).toBe(true);
	});

	test("returns true when expires is within buffer", () => {
		const soon = Date.now() + OPENAI_OAUTH_REFRESH_BUFFER_MS - 1000;
		expect(isOpenAiOauthTokenExpiring(soon)).toBe(true);
	});

	test("returns false when expires is beyond buffer", () => {
		const later = Date.now() + OPENAI_OAUTH_REFRESH_BUFFER_MS + 60000;
		expect(isOpenAiOauthTokenExpiring(later)).toBe(false);
	});
});
