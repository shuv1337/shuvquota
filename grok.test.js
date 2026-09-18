/**
 * Tests for SuperGrok / Grok OAuth quota
 * Run with: bun test grok.test.js
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_TOKEN_URL,
	GROK_BILLING_URL,
	GROK_TIMEOUT_MS,
	XAI_OAUTH_REFRESH_BUFFER_MS,
} from "./lib/constants.js";

import { XAI_TOKEN_FIELDS } from "./lib/token-match.js";

import {
	extractGrokProfile,
	resolveGrokExpiresAt,
	isValidGrokAccount,
	loadGrokAccountsFromPiAuth,
	loadGrokAccountsFromOpencodeAuth,
	loadGrokAccountsFromHermesAuth,
	loadGrokAccountsFromEnv,
	mergeGrokAccountCandidates,
	loadAllGrokAccounts,
} from "./lib/grok-accounts.js";

import {
	isGrokTokenExpiring,
	refreshGrokToken,
	sourceMatchesRotatedTokens,
} from "./lib/grok-tokens.js";

import {
	normalizeGrokCreditsBilling,
	fetchGrokUsage,
} from "./lib/grok-usage.js";

import {
	formatGrokPeriodReset,
} from "./lib/display.js";

function makeGrokJwt(claims = {}) {
	const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({
		iss: "https://auth.x.ai",
		sub: "user-sub-1",
		principal_id: "user-sub-1",
		tier: 5,
		team_id: "team-1",
		exp: Math.floor(Date.now() / 1000) + 3600,
		iat: Math.floor(Date.now() / 1000),
		...claims,
	})).toString("base64url");
	return `${header}.${payload}.sig`;
}

describe("Grok constants", () => {
	test("XAI_OAUTH_CLIENT_ID matches SuperGrok public client", () => {
		expect(XAI_OAUTH_CLIENT_ID).toBe("b1a00492-073a-47ea-816f-4c329264a828");
	});

	test("GROK_BILLING_URL uses credits format on cli-chat-proxy", () => {
		expect(GROK_BILLING_URL).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
	});

	test("XAI_OAUTH_TOKEN_URL is auth.x.ai", () => {
		expect(XAI_OAUTH_TOKEN_URL).toBe("https://auth.x.ai/oauth2/token");
	});

	test("refresh buffer and timeout are positive numbers", () => {
		expect(XAI_OAUTH_REFRESH_BUFFER_MS).toBe(5 * 60 * 1000);
		expect(GROK_TIMEOUT_MS).toBe(15000);
	});

	test("XAI_TOKEN_FIELDS covers pi and hermes key styles", () => {
		expect(XAI_TOKEN_FIELDS.access).toContain("access");
		expect(XAI_TOKEN_FIELDS.access).toContain("access_token");
		expect(XAI_TOKEN_FIELDS.refresh).toContain("refresh");
		expect(XAI_TOKEN_FIELDS.refresh).toContain("refresh_token");
	});
});

describe("extractGrokProfile", () => {
	test("reads sub, team, and tier from JWT", () => {
		const token = makeGrokJwt({ sub: "abc", principal_id: "abc", tier: 5, team_id: "t1" });
		const profile = extractGrokProfile(token);
		expect(profile.accountId).toBe("abc");
		expect(profile.teamId).toBe("t1");
		expect(profile.tier).toBe(5);
	});

	test("returns nulls for invalid token", () => {
		expect(extractGrokProfile("not-a-jwt")).toEqual({
			accountId: null,
			teamId: null,
			tier: null,
			email: null,
		});
	});
});

describe("resolveGrokExpiresAt", () => {
	test("uses explicit ms expiry", () => {
		const ms = Date.now() + 10_000;
		expect(resolveGrokExpiresAt(ms, null)).toBe(ms);
	});

	test("converts second-scale numbers to ms", () => {
		expect(resolveGrokExpiresAt(1_700_000_000, null)).toBe(1_700_000_000_000);
	});

	test("falls back to JWT exp", () => {
		const expSec = Math.floor(Date.now() / 1000) + 120;
		const token = makeGrokJwt({ exp: expSec });
		expect(resolveGrokExpiresAt(null, token)).toBe(expSec * 1000);
	});
});

describe("isValidGrokAccount", () => {
	test("requires accountId and a token", () => {
		expect(isValidGrokAccount({ accountId: "a", accessToken: "t" })).toBe(true);
		expect(isValidGrokAccount({ accountId: "a", refreshToken: "r" })).toBe(true);
		expect(isValidGrokAccount({ accountId: "a" })).toBe(false);
		expect(isValidGrokAccount(null)).toBe(false);
	});
});

describe("normalizeGrokCreditsBilling", () => {
	test("normalizes weekly credits payload", () => {
		const usage = normalizeGrokCreditsBilling({
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-07-08T00:00:00Z",
					end: "2026-07-15T00:00:00Z",
				},
				creditUsagePercent: 32,
				productUsage: [
					{ product: "Api", usagePercent: 19 },
					{ product: "GrokBuild", usagePercent: 13 },
				],
				prepaidBalance: { val: 2000 },
				onDemandCap: { val: 0 },
				onDemandUsed: { val: 0 },
				isUnifiedBillingUser: true,
			},
		});
		expect(usage.creditUsagePercent).toBe(32);
		expect(usage.products).toEqual([
			{ product: "Api", usagePercent: 19 },
			{ product: "GrokBuild", usagePercent: 13 },
		]);
		expect(usage.prepaidBalance).toBe(2000);
		expect(usage.period.type).toBe("USAGE_PERIOD_TYPE_WEEKLY");
		expect(usage.period.end).toBe("2026-07-15T00:00:00Z");
	});

	test("returns null without config", () => {
		expect(normalizeGrokCreditsBilling({})).toBeNull();
		expect(normalizeGrokCreditsBilling(null)).toBeNull();
	});

	test("treats an omitted proto3 percent as zero for a confirmed weekly period", () => {
		const usage = normalizeGrokCreditsBilling({
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-08-19T02:30:16.863135+00:00",
					end: "2026-08-26T02:30:16.863135+00:00",
				},
				billingPeriodStart: "2026-08-19T02:30:16.863135+00:00",
				billingPeriodEnd: "2026-08-26T02:30:16.863135+00:00",
				isUnifiedBillingUser: true,
			},
		});

		expect(usage.creditUsagePercent).toBe(0);
		expect(usage.products).toEqual([]);
	});

	test("keeps an omitted percent unknown when period bounds do not match", () => {
		const usage = normalizeGrokCreditsBilling({
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-08-19T02:30:16.863135+00:00",
					end: "2026-08-26T02:30:16.863135+00:00",
				},
				billingPeriodStart: "2026-08-01T00:00:00Z",
				billingPeriodEnd: "2026-09-01T00:00:00Z",
			},
		});

		expect(usage.creditUsagePercent).toBeNull();
	});
});

describe("loadGrokAccountsFromPiAuth", () => {
	const dir = join(tmpdir(), `shuvquota-grok-pi-${Date.now()}`);
	const authPath = join(dir, "auth.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("loads xai-oauth entry", () => {
		const access = makeGrokJwt({ sub: "pi-user" });
		writeFileSync(authPath, JSON.stringify({
			"xai-oauth": {
				type: "oauth",
				access,
				refresh: "refresh-pi",
				expires: Date.now() + 60_000,
				token_endpoint: XAI_OAUTH_TOKEN_URL,
			},
		}));
		const accounts = loadGrokAccountsFromPiAuth(authPath);
		expect(accounts).toHaveLength(1);
		expect(accounts[0].accountId).toBe("pi-user");
		expect(accounts[0].refreshToken).toBe("refresh-pi");
		expect(accounts[0].sources[0].kind).toBe("pi-auth");
		expect(accounts[0].sources[0].providerKey).toBe("xai-oauth");
	});

	test("loads xai entry used by current shuvpi sessions", () => {
		const access = makeGrokJwt({ sub: "pi-xai-user" });
		writeFileSync(authPath, JSON.stringify({
			xai: {
				type: "oauth",
				access,
				refresh: "refresh-xai",
				expires: Date.now() + 60_000,
			},
		}));
		const accounts = loadGrokAccountsFromPiAuth(authPath);
		expect(accounts).toHaveLength(1);
		expect(accounts[0].accountId).toBe("pi-xai-user");
		expect(accounts[0].refreshToken).toBe("refresh-xai");
		expect(accounts[0].sources[0].providerKey).toBe("xai");
	});

	test("loads both xai and xai-oauth when present", () => {
		const staleAccess = makeGrokJwt({ sub: "same-user", exp: Math.floor(Date.now() / 1000) - 3600 });
		const freshAccess = makeGrokJwt({ sub: "same-user", exp: Math.floor(Date.now() / 1000) + 7200 });
		const staleExp = Date.now() - 60_000;
		const freshExp = Date.now() + 120_000;
		writeFileSync(authPath, JSON.stringify({
			"xai-oauth": {
				type: "oauth",
				access: staleAccess,
				refresh: "stale-refresh",
				expires: staleExp,
			},
			xai: {
				type: "oauth",
				access: freshAccess,
				refresh: "fresh-refresh",
				expires: freshExp,
			},
		}));
		const accounts = loadGrokAccountsFromPiAuth(authPath);
		expect(accounts).toHaveLength(2);
		const keys = accounts.map(a => a.sources[0].providerKey).sort();
		expect(keys).toEqual(["xai", "xai-oauth"]);

		// loadAll path merges by accountId and keeps the fresher session
		const merged = loadAllGrokAccounts({
			piAuthPaths: [authPath],
			opencodeAuthPath: join(dir, "missing-opencode.json"),
			hermesAuthPath: join(dir, "missing-hermes.json"),
			includeEnv: false,
		});
		expect(merged).toHaveLength(1);
		expect(merged[0].refreshToken).toBe("fresh-refresh");
		expect(merged[0].expiresAt).toBe(freshExp);
		expect(merged[0].sources).toHaveLength(2);
	});

	test("returns empty for missing file", () => {
		expect(loadGrokAccountsFromPiAuth(join(dir, "missing.json"))).toEqual([]);
	});
});

describe("loadGrokAccountsFromOpencodeAuth", () => {
	const dir = join(tmpdir(), `shuvquota-grok-oc-${Date.now()}`);
	const authPath = join(dir, "auth.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("loads xai entry", () => {
		const access = makeGrokJwt({ sub: "oc-user" });
		writeFileSync(authPath, JSON.stringify({
			xai: { type: "oauth", access, refresh: "refresh-oc", expires: Date.now() + 60_000 },
		}));
		const accounts = loadGrokAccountsFromOpencodeAuth(authPath);
		expect(accounts).toHaveLength(1);
		expect(accounts[0].accountId).toBe("oc-user");
		expect(accounts[0].sources[0].kind).toBe("opencode-auth");
	});
});

describe("loadGrokAccountsFromHermesAuth", () => {
	const dir = join(tmpdir(), `shuvquota-grok-hermes-${Date.now()}`);
	const authPath = join(dir, "auth.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("loads pool and provider tokens", () => {
		const access = makeGrokJwt({ sub: "hermes-user" });
		writeFileSync(authPath, JSON.stringify({
			credential_pool: {
				"xai-oauth": [{
					label: "device_code",
					access_token: access,
					refresh_token: "refresh-hermes",
				}],
			},
			providers: {
				"xai-oauth": {
					tokens: {
						access_token: access,
						refresh_token: "refresh-hermes",
						expires_in: 21600,
					},
				},
			},
		}));
		const accounts = loadGrokAccountsFromHermesAuth(authPath);
		expect(accounts.length).toBeGreaterThanOrEqual(1);
		expect(accounts.every(a => a.accountId === "hermes-user")).toBe(true);
	});
});

describe("loadGrokAccountsFromEnv", () => {
	let original;

	beforeEach(() => {
		original = process.env.GROK_ACCOUNTS;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.GROK_ACCOUNTS;
		else process.env.GROK_ACCOUNTS = original;
	});

	test("loads array from env", () => {
		const access = makeGrokJwt({ sub: "env-user" });
		process.env.GROK_ACCOUNTS = JSON.stringify([{
			label: "personal",
			access,
			refresh: "refresh-env",
			expires: Date.now() + 60_000,
		}]);
		const accounts = loadGrokAccountsFromEnv();
		expect(accounts).toHaveLength(1);
		expect(accounts[0].label).toBe("personal");
		expect(accounts[0].accountId).toBe("env-user");
		expect(accounts[0].source).toBe("env");
	});
});

describe("mergeGrokAccountCandidates", () => {
	test("unions sources and keeps fresher tokens", () => {
		const older = {
			label: "grok",
			accountId: "u1",
			accessToken: "old-access",
			refreshToken: "old-refresh",
			expiresAt: 100,
			source: "/a",
			sources: [{ kind: "pi-auth", path: "/a", previousAccess: "old-access", previousRefresh: "old-refresh" }],
		};
		const newer = {
			label: "grok",
			accountId: "u1",
			accessToken: "new-access",
			refreshToken: "new-refresh",
			expiresAt: 200,
			source: "/b",
			sources: [{ kind: "opencode-auth", path: "/b", previousAccess: "new-access", previousRefresh: "new-refresh" }],
		};
		const merged = mergeGrokAccountCandidates(older, newer);
		expect(merged.accessToken).toBe("new-access");
		expect(merged.sources).toHaveLength(2);
	});
});

describe("loadAllGrokAccounts", () => {
	const dir = join(tmpdir(), `shuvquota-grok-all-${Date.now()}`);
	const piPath = join(dir, "pi-auth.json");
	const ocPath = join(dir, "oc-auth.json");

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
		delete process.env.GROK_ACCOUNTS;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.GROK_ACCOUNTS;
	});

	test("dedupes same sub across stores", () => {
		const access = makeGrokJwt({ sub: "shared-user" });
		const expires = Date.now() + 120_000;
		writeFileSync(piPath, JSON.stringify({
			"xai-oauth": { type: "oauth", access, refresh: "same-refresh", expires },
		}));
		writeFileSync(ocPath, JSON.stringify({
			xai: { type: "oauth", access, refresh: "same-refresh", expires },
		}));

		const accounts = loadAllGrokAccounts({
			piAuthPaths: [piPath],
			opencodeAuthPath: ocPath,
			hermesAuthPath: join(dir, "missing-hermes.json"),
			includeEnv: false,
		});
		expect(accounts).toHaveLength(1);
		expect(accounts[0].accountId).toBe("shared-user");
		expect(accounts[0].sources.length).toBe(2);
	});
});

describe("sourceMatchesRotatedTokens", () => {
	test("matches on refresh when both sides have one; access is fallback only", () => {
		expect(sourceMatchesRotatedTokens(
			{ previousRefresh: "r1", previousAccess: "a1" },
			{ previousRefresh: "r1", previousAccess: "a9" },
		)).toBe(true);
		// Diverged refresh must not match even if access is shared
		expect(sourceMatchesRotatedTokens(
			{ previousRefresh: "r9", previousAccess: "a1" },
			{ previousRefresh: "r1", previousAccess: "a1" },
		)).toBe(false);
		expect(sourceMatchesRotatedTokens(
			{ previousRefresh: "r9", previousAccess: "a9" },
			{ previousRefresh: "r1", previousAccess: "a1" },
		)).toBe(false);
		// Access fallback when refresh is missing on a side
		expect(sourceMatchesRotatedTokens(
			{ previousRefresh: null, previousAccess: "a1" },
			{ previousRefresh: "r1", previousAccess: "a1" },
		)).toBe(true);
	});
});

describe("isGrokTokenExpiring", () => {
	test("isGrokTokenExpiring respects buffer", () => {
		const soon = Date.now() + 1000;
		expect(isGrokTokenExpiring("x", soon, 5000)).toBe(true);
		const later = Date.now() + 60_000;
		expect(isGrokTokenExpiring("x", later, 5000)).toBe(false);
	});
});

describe("refreshGrokToken", () => {
	test("posts refresh_token grant", async () => {
		let seenBody = "";
		const result = await refreshGrokToken("r-token", {
			fetchFn: async (_url, init) => {
				seenBody = String(init.body);
				return {
					ok: true,
					async text() {
						return JSON.stringify({
							access_token: "a",
							refresh_token: "r2",
							expires_in: 100,
						});
					},
				};
			},
		});
		expect(result.access_token).toBe("a");
		expect(result.refresh_token).toBe("r2");
		expect(seenBody).toContain("grant_type=refresh_token");
		expect(seenBody).toContain(XAI_OAUTH_CLIENT_ID);
	});

	test("returns error on HTTP failure", async () => {
		const result = await refreshGrokToken("r", {
			fetchFn: async () => ({
				ok: false,
				status: 400,
				async text() { return "bad"; },
			}),
		});
		expect(result.error).toContain("HTTP 400");
	});
});

describe("fetchGrokUsage", () => {
	test("returns normalized credits usage", async () => {
		const result = await fetchGrokUsage({ accessToken: "t" }, {
			fetchFn: async () => ({
				ok: true,
				status: 200,
				async json() {
					return {
						config: {
							creditUsagePercent: 10,
							productUsage: [{ product: "Api", usagePercent: 10 }],
							prepaidBalance: { val: 5 },
							billingPeriodStart: "s",
							billingPeriodEnd: "e",
						},
					};
				},
			}),
		});
		expect(result.success).toBe(true);
		expect(result.usage.creditUsagePercent).toBe(10);
		expect(result.usage.prepaidBalance).toBe(5);
	});

	test("maps 401 to sign-in required", async () => {
		const result = await fetchGrokUsage({ accessToken: "t" }, {
			fetchFn: async () => ({
				ok: false,
				status: 401,
				async text() { return ""; },
			}),
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("Grok sign-in required");
	});
});

describe("formatGrokPeriodReset", () => {
	test("formatGrokPeriodReset uses relative reset phrasing", () => {
		const end = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
		const text = formatGrokPeriodReset(end, "inline");
		expect(text).toContain("resets");
	});
});
