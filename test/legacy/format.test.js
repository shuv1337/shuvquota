/**
 * Legacy format, display, CLI constants, and metadata tests migrated from shuvquota.test.js
 * Run with: bun test test/legacy/format.test.js
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
	PRIMARY_CMD,
	USAGE_URL,
	RESET_CREDITS_URL,
	REMOVED_NAMESPACES,
	REMOVED_NAMESPACE_EXIT_CODE,
	V1_COMPAT_COMMAND,
} from "../../lib/constants.js";

import {
	fetchResetCredits,
	fetchUsage,
	mergeResetCredits,
} from "../../lib/codex-usage.js";

import {
	formatBankedResetExpiration,
	formatExpiryStatus,
	formatRemovedNamespaceError,
	formatTokenCount,
	normalizePercentUsed,
	parseBankedResetCredits,
	parseClaudeUtilizationWindow,
	shortenPath,
	formatPercent,
	formatClaudePercentLeft,
	parseWindow,
	isCodexWeeklyWindow,
	formatResetTime,
	formatResetAt,
	formatGrokPeriodReset,
	formatAntigravityReset,
} from "../../lib/display.js";

import {
	buildChecks,
	checkFilesArrayExists,
	checkPackageName,
	checkRequiredFiles,
} from "../../scripts/preflight.js";

// ─────────────────────────────────────────────────────────────────────────────
// CLI constants tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PRIMARY_CMD constant", () => {
	test("equals 'shuvquota'", () => {
		expect(PRIMARY_CMD).toBe("shuvquota");
	});

	test("Codex usage endpoints point to the wham backend", () => {
		expect(USAGE_URL).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(RESET_CREDITS_URL).toBe(
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
		);
	});
});

describe("Codex banked reset usage", () => {
	test("mergeResetCredits preserves the usage summary and adds credit details", () => {
		const usage = {
			rate_limit_reset_credits: { available_count: 2, resets_to_redeem: 1 },
		};
		const details = {
			available_count: 2,
			total_earned_count: 4,
			credits: [{ id: "credit_1", expires_at: "2026-07-27T12:00:00Z" }],
		};

		expect(mergeResetCredits(usage, details)).toEqual({
			rate_limit_reset_credits: {
				available_count: 2,
				resets_to_redeem: 1,
				total_earned_count: 4,
				credits: details.credits,
			},
		});
	});

	test("fetchResetCredits sends the required Codex Desktop headers", async () => {
		const originalFetch = globalThis.fetch;
		let request;
		globalThis.fetch = async (url, options) => {
			request = { url, options };
			return {
				ok: true,
				json: async () => ({ available_count: 0, credits: [] }),
			};
		};

		try {
			await fetchResetCredits({ access: "token", accountId: "acct_1" });
			expect(request.url).toBe(RESET_CREDITS_URL);
			expect(request.options.headers.Authorization).toBe("Bearer token");
			expect(request.options.headers["OpenAI-Beta"]).toBe("codex-1");
			expect(request.options.headers.originator).toBe("Codex Desktop");
			expect(request.options.headers["chatgpt-account-id"]).toBe("acct_1");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("fetchUsage enriches quota usage and tolerates reset-credit failures", async () => {
		const originalFetch = globalThis.fetch;
		let resetCreditsShouldFail = false;
		globalThis.fetch = async url => {
			if (url === RESET_CREDITS_URL) {
				return resetCreditsShouldFail
					? { ok: false, status: 403 }
					: {
							ok: true,
							json: async () => ({
								available_count: 1,
								credits: [{ expires_at: "2026-07-27T12:00:00Z" }],
							}),
						};
			}
			expect(url).toBe(USAGE_URL);
			return {
				ok: true,
				json: async () => ({
					plan_type: "pro",
					rate_limit_reset_credits: { available_count: 1 },
				}),
			};
		};

		try {
			const enriched = await fetchUsage({ access: "token", accountId: "acct_1" });
			expect(enriched.rate_limit_reset_credits.credits).toHaveLength(1);

			resetCreditsShouldFail = true;
			const fallback = await fetchUsage({ access: "token", accountId: "acct_1" });
			expect(fallback.plan_type).toBe("pro");
			expect(fallback.rate_limit_reset_credits).toEqual({ available_count: 1 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Removed-namespace guard (v2 Phase 1)
// ─────────────────────────────────────────────────────────────────────────────

describe("removed namespace guard", () => {
	test("REMOVED_NAMESPACES lists exactly the dropped providers", () => {
		expect([...REMOVED_NAMESPACES].sort()).toEqual(["factory", "opencode-go", "synthetic"]);
		expect(REMOVED_NAMESPACE_EXIT_CODE).toBe(2);
		expect(V1_COMPAT_COMMAND).toBe("npx shuvquota@1");
	});

	test("formatRemovedNamespaceError names the namespace and the v1 invocation", () => {
		expect(formatRemovedNamespaceError("factory")).toBe(
			`Error: '${PRIMARY_CMD} factory' was removed in v2. Use '${V1_COMPAT_COMMAND} factory' instead.`
		);
		expect(formatRemovedNamespaceError("synthetic", ["remove", "default"])).toBe(
			`Error: '${PRIMARY_CMD} synthetic' was removed in v2. Use '${V1_COMPAT_COMMAND} synthetic remove default' instead.`
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// package.json metadata validation tests
// ─────────────────────────────────────────────────────────────────────────────

describe("package.json metadata", () => {
	let pkg;

	beforeEach(() => {
		pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf-8"));
	});

	test("has name equal to 'shuvquota'", () => {
		expect(pkg.name).toBe("shuvquota");
	});

	test("has files array defined", () => {
		expect(Array.isArray(pkg.files)).toBe(true);
	});

	test("files array includes 'shuvquota.js'", () => {
		expect(pkg.files).toContain("shuvquota.js");
	});

	test("files array includes the shuvquota PWA", () => {
		expect(pkg.files).toContain("shuvquota-server.js");
		expect(pkg.files).toContain("web/");
	});

	test("files array includes 'README.md'", () => {
		expect(pkg.files).toContain("README.md");
	});

	test("bin includes 'shuvquota' command", () => {
		expect(pkg.bin).toHaveProperty("shuvquota");
		expect(pkg.bin["shuvquota"]).toBe("./shuvquota.js");
	});

	test("bin includes 'cq' alias", () => {
		expect(pkg.bin).toHaveProperty("cq");
		expect(pkg.bin["cq"]).toBe("./shuvquota.js");
	});

	test("bin includes 'sq' alias", () => {
		expect(pkg.bin).toHaveProperty("sq");
		expect(pkg.bin["sq"]).toBe("./shuvquota.js");
	});

	test("bin includes 'shuvquota-server' app command", () => {
		expect(pkg.bin).toHaveProperty("shuvquota-server");
		expect(pkg.bin["shuvquota-server"]).toBe("./shuvquota-server.js");
	});

	test("has repository field", () => {
		expect(pkg.repository).toBeDefined();
		expect(pkg.repository.type).toBe("git");
		expect(pkg.repository.url).toContain("github.com");
	});

	test("has engines.node >= 18", () => {
		expect(pkg.engines).toBeDefined();
		expect(pkg.engines.node).toBeDefined();
		const nodeVersion = pkg.engines.node;
		const match = nodeVersion.match(/>=?\s*(\d+)/);
		expect(match).not.toBeNull();
		expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(18);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CI workflow tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CI workflow", () => {
	const workflowPath = join(import.meta.dir, "../../.github", "workflows", "ci.yml");
	let workflow;

	beforeEach(() => {
		workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf-8") : "";
	});

	test("ci workflow file exists", () => {
		expect(existsSync(workflowPath)).toBe(true);
	});

	test("workflow triggers on push", () => {
		expect(workflow).toContain("push:");
	});

	test("workflow triggers on pull_request", () => {
		expect(workflow).toContain("pull_request:");
	});

	test("workflow runs bun test", () => {
		expect(workflow).toContain("bun test");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Preflight checks tests
// ─────────────────────────────────────────────────────────────────────────────

describe("preflight checks", () => {
	test("fails if name is not shuvquota", () => {
		const result = checkPackageName({ name: "wrong-name" });
		expect(result.pass).toBe(false);
		expect(result.message).toContain("expected 'shuvquota'");
	});

	test("fails if files array is missing", () => {
		const result = checkFilesArrayExists({});
		expect(result.pass).toBe(false);
		expect(result.message).toContain("missing files array");
	});

	test("fails if required files are missing", () => {
		const result = checkRequiredFiles({ files: ["README.md"] });
		expect(result.pass).toBe(false);
		expect(result.message).toContain("shuvquota.js");
		expect(result.message).toContain("shuvquota-server.js");
		expect(result.message).toContain("web/");
		expect(result.message).toContain("LICENSE");
	});

	test("passes with correct configuration", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf-8"));
		const checks = buildChecks(pkg, { skipGit: true });
		const allPass = checks.every(check => check.pass);
		expect(allPass).toBe(true);
	});

	test("returns clear error messages", () => {
		const result = checkPackageName({ name: "broken" });
		expect(result.message).toContain("package.json name is");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// formatExpiryStatus tests (for list command)
// ─────────────────────────────────────────────────────────────────────────────

describe("formatExpiryStatus", () => {
	test("returns 'Unknown' for undefined expires", () => {
		const result = formatExpiryStatus(undefined);
		expect(result.status).toBe("unknown");
		expect(result.display).toBe("Unknown");
	});

	test("returns 'Unknown' for null expires", () => {
		const result = formatExpiryStatus(null);
		expect(result.status).toBe("unknown");
		expect(result.display).toBe("Unknown");
	});

	test("returns 'Expired' for past timestamp", () => {
		const pastTime = Date.now() - 10000;
		const result = formatExpiryStatus(pastTime);
		expect(result.status).toBe("expired");
		expect(result.display).toBe("Expired");
	});

	test("returns 'expiring' status for token expiring within 5 minutes", () => {
		const expiringTime = Date.now() + 3 * 60 * 1000;
		const result = formatExpiryStatus(expiringTime);
		expect(result.status).toBe("expiring");
		expect(result.display).toMatch(/^Expiring in \d+m$/);
	});

	test("returns 'valid' status with minutes format for <1 hour", () => {
		const futureTime = Date.now() + 30 * 60 * 1000;
		const result = formatExpiryStatus(futureTime);
		expect(result.status).toBe("valid");
		expect(result.display).toMatch(/^\d+m$/);
	});

	test("returns 'valid' status with hours and minutes format for <24 hours", () => {
		const futureTime = Date.now() + 5 * 60 * 60 * 1000;
		const result = formatExpiryStatus(futureTime);
		expect(result.status).toBe("valid");
		expect(result.display).toMatch(/^\d+h \d+m$/);
	});

	test("returns 'valid' status with days and hours format for >24 hours", () => {
		const futureTime = Date.now() + 48 * 60 * 60 * 1000;
		const result = formatExpiryStatus(futureTime);
		expect(result.status).toBe("valid");
		expect(result.display).toMatch(/^\d+d \d+h$/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude utilization parsing tests
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizePercentUsed", () => {
	test("treats integer 1 as 1% used (not 100%)", () => {
		expect(normalizePercentUsed(1)).toBe(1);
	});

	test("converts legacy fractional values in (0, 1) to percentage points", () => {
		expect(normalizePercentUsed(0.1)).toBe(10);
	});
});

describe("parseClaudeUtilizationWindow", () => {
	test("returns 99% remaining for utilization=1", () => {
		const parsed = parseClaudeUtilizationWindow({ utilization: 1 });
		expect(parsed.remaining).toBe(99);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// shortenPath tests
// ─────────────────────────────────────────────────────────────────────────────

describe("shortenPath", () => {
	test("replaces home directory with ~", () => {
		const home = homedir();
		const result = shortenPath(join(home, ".codex-accounts.json"));
		expect(result).toBe("~/.codex-accounts.json");
	});

	test("replaces home directory with ~ for nested paths", () => {
		const home = homedir();
		const result = shortenPath(join(home, ".codex", "auth.json"));
		expect(result).toBe("~/.codex/auth.json");
	});

	test("returns original path if not under home directory", () => {
		const result = shortenPath("/tmp/test-accounts.json");
		expect(result).toBe("/tmp/test-accounts.json");
	});

	test("handles paths without home directory prefix", () => {
		const result = shortenPath("/etc/config.json");
		expect(result).toBe("/etc/config.json");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// formatTokenCount tests
// ─────────────────────────────────────────────────────────────────────────────

describe("formatTokenCount", () => {
	test("formats small numbers without commas", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(1)).toBe("1");
		expect(formatTokenCount(999)).toBe("999");
	});

	test("formats thousands with commas", () => {
		expect(formatTokenCount(1000)).toBe("1,000");
		expect(formatTokenCount(12345)).toBe("12,345");
		expect(formatTokenCount(999999)).toBe("999,999");
	});

	test("formats millions with commas", () => {
		expect(formatTokenCount(1000000)).toBe("1,000,000");
		expect(formatTokenCount(5000000)).toBe("5,000,000");
		expect(formatTokenCount(20000000)).toBe("20,000,000");
	});

	test("formats large numbers (200M)", () => {
		expect(formatTokenCount(200000000)).toBe("200,000,000");
	});

	test("returns '0' for null input", () => {
		expect(formatTokenCount(null)).toBe("0");
	});

	test("returns '0' for undefined input", () => {
		expect(formatTokenCount(undefined)).toBe("0");
	});

	test("returns '0' for NaN input", () => {
		expect(formatTokenCount(NaN)).toBe("0");
	});

	test("handles negative numbers", () => {
		expect(formatTokenCount(-1000)).toBe("-1,000");
	});

	test("truncates decimal values", () => {
		expect(formatTokenCount(1234.56)).toBe("1,234");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit display and format helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("display formatting helpers", () => {
	test("parseBankedResetCredits extracts counts and credit array", () => {
		const payload = {
			rate_limit_reset_credits: {
				available_count: 2,
				credits: [
					{ expires_at: "2026-07-27T12:34:56Z" },
					{ expires_at: "2026-08-12T12:34:56Z" },
				],
			},
		};
		expect(parseBankedResetCredits(payload)).toEqual({
			availableCount: 2,
			credits: payload.rate_limit_reset_credits.credits,
		});
		expect(parseBankedResetCredits(null)).toBeNull();
	});

	test("formatBankedResetExpiration formats dates or returns 'not set'", () => {
		expect(formatBankedResetExpiration(null)).toBe("not set");
		expect(formatBankedResetExpiration("invalid")).toBe("not set");
		const formatted = formatBankedResetExpiration("2026-07-27T12:00:00Z");
		expect(formatted).toContain("2026");
		expect(formatted).toContain("Jul");
	});

	test("formatPercent and formatClaudePercentLeft", () => {
		expect(formatPercent(undefined, 84)).toBe("84% left");
		expect(formatPercent(20, undefined)).toBe("80% left");
		expect(formatPercent(undefined, undefined)).toBeNull();

		expect(formatClaudePercentLeft(90)).toBe("90% left");
		expect(formatClaudePercentLeft(null)).toBe("?");
		expect(formatClaudePercentLeft(undefined)).toBe("?");
	});

	test("parseWindow projects window properties", () => {
		expect(parseWindow(null)).toBeNull();
		const window = {
			remaining_percent: 75,
			limit_window_seconds: 604800,
			reset_after_seconds: 3600,
		};
		const parsed = parseWindow(window);
		expect(parsed.remaining).toBe(75);
		expect(parsed.limitWindowSeconds).toBe(604800);
		expect(parsed.resetAfterSeconds).toBe(3600);
		expect(isCodexWeeklyWindow(parsed)).toBe(true);
	});

	test("formatResetTime and formatResetAt", () => {
		expect(formatResetTime(null)).toBe("");
		expect(formatResetTime(0)).toBe("");
		expect(formatResetTime(1800, "compact")).toBeDefined();
		expect(formatResetTime(1800, "inline")).toContain("resets");
		expect(formatResetTime(1800, "parentheses")).toContain("resets in");

		expect(formatResetAt(null)).toBe("");
		expect(formatResetAt("invalid-date")).toBe("");
		const future = new Date(Date.now() + 3600 * 1000).toISOString();
		expect(formatResetAt(future)).toContain("resets");
	});

	test("formatGrokPeriodReset and formatAntigravityReset", () => {
		expect(formatGrokPeriodReset(null)).toBe("");
		expect(formatGrokPeriodReset("invalid")).toBe("");
		const grokFuture = new Date(Date.now() + 7200 * 1000).toISOString();
		expect(formatGrokPeriodReset(grokFuture)).toContain("resets");

		expect(formatAntigravityReset(null)).toBe("");
		expect(formatAntigravityReset("invalid")).toBe("");
		const agFuture = new Date(Date.now() + 7200 * 1000).toISOString();
		expect(formatAntigravityReset(agFuture)).toContain("resets");
	});
});
