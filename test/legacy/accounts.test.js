/**
 * Legacy account loading and validation tests migrated from shuvquota.test.js
 * Run with: bun test test/legacy/accounts.test.js
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	isValidAccount,
	loadAccountsFromEnv,
	loadAccountsFromFile,
	findAccountByLabel,
	getAllLabels,
	deduplicateAccountsByEmail,
} from "../../lib/codex-accounts.js";

import {
	isValidClaudeAccount,
	loadClaudeAccountsFromEnv,
	loadClaudeAccountsFromFile,
} from "../../lib/claude-accounts.js";

import {
	loadClaudeOAuthFromEnv,
	loadClaudeOAuthFromClaudeCode,
	loadAllClaudeOAuthAccounts,
	deduplicateClaudeOAuthAccounts,
	deduplicateClaudeResultsByUsage,
	buildClaudeUsageFingerprint,
} from "../../lib/claude-usage.js";

function createMockAccessToken(accountId, email = "test@example.com", planType = "plus") {
	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		"https://api.openai.com/auth": {
			chatgpt_account_id: accountId,
			chatgpt_plan_type: planType,
		},
		"https://api.openai.com/profile": {
			email,
		},
	};
	const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64");
	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
	return `${headerB64}.${payloadB64}.fake_signature`;
}

function createFakeJwtWithEmail(email) {
	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		"https://api.openai.com/profile": { email },
		exp: Math.floor(Date.now() / 1000) + 3600,
	};
	const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
	return `${encode(header)}.${encode(payload)}.fake-signature`;
}

const MOCK_ACCOUNT_ID = "acc_12345";
const MOCK_ACCESS_TOKEN = createMockAccessToken(MOCK_ACCOUNT_ID);
const MOCK_REFRESH_TOKEN = "refresh_token_123";

// ─────────────────────────────────────────────────────────────────────────────
// Account validation tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidAccount", () => {
	test("returns truthy for valid account with all required fields", () => {
		const account = {
			label: "test",
			accountId: MOCK_ACCOUNT_ID,
			access: MOCK_ACCESS_TOKEN,
			refresh: MOCK_REFRESH_TOKEN,
		};
		expect(isValidAccount(account)).toBeTruthy();
	});

	test("returns falsy for account missing label", () => {
		const account = {
			accountId: MOCK_ACCOUNT_ID,
			access: MOCK_ACCESS_TOKEN,
			refresh: MOCK_REFRESH_TOKEN,
		};
		expect(isValidAccount(account)).toBeFalsy();
	});

	test("returns falsy for account missing access token", () => {
		const account = {
			label: "test",
			accountId: MOCK_ACCOUNT_ID,
			refresh: MOCK_REFRESH_TOKEN,
		};
		expect(isValidAccount(account)).toBeFalsy();
	});

	test("returns falsy for account missing refresh token", () => {
		const account = {
			label: "test",
			accountId: MOCK_ACCOUNT_ID,
			access: MOCK_ACCESS_TOKEN,
		};
		expect(isValidAccount(account)).toBeFalsy();
	});

	test("returns falsy for null input", () => {
		expect(isValidAccount(null)).toBeFalsy();
	});

	test("returns falsy for non-object input", () => {
		expect(isValidAccount("string")).toBeFalsy();
		expect(isValidAccount(123)).toBeFalsy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude account validation tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidClaudeAccount", () => {
	test("returns truthy for valid account with oauthToken", () => {
		const account = {
			label: "claude",
			oauthToken: "oauth-token",
		};
		expect(isValidClaudeAccount(account)).toBeTruthy();
	});

	test("returns falsy for account missing label", () => {
		const account = {
			oauthToken: "oauth-token",
		};
		expect(isValidClaudeAccount(account)).toBeFalsy();
	});

	test("returns falsy for account missing tokens", () => {
		const account = {
			label: "claude",
		};
		expect(isValidClaudeAccount(account)).toBeFalsy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// loadAccountsFromEnv tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadAccountsFromEnv", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CODEX_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CODEX_ACCOUNTS;
		} else {
			process.env.CODEX_ACCOUNTS = originalEnv;
		}
	});

	test("returns empty array when CODEX_ACCOUNTS not set", () => {
		delete process.env.CODEX_ACCOUNTS;
		const accounts = loadAccountsFromEnv();
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "env-account", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const accounts = loadAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("env-account");
		expect(accounts[0].source).toBe("env");
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "env-account-2", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
			],
		};
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockData);
		
		const accounts = loadAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("env-account-2");
		expect(accounts[0].source).toBe("env");
	});

	test("returns empty array for invalid JSON", () => {
		process.env.CODEX_ACCOUNTS = "not valid json {";
		const accounts = loadAccountsFromEnv();
		expect(accounts).toEqual([]);
	});

	test("filters out invalid accounts", () => {
		const mockAccounts = [
			{ label: "valid", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
			{ label: "invalid-no-access", accountId: MOCK_ACCOUNT_ID, refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const accounts = loadAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("valid");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// loadClaudeAccountsFromEnv tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadClaudeAccountsFromEnv", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CLAUDE_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CLAUDE_ACCOUNTS;
		} else {
			process.env.CLAUDE_ACCOUNTS = originalEnv;
		}
	});

	test("returns empty array when CLAUDE_ACCOUNTS not set", () => {
		delete process.env.CLAUDE_ACCOUNTS;
		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "claude-env", oauthToken: "sk-ant-oat-123" },
		];
		process.env.CLAUDE_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("claude-env");
		expect(accounts[0].source).toBe("env");
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "claude-env-2", oauthToken: "oauth-token" },
			],
		};
		process.env.CLAUDE_ACCOUNTS = JSON.stringify(mockData);

		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("claude-env-2");
		expect(accounts[0].source).toBe("env");
	});

	test("returns empty array for invalid JSON", () => {
		process.env.CLAUDE_ACCOUNTS = "not valid json {";
		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts).toEqual([]);
	});

	test("filters out invalid accounts", () => {
		const mockAccounts = [
			{ label: "valid", oauthToken: "sk-ant-oat-123" },
			{ label: "invalid-no-auth" },
		];
		process.env.CLAUDE_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadClaudeAccountsFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("valid");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// loadAccountsFromFile tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadAccountsFromFile", () => {
	const testDir = join(tmpdir(), "shuvquota-test-" + Date.now());
	const testFile = join(testDir, "accounts.json");

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("returns empty array for non-existent file", () => {
		const accounts = loadAccountsFromFile("/nonexistent/path/accounts.json");
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "file-account", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
		];
		writeFileSync(testFile, JSON.stringify(mockAccounts));
		
		const accounts = loadAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("file-account");
		expect(accounts[0].source).toBe(testFile);
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "file-account-2", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
			],
		};
		writeFileSync(testFile, JSON.stringify(mockData));
		
		const accounts = loadAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("file-account-2");
		expect(accounts[0].source).toBe(testFile);
	});

	test("returns empty array for invalid JSON file", () => {
		writeFileSync(testFile, "not valid json");
		const accounts = loadAccountsFromFile(testFile);
		expect(accounts).toEqual([]);
	});

	test("preserves extra fields from accounts", () => {
		const mockAccounts = [
			{ label: "account", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN, expires: 123456, customField: "preserved" },
		];
		writeFileSync(testFile, JSON.stringify(mockAccounts));
		
		const accounts = loadAccountsFromFile(testFile);
		expect(accounts[0].expires).toBe(123456);
		expect(accounts[0].customField).toBe("preserved");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// loadClaudeAccountsFromFile tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadClaudeAccountsFromFile", () => {
	const testDir = join(tmpdir(), "shuvquota-claude-test-" + Date.now());
	const testFile = join(testDir, "claude-accounts.json");

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("returns empty array for non-existent file", () => {
		const accounts = loadClaudeAccountsFromFile("/nonexistent/path/claude-accounts.json");
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "file-claude", oauthToken: "sk-ant-oat-123" },
		];
		writeFileSync(testFile, JSON.stringify(mockAccounts));

		const accounts = loadClaudeAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("file-claude");
		expect(accounts[0].source).toBe(testFile);
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "file-claude-2", oauthToken: "oauth-token" },
			],
		};
		writeFileSync(testFile, JSON.stringify(mockData));

		const accounts = loadClaudeAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("file-claude-2");
		expect(accounts[0].source).toBe(testFile);
	});

	test("returns empty array for invalid JSON file", () => {
		writeFileSync(testFile, "not valid json");
		const accounts = loadClaudeAccountsFromFile(testFile);
		expect(accounts).toEqual([]);
	});

	test("filters out invalid accounts", () => {
		const mockData = {
			accounts: [
				{ label: "valid", oauthToken: "sk-ant-oat-123" },
				{ label: "invalid-no-auth" },
			],
		};
		writeFileSync(testFile, JSON.stringify(mockData));

		const accounts = loadClaudeAccountsFromFile(testFile);
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("valid");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude OAuth loading tests
// ─────────────────────────────────────────────────────────────────────────────

describe("loadClaudeOAuthFromEnv", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CLAUDE_OAUTH_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CLAUDE_OAUTH_ACCOUNTS;
		} else {
			process.env.CLAUDE_OAUTH_ACCOUNTS = originalEnv;
		}
	});

	test("returns empty array when CLAUDE_OAUTH_ACCOUNTS not set", () => {
		delete process.env.CLAUDE_OAUTH_ACCOUNTS;
		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts).toEqual([]);
	});

	test("returns accounts from JSON array format", () => {
		const mockAccounts = [
			{ label: "oauth-env", accessToken: "sk-ant-oat-123" },
		];
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("oauth-env");
		expect(accounts[0].source).toBe("env:CLAUDE_OAUTH_ACCOUNTS");
	});

	test("returns accounts from {accounts: [...]} format", () => {
		const mockData = {
			accounts: [
				{ label: "oauth-env-2", accessToken: "sk-ant-oat-456" },
			],
		};
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockData);

		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("oauth-env-2");
	});

	test("returns empty array for invalid JSON", () => {
		process.env.CLAUDE_OAUTH_ACCOUNTS = "not valid json {";
		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts).toEqual([]);
	});

	test("filters out accounts missing label or accessToken", () => {
		const mockAccounts = [
			{ label: "valid", accessToken: "sk-ant-oat-123" },
			{ label: "no-token" },
			{ accessToken: "sk-ant-oat-456" },
		];
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadClaudeOAuthFromEnv();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("valid");
	});
});

describe("loadClaudeOAuthFromClaudeCode", () => {
	const testDir = join(tmpdir(), "shuvquota-claude-oauth-test-" + Date.now());
	const testCredentialsFile = join(testDir, ".credentials.json");
	let originalEnv;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		originalEnv = process.env.CLAUDE_CREDENTIALS_PATH;
		process.env.CLAUDE_CREDENTIALS_PATH = testCredentialsFile;
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		if (originalEnv === undefined) {
			delete process.env.CLAUDE_CREDENTIALS_PATH;
		} else {
			process.env.CLAUDE_CREDENTIALS_PATH = originalEnv;
		}
	});

	test("returns empty array when credentials file not found", () => {
		const accounts = loadClaudeOAuthFromClaudeCode();
		expect(accounts).toEqual([]);
	});

	test("returns account with OAuth credentials and user:profile scope", () => {
		const mockCredentials = {
			claudeAiOauth: {
				accessToken: "sk-ant-oat-123",
				refreshToken: "sk-ant-ort-456",
				expiresAt: Date.now() + 3600000,
				scopes: ["user:inference", "user:profile"],
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_20x",
			},
		};
		writeFileSync(testCredentialsFile, JSON.stringify(mockCredentials));

		const accounts = loadClaudeOAuthFromClaudeCode();
		expect(accounts.length).toBe(1);
		expect(accounts[0].label).toBe("claude-code");
		expect(accounts[0].accessToken).toBe("sk-ant-oat-123");
		expect(accounts[0].subscriptionType).toBe("max");
		expect(accounts[0].source).toBe(testCredentialsFile);
	});

	test("returns empty array when missing user:profile scope", () => {
		const mockCredentials = {
			claudeAiOauth: {
				accessToken: "sk-ant-oat-123",
				scopes: ["user:inference"], // Missing user:profile
			},
		};
		writeFileSync(testCredentialsFile, JSON.stringify(mockCredentials));

		const accounts = loadClaudeOAuthFromClaudeCode();
		expect(accounts).toEqual([]);
	});

	test("returns empty array when accessToken is missing", () => {
		const mockCredentials = {
			claudeAiOauth: {
				refreshToken: "sk-ant-ort-456",
				scopes: ["user:profile"],
			},
		};
		writeFileSync(testCredentialsFile, JSON.stringify(mockCredentials));

		const accounts = loadClaudeOAuthFromClaudeCode();
		expect(accounts).toEqual([]);
	});
});

describe("loadAllClaudeOAuthAccounts", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CLAUDE_OAUTH_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CLAUDE_OAUTH_ACCOUNTS;
		} else {
			process.env.CLAUDE_OAUTH_ACCOUNTS = originalEnv;
		}
	});

	test("returns accounts from env with highest priority", () => {
		const mockAccounts = [
			{ label: "env-account", accessToken: "sk-ant-oat-env" },
		];
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadAllClaudeOAuthAccounts();
		// Should include at least the env account
		const envAccount = accounts.find(a => a.label === "env-account");
		expect(envAccount).toBeDefined();
		expect(envAccount.accessToken).toBe("sk-ant-oat-env");
	});

	test("deduplicates accounts by label", () => {
		const mockAccounts = [
			{ label: "duplicate", accessToken: "sk-ant-oat-1" },
			{ label: "duplicate", accessToken: "sk-ant-oat-2" },
		];
		process.env.CLAUDE_OAUTH_ACCOUNTS = JSON.stringify(mockAccounts);

		const accounts = loadAllClaudeOAuthAccounts();
		const duplicates = accounts.filter(a => a.label === "duplicate");
		// Only the first one should be kept
		expect(duplicates.length).toBe(1);
		expect(duplicates[0].accessToken).toBe("sk-ant-oat-1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication tests
// ─────────────────────────────────────────────────────────────────────────────

describe("deduplicateAccountsByEmail", () => {
	test("removes duplicate accounts with same email", () => {
		const accounts = [
			{ label: "account1", access: createFakeJwtWithEmail("user1@example.com"), source: "file1" },
			{ label: "account2", access: createFakeJwtWithEmail("user1@example.com"), source: "file2" },
			{ label: "account3", access: createFakeJwtWithEmail("user2@example.com"), source: "file3" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(2);
		expect(result[0].label).toBe("account1");
		expect(result[1].label).toBe("account3");
	});

	test("keeps first occurrence when duplicates exist", () => {
		const accounts = [
			{ label: "first", access: createFakeJwtWithEmail("same@example.com"), source: "source1" },
			{ label: "second", access: createFakeJwtWithEmail("same@example.com"), source: "source2" },
			{ label: "third", access: createFakeJwtWithEmail("same@example.com"), source: "source3" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(1);
		expect(result[0].label).toBe("first");
		expect(result[0].source).toBe("source1");
	});

	test("returns all accounts when emails are different", () => {
		const accounts = [
			{ label: "a", access: createFakeJwtWithEmail("a@example.com"), source: "s1" },
			{ label: "b", access: createFakeJwtWithEmail("b@example.com"), source: "s2" },
			{ label: "c", access: createFakeJwtWithEmail("c@example.com"), source: "s3" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(3);
	});

	test("handles empty array", () => {
		const result = deduplicateAccountsByEmail([]);
		expect(result).toEqual([]);
	});

	test("keeps accounts without access token", () => {
		const accounts = [
			{ label: "no-token", source: "s1" },
			{ label: "has-token", access: createFakeJwtWithEmail("user@example.com"), source: "s2" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(2);
	});

	test("keeps accounts with invalid JWT (no email extractable)", () => {
		const accounts = [
			{ label: "invalid-jwt", access: "not-a-valid-jwt", source: "s1" },
			{ label: "valid-jwt", access: createFakeJwtWithEmail("user@example.com"), source: "s2" },
		];
		const result = deduplicateAccountsByEmail(accounts);
		expect(result.length).toBe(2);
	});
});

describe("deduplicateClaudeOAuthAccounts", () => {
	test("removes duplicate accounts with same refreshToken", () => {
		const accounts = [
			{ label: "claude1", accessToken: "sk-ant-oat-abc", refreshToken: "sk-ant-ort-same", source: "file1" },
			{ label: "claude2", accessToken: "sk-ant-oat-def", refreshToken: "sk-ant-ort-same", source: "file2" },
			{ label: "claude3", accessToken: "sk-ant-oat-ghi", refreshToken: "sk-ant-ort-different", source: "file3" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(2);
		expect(result[0].label).toBe("claude1");
		expect(result[1].label).toBe("claude3");
	});

	test("keeps first occurrence when duplicates exist", () => {
		const refresh = "sk-ant-ort-same-" + "x".repeat(50);
		const accounts = [
			{ label: "first", accessToken: "sk-ant-oat-1", refreshToken: refresh, source: "source1" },
			{ label: "second", accessToken: "sk-ant-oat-2", refreshToken: refresh, source: "source2" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(1);
		expect(result[0].label).toBe("first");
	});

	test("returns all accounts when refresh tokens are different", () => {
		const accounts = [
			{ label: "a", accessToken: "sk-ant-oat-1", refreshToken: "sk-ant-ort-1-unique", source: "s1" },
			{ label: "b", accessToken: "sk-ant-oat-2", refreshToken: "sk-ant-ort-2-unique", source: "s2" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(2);
	});

	test("falls back to accessToken when no refreshToken", () => {
		const accounts = [
			{ label: "claude1", accessToken: "sk-ant-oat-same-token", source: "file1" },
			{ label: "claude2", accessToken: "sk-ant-oat-same-token", source: "file2" },
			{ label: "claude3", accessToken: "sk-ant-oat-different", source: "file3" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(2);
		expect(result[0].label).toBe("claude1");
		expect(result[1].label).toBe("claude3");
	});

	test("handles empty array", () => {
		const result = deduplicateClaudeOAuthAccounts([]);
		expect(result).toEqual([]);
	});

	test("keeps accounts without accessToken", () => {
		const accounts = [
			{ label: "no-token", source: "s1" },
			{ label: "has-token", accessToken: "sk-ant-valid-token", source: "s2" },
		];
		const result = deduplicateClaudeOAuthAccounts(accounts);
		expect(result.length).toBe(2);
	});
});

describe("deduplicateClaudeResultsByUsage", () => {
	test("includes new OAuth limits array in usage fingerprints", () => {
		const baseUsage = {
			five_hour: { utilization: 3 },
			seven_day: { utilization: 1 },
			seven_day_sonnet: null,
			limits: [
				{ kind: "session", group: "session", percent: 3 },
				{ kind: "weekly_all", group: "weekly", percent: 1 },
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 0,
					scope: { model: { display_name: "Fable" }, surface: null },
				},
			],
		};
		const result = deduplicateClaudeResultsByUsage([
			{ success: true, label: "a", usage: baseUsage },
			{ success: true, label: "b", usage: structuredClone(baseUsage) },
			{
				success: true,
				label: "c",
				usage: {
					...baseUsage,
					limits: baseUsage.limits.map(limit => (
						limit.kind === "weekly_scoped" ? { ...limit, percent: 4 } : limit
					)),
				},
			},
		]);

		expect(result.map(item => item.label)).toEqual(["a", "c"]);
		expect(buildClaudeUsageFingerprint(baseUsage)).toContain("Fable");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// findAccountByLabel tests
// ─────────────────────────────────────────────────────────────────────────────

describe("findAccountByLabel", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CODEX_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CODEX_ACCOUNTS;
		} else {
			process.env.CODEX_ACCOUNTS = originalEnv;
		}
	});

	test("finds account by label from env", () => {
		const mockAccounts = [
			{ label: "personal", accountId: MOCK_ACCOUNT_ID, access: MOCK_ACCESS_TOKEN, refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const account = findAccountByLabel("personal");
		expect(account).not.toBeNull();
		expect(account.label).toBe("personal");
	});

	test("returns null for non-existent label", () => {
		delete process.env.CODEX_ACCOUNTS;
		const account = findAccountByLabel("nonexistent-label-12345");
		expect(account).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllLabels tests
// ─────────────────────────────────────────────────────────────────────────────

describe("getAllLabels", () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = process.env.CODEX_ACCOUNTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CODEX_ACCOUNTS;
		} else {
			process.env.CODEX_ACCOUNTS = originalEnv;
		}
	});

	test("returns array of labels from env accounts", () => {
		// Use different emails so they aren't deduplicated
		const mockAccounts = [
			{ label: "work", accountId: MOCK_ACCOUNT_ID, access: createMockAccessToken(MOCK_ACCOUNT_ID, "work@example.com"), refresh: MOCK_REFRESH_TOKEN },
			{ label: "personal", accountId: "acc_67890", access: createMockAccessToken("acc_67890", "personal@example.com"), refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const labels = getAllLabels();
		expect(labels).toContain("work");
		expect(labels).toContain("personal");
	});

	test("returns all labels even when emails duplicate (no-dedup resolution)", () => {
		// Same email across workspaces should not hide valid labels
		const mockAccounts = [
			{ label: "dedup-test-1", accountId: MOCK_ACCOUNT_ID, access: createMockAccessToken(MOCK_ACCOUNT_ID, "dedup-same@example.com"), refresh: MOCK_REFRESH_TOKEN },
			{ label: "dedup-test-2", accountId: "acc_67890", access: createMockAccessToken("acc_67890", "dedup-same@example.com"), refresh: MOCK_REFRESH_TOKEN },
		];
		process.env.CODEX_ACCOUNTS = JSON.stringify(mockAccounts);
		
		const labels = getAllLabels();
		expect(labels).toContain("dedup-test-1");
		expect(labels).toContain("dedup-test-2");
	});
});
