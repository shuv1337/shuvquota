/**
 * Tests for the shared v2 quota snapshot model.
 * Run with: bun test test/snapshot.test.js
 */

import { describe, expect, test } from "bun:test";
import {
	ACCOUNT_NORMALIZERS,
	ACCOUNT_STATUSES,
	PROVIDER_ORDER,
	SNAPSHOT_SCHEMA_VERSION,
	buildProviderSnapshot,
	buildSnapshot,
	coerceAccountSnapshot,
	createErrorAccountSnapshot,
	createLoadingAccountSnapshot,
	defaultProviderName,
	maskEmail,
	normalizeAntigravityAccount,
	normalizeClaudeAccount,
	normalizeCodexAccount,
	normalizeGenericAccount,
	normalizeGrokAccount,
	normalizeWindowValues,
	redactPublicText,
	safePublicError,
	sanitizeErrorText,
	sanitizeText,
	toDisplaySnapshot,
	toPublicSnapshot,
} from "../lib/snapshot.js";

const NOW = new Date("2026-01-10T00:00:00.000Z");

/** @param {object} snapshot */
function windowById(snapshot, id) {
	return snapshot.windows.find(window => window.id === id);
}

describe("text sanitization", () => {
	test("strips control characters, markup, and collapses whitespace", () => {
		expect(sanitizeText("  work\u0000\u001b <b>laptop</b>\n\n2  ")).toBe("work blaptop/b 2");
	});

	test("returns null for non-strings and for text that sanitizes to empty", () => {
		expect(sanitizeText(42)).toBeNull();
		expect(sanitizeText("   ")).toBeNull();
		expect(sanitizeText("<<<>>>")).toBeNull();
	});

	test("truncates to the requested length", () => {
		expect(sanitizeText("A".repeat(300), 60)).toHaveLength(60);
	});
});

describe("maskEmail", () => {
	test("keeps one leading character and the domain", () => {
		expect(maskEmail("ada.lovelace@example.com")).toBe("a***@example.com");
	});

	test("lowercases the domain but never reveals the local part", () => {
		expect(maskEmail("Ada@Example.COM")).toBe("A***@example.com");
	});

	test("drops values that are not plausibly addresses", () => {
		expect(maskEmail("not-an-email")).toBeNull();
		expect(maskEmail("@example.com")).toBeNull();
		expect(maskEmail("ada@")).toBeNull();
		expect(maskEmail("ada@localhost")).toBeNull();
		expect(maskEmail(null)).toBeNull();
	});
});

describe("redactPublicText", () => {
	test.each([
		["absolute POSIX path", "failed reading /home/shuv/.codex/auth.json", "failed reading [redacted]"],
		["home-relative path", "see ~/.claude/.credentials.json now", "see [redacted] now"],
		["windows path", "at C:\\Users\\shuv\\creds.json here", "at [redacted] here"],
		["url", "posted to https://api.example.com/v1/usage?key=abc", "posted to [redacted]"],
		["email", "owner ada.lovelace@example.com failed", "owner [redacted] failed"],
		["opaque token", "bearer sk_" + "live_abcdefghijklmnopqrstuvwx rejected", "bearer [redacted] rejected"],
	])("redacts %s", (_name, input, expected) => {
		expect(redactPublicText(input)).toBe(expected);
	});

	test("redacts a JWT", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
		expect(redactPublicText(`token ${jwt}`)).toBe("token [redacted]");
	});

	test("collapses adjacent redactions instead of emitting a wall of placeholders", () => {
		const text = "/home/a/b /home/c/d /home/e/f";
		expect(redactPublicText(text)).toBe("[redacted]");
	});

	test("leaves benign text intact", () => {
		expect(redactPublicText("Session 5h")).toBe("Session 5h");
		expect(redactPublicText("Weekly (all models)")).toBe("Weekly (all models)");
	});

	test("truncates after redacting", () => {
		expect(redactPublicText("limit ".repeat(40), 40)).toHaveLength(40);
	});

	test("treats one long unbroken run as an opaque token", () => {
		expect(redactPublicText("A".repeat(200), 40)).toBe("[redacted]");
	});
});

describe("safePublicError", () => {
	test.each([
		["Request timed out after 60000ms", "Quota request timed out"],
		["The operation was aborted", "Quota request timed out"],
		["HTTP 401 Unauthorized", "Authentication required"],
		["refresh token expired", "Authentication required"],
		["no accounts configured", "No accounts found"],
		["HTTP 503 from upstream", "Quota service returned HTTP 503"],
		["kaboom", "Quota data unavailable"],
	])("collapses %s", (input, expected) => {
		expect(safePublicError(input)).toBe(expected);
	});

	test("returns null for absent errors", () => {
		expect(safePublicError(null)).toBeNull();
		expect(safePublicError("")).toBeNull();
	});
});

describe("sanitizeErrorText", () => {
	test("keeps internal errors specific but strips paths and tokens", () => {
		const message = "ENOENT reading /home/shuv/.codex/auth.json";
		expect(sanitizeErrorText(message)).toBe("ENOENT reading [redacted]");
	});

	test("accepts Error instances", () => {
		expect(sanitizeErrorText(new Error("upstream exploded"))).toBe("upstream exploded");
	});

	test("returns null when there is no error", () => {
		expect(sanitizeErrorText(null)).toBeNull();
		expect(sanitizeErrorText(undefined)).toBeNull();
	});
});

describe("normalizeWindowValues", () => {
	test("derives the missing side of the percent pair", () => {
		expect(normalizeWindowValues({ used_percent: 30 }, NOW)).toMatchObject({
			percentUsed: 30,
			percentRemaining: 70,
		});
		expect(normalizeWindowValues({ remaining_percent: 10 }, NOW)).toMatchObject({
			percentUsed: 90,
			percentRemaining: 10,
		});
	});

	test("treats sub-1 Claude values as ratios only in claude mode", () => {
		expect(normalizeWindowValues({ utilization: 0.45 }, NOW, { claude: true }).percentUsed).toBe(45);
		expect(normalizeWindowValues({ utilization: 0.45 }, NOW).percentUsed).toBe(0.45);
	});

	test("resolves relative resets against the supplied clock", () => {
		const values = normalizeWindowValues({ used_percent: 1, reset_after_seconds: 3600 }, NOW);
		expect(values.resetsAt).toBe("2026-01-10T01:00:00.000Z");
	});

	test("falls back to the default window length when none is reported", () => {
		const values = normalizeWindowValues({ used_percent: 1 }, NOW, { defaultWindowSeconds: 18000 });
		expect(values.windowSeconds).toBe(18000);
	});

	test("returns null when no percentage can be established", () => {
		expect(normalizeWindowValues({ reset_after_seconds: 60 }, NOW)).toBeNull();
		expect(normalizeWindowValues(null, NOW)).toBeNull();
	});
});

describe("normalizeCodexAccount", () => {
	const account = { label: "work", email: "ada@example.com" };
	const result = {
		usage: {
			usage: {
				plan_type: "pro",
				rate_limit: {
					primary_window: {
						used_percent: 30,
						limit_window_seconds: 18000,
						reset_after_seconds: 3600,
					},
					secondary_window: { used_percent: 90, limit_window_seconds: 604800 },
				},
				rate_limit_reset_credits: {
					available_count: 2,
					credits: [
						{ expires_at: "2026-02-05T00:00:00.000Z" },
						{ expires_at: "2026-02-01T00:00:00.000Z" },
					],
				},
			},
		},
	};

	test("retains both raw window metrics and the reset instant", () => {
		const snapshot = normalizeCodexAccount(account, result, NOW);
		expect(windowById(snapshot, "session")).toEqual({
			id: "session",
			label: "Session",
			percentUsed: 30,
			percentRemaining: 70,
			resetsAt: "2026-01-10T01:00:00.000Z",
			windowSeconds: 18000,
		});
		expect(windowById(snapshot, "weekly")).toMatchObject({
			percentUsed: 90,
			percentRemaining: 10,
			windowSeconds: 604800,
		});
	});

	test("a low window is still a successful account", () => {
		const snapshot = normalizeCodexAccount(account, result, NOW);
		expect(snapshot.plan).toBe("Pro");
		expect(snapshot.status).toBe("ok");
		expect(snapshot.error).toBeNull();
		// Severity is the renderer's job, computed from this number.
		expect(windowById(snapshot, "weekly").percentRemaining).toBe(10);
	});

	test("keeps the full email internally", () => {
		expect(normalizeCodexAccount(account, result, NOW).email).toBe("ada@example.com");
	});

	test("surfaces banked resets as extras with the earliest expiry", () => {
		const snapshot = normalizeCodexAccount(account, result, NOW);
		expect(snapshot.extras).toEqual([
			{ id: "banked-resets", label: "Banked resets", value: "2" },
			{ id: "banked-expires", label: "Next banked expiry", value: "2026-02-01T00:00:00.000Z" },
		]);
	});

	test("re-ids a weekly-length primary window so it is not mislabelled Session", () => {
		const weeklyPrimary = {
			usage: { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } } },
		};
		const snapshot = normalizeCodexAccount(account, weeklyPrimary, NOW);
		expect(snapshot.windows.map(window => window.id)).toEqual(["weekly"]);
		expect(snapshot.windows[0].label).toBe("Weekly");
	});

	test("reports an error when a usage payload yields no parseable window", () => {
		const snapshot = normalizeCodexAccount(account, { usage: { rate_limit: {} } }, NOW);
		expect(snapshot.status).toBe("error");
		expect(snapshot.error).toBe("Quota data unavailable");
	});

	test("reports error status for a hard failure", () => {
		const snapshot = normalizeCodexAccount(account, { error: "HTTP 401 Unauthorized" }, NOW);
		expect(snapshot.status).toBe("error");
		expect(snapshot.error).toBe("HTTP 401 Unauthorized");
		expect(snapshot.windows).toEqual([]);
	});

	test("falls back to a positional label", () => {
		expect(normalizeCodexAccount({}, {}, NOW, { index: 2 }).label).toBe("Account 3");
	});
});

describe("normalizeClaudeAccount", () => {
	test("normalizes legacy ratio windows with their default lengths", () => {
		const snapshot = normalizeClaudeAccount(
			{ label: "personal" },
			{
				usage: { five_hour: { utilization: 0.2 }, seven_day: { utilization: 50 } },
				account: { email: "ada@example.com" },
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_20x",
			},
			NOW,
		);
		expect(windowById(snapshot, "session")).toMatchObject({
			percentUsed: 20,
			percentRemaining: 80,
			windowSeconds: 18000,
		});
		expect(windowById(snapshot, "weekly")).toMatchObject({
			percentUsed: 50,
			windowSeconds: 604800,
		});
		expect(snapshot.plan).toBe("Max 20x");
		expect(snapshot.email).toBe("ada@example.com");
		expect(snapshot.status).toBe("ok");
	});

	test("names scoped limits from the model display name", () => {
		const snapshot = normalizeClaudeAccount(
			{ label: "work" },
			{
				usage: {
					limits: [
						{ kind: "weekly_scoped", group: "weekly", scope: { model: { display_name: "opus" } }, utilization: 10 },
					],
				},
			},
			NOW,
		);
		expect(snapshot.windows[0]).toMatchObject({
			id: "opus-weekly",
			label: "Opus weekly",
			percentUsed: 10,
			windowSeconds: 604800,
		});
	});

	test("keeps a usable status when only part of the data failed", () => {
		const snapshot = normalizeClaudeAccount(
			{ label: "work" },
			{ usage: { five_hour: { utilization: 10 } }, errors: { weekly: "upstream 500" } },
			NOW,
		);
		expect(snapshot.status).toBe("ok");
		expect(snapshot.error).toBe("Some quota data is unavailable");
		expect(snapshot.windows).toHaveLength(1);
	});

	test("treats success:false as a hard error", () => {
		const snapshot = normalizeClaudeAccount({ label: "work" }, { success: false }, NOW);
		expect(snapshot.status).toBe("error");
		expect(snapshot.error).toBe("Quota data unavailable");
	});
});

describe("normalizeGrokAccount", () => {
	const result = {
		tier: 5,
		usage: {
			creditUsagePercent: 25,
			period: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T00:00:00.000Z" },
			products: [{ product: "grok_code", usagePercent: 95 }],
		},
	};

	test("derives the period length and applies it to every window", () => {
		const snapshot = normalizeGrokAccount({ label: "main" }, result, NOW);
		expect(windowById(snapshot, "credits")).toEqual({
			id: "credits",
			label: "Credits",
			percentUsed: 25,
			percentRemaining: 75,
			resetsAt: "2026-01-31T00:00:00.000Z",
			windowSeconds: 2592000,
		});
		expect(windowById(snapshot, "product-grok-code")).toMatchObject({
			label: "Grok Code",
			percentUsed: 95,
			percentRemaining: 5,
		});
	});

	test("labels the tier and keeps a nearly exhausted product window ok", () => {
		const snapshot = normalizeGrokAccount({ label: "main" }, result, NOW);
		expect(snapshot.plan).toBe("SuperGrok Heavy");
		expect(snapshot.status).toBe("ok");
		expect(windowById(snapshot, "product-grok-code").percentRemaining).toBe(5);
	});

	test("converts a fetch error into an error account", () => {
		const snapshot = normalizeGrokAccount({ label: "main" }, { error: "HTTP 500" }, NOW);
		expect(snapshot.status).toBe("error");
		expect(snapshot.error).toBe("HTTP 500");
	});
});

describe("normalizeAntigravityAccount", () => {
	const result = {
		paidTier: "g1-pro-tier",
		usage: {
			groups: [
				{
					id: "gemini",
					displayName: "Gemini Models",
					buckets: [
						{ bucketId: "5h", window: "5h", remainingFraction: 0.62, resetTime: "2026-01-10T05:00:00.000Z" },
						{ bucketId: "weekly", window: "weekly", percentRemaining: 15 },
					],
				},
			],
		},
	};

	test("keeps both bucket forms and their window lengths", () => {
		const snapshot = normalizeAntigravityAccount({ label: "google" }, result, NOW);
		expect(windowById(snapshot, "gemini-5h")).toEqual({
			id: "gemini-5h",
			label: "5h",
			percentUsed: 38,
			percentRemaining: 62,
			resetsAt: "2026-01-10T05:00:00.000Z",
			windowSeconds: 18000,
		});
		expect(windowById(snapshot, "gemini-weekly")).toMatchObject({
			label: "Weekly",
			percentRemaining: 15,
			windowSeconds: 604800,
		});
	});

	test("maps the paid tier to its product name", () => {
		expect(normalizeAntigravityAccount({}, result, NOW).plan).toBe("Google AI Pro");
		expect(normalizeAntigravityAccount({}, { paidTier: "free" }, NOW).plan).toBe("free");
	});

	test("prefixes non-Gemini groups with the group name", () => {
		const snapshot = normalizeAntigravityAccount(
			{},
			{ usage: { groups: [{ id: "claude", displayName: "claude_models", buckets: [{ bucketId: "5h", window: "5h", percentRemaining: 50 }] }] } },
			NOW,
		);
		expect(snapshot.windows[0].label).toBe("Claude Models 5h");
	});
});

describe("normalizeGenericAccount", () => {
	test("reads a plain window list and keeps the supplied detail", () => {
		const snapshot = normalizeGenericAccount(
			{ label: "other" },
			{ usage: { windows: [{ id: "session", label: "Session", used_percent: 40, detail: "2 / 5 requests" }] } },
			NOW,
		);
		expect(snapshot.windows[0]).toMatchObject({
			id: "session",
			label: "Session",
			percentRemaining: 60,
			detail: "2 / 5 requests",
		});
	});
});

describe("ACCOUNT_NORMALIZERS", () => {
	test("covers every ordered provider", () => {
		expect(Object.keys(ACCOUNT_NORMALIZERS).sort()).toEqual([...PROVIDER_ORDER].sort());
	});

	test("names providers for display", () => {
		expect(defaultProviderName("codex")).toBe("Codex");
		expect(defaultProviderName("grok")).toBe("SuperGrok");
		expect(defaultProviderName("some_vendor")).toBe("Some Vendor");
	});
});

describe("coerceAccountSnapshot", () => {
	test("rebuilds from an allowlist and drops everything else", () => {
		const coerced = coerceAccountSnapshot({
			label: "work",
			email: "ada@example.com",
			plan: "Pro",
			status: "ok",
			windows: [{ id: "session", label: "Session", percentRemaining: 40, accessToken: "sk_" + "live_x" }],
			extras: [{ label: "Banked", value: "2", secret: "nope" }],
			accessToken: "sk_" + "live_abcdefghijklmnopqrstuvwx",
			credentialsPath: "/home/shuv/.codex/auth.json",
			accountId: "acct_12345",
		});
		expect(Object.keys(coerced).sort()).toEqual(
			["email", "error", "extras", "label", "plan", "status", "windows"],
		);
		expect(Object.keys(coerced.windows[0]).sort()).toEqual(
			["id", "label", "percentRemaining", "percentUsed", "resetsAt", "windowSeconds"],
		);
		expect(Object.keys(coerced.extras[0]).sort()).toEqual(["id", "label", "value"]);
		expect(JSON.stringify(coerced)).not.toContain("sk_live");
		expect(JSON.stringify(coerced)).not.toContain("acct_12345");
		expect(JSON.stringify(coerced)).not.toContain("/home/shuv");
	});

	test("derives the percent pair and keeps a nearly exhausted window ok", () => {
		const coerced = coerceAccountSnapshot({ windows: [{ id: "session", percentUsed: 85 }] });
		expect(coerced.windows[0].percentRemaining).toBe(15);
		expect(coerced.status).toBe("ok");
	});

	test("rejects an out-of-enum status", () => {
		const coerced = coerceAccountSnapshot({
			status: "catastrophe",
			windows: [{ id: "session", percentRemaining: 50 }],
		});
		expect(coerced.status).toBe("ok");
	});

	test("an account with no window is an error with a safe message", () => {
		expect(coerceAccountSnapshot({ status: "ok", windows: [] })).toMatchObject({
			status: "error",
			error: "Quota data unavailable",
		});
	});

	test("never leaves a finished account pinned in loading", () => {
		expect(coerceAccountSnapshot({ status: "loading", windows: [] }).status).toBe("error");
		expect(
			coerceAccountSnapshot({ status: "loading", windows: [] }, { allowLoading: true }).status,
		).toBe("loading");
	});

	test("preserves a non-error status reported alongside a partial error", () => {
		const coerced = coerceAccountSnapshot({
			status: "ok",
			error: "Some quota data is unavailable",
			windows: [{ id: "session", percentRemaining: 90 }],
		});
		expect(coerced.status).toBe("ok");
		expect(coerced.error).toBe("Some quota data is unavailable");
	});

	test("falls back to the discovered account for identity fields", () => {
		const coerced = coerceAccountSnapshot({}, { account: { label: "work", email: "ada@example.com" } });
		expect(coerced.label).toBe("work");
		expect(coerced.email).toBe("ada@example.com");
	});

	test("tolerates junk input", () => {
		expect(coerceAccountSnapshot("not an object", { index: 0 })).toMatchObject({
			label: "Account 1",
			status: "error",
			error: "Quota data unavailable",
			windows: [],
		});
	});
});

describe("skeleton and error accounts", () => {
	test("loading accounts carry identity but no data", () => {
		expect(createLoadingAccountSnapshot({ label: "work", email: "ada@example.com" })).toEqual({
			label: "work",
			email: "ada@example.com",
			plan: null,
			status: "loading",
			error: null,
			windows: [],
			extras: [],
		});
	});

	test("error accounts redact the failure text", () => {
		const snapshot = createErrorAccountSnapshot(
			{ label: "work" },
			new Error("ENOENT /home/shuv/.codex/auth.json"),
		);
		expect(snapshot.status).toBe("error");
		expect(snapshot.error).toBe("ENOENT [redacted]");
	});

	test("error accounts always have a message", () => {
		expect(createErrorAccountSnapshot({}, null).error).toBe("Quota data unavailable");
	});
});

describe("buildSnapshot", () => {
	const providers = [
		{
			id: "codex",
			accounts: [
				{ label: "work", status: "ok", windows: [{ id: "session", percentRemaining: 90 }] },
				{ label: "side", status: "ok", windows: [{ id: "session", percentRemaining: 5 }] },
			],
		},
		{ id: "claude", accounts: [{ label: "personal", error: "boom" }], loading: true },
	];

	test("stamps the schema version and summarizes the tree", () => {
		const snapshot = buildSnapshot(providers, {
			startedAt: NOW,
			generatedAt: NOW,
			complete: true,
		});
		expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
		expect(SNAPSHOT_SCHEMA_VERSION).toBe(2);
		expect(snapshot.summary).toEqual({
			providerCount: 2,
			accountCount: 3,
			loadingCount: 0,
			okCount: 2,
			errorCount: 1,
		});
	});

	test("counts a nearly exhausted account as successful", () => {
		const snapshot = buildSnapshot(providers, { complete: true });
		const low = snapshot.providers[0].accounts.find(account => account.label === "side");
		expect(low.status).toBe("ok");
		expect(low.windows[0].percentRemaining).toBe(5);
		expect(snapshot.summary.okCount).toBe(2);
	});

	test("refuses to stamp generatedAt on an incomplete frame", () => {
		const frame = buildSnapshot(providers, { startedAt: NOW, generatedAt: NOW, complete: false });
		expect(frame.complete).toBe(false);
		expect(frame.generatedAt).toBeNull();
		expect(frame.startedAt).toBe(NOW.toISOString());
	});

	test("defaults provider names from the id", () => {
		expect(buildProviderSnapshot({ id: "grok" }).name).toBe("SuperGrok");
		expect(buildProviderSnapshot({ id: "grok", name: "Custom" }).name).toBe("Custom");
	});

	test("counts loading accounts only when skeletons are allowed through", () => {
		const input = [{ id: "codex", accounts: [createLoadingAccountSnapshot({ label: "work" })] }];
		expect(buildSnapshot(input, { allowLoading: true }).summary.loadingCount).toBe(1);
		expect(buildSnapshot(input).summary.loadingCount).toBe(0);
	});

	test("tolerates junk providers", () => {
		expect(buildSnapshot(null).providers).toEqual([]);
		expect(buildSnapshot(["nope"]).providers[0].accounts).toEqual([]);
	});
});

describe("toPublicSnapshot", () => {
	/** @returns {object} */
	function hostileSnapshot() {
		return buildSnapshot(
			[
				{
					id: "codex",
					name: "Codex",
					accounts: [
						{
							label: "ada.lovelace@example.com on /home/shuv/work",
							email: "ada.lovelace@example.com",
							plan: "Pro /home/shuv/plan.json",
							status: "error",
							error: "HTTP 401 refreshing /home/shuv/.codex/auth.json with sk_" + "live_abcdefghijklmnopqrstuvwx",
							windows: [
								{
									id: "session",
									label: "Session /home/shuv/x",
									percentRemaining: 40,
									resetsAt: "2026-01-10T05:00:00.000Z",
									windowSeconds: 18000,
									detail: "token sk_" + "live_abcdefghijklmnopqrstuvwx",
								},
							],
							extras: [{ id: "banked-resets", label: "Banked resets", value: "2" }],
						},
					],
					error: "discovery failed reading /home/shuv/.codex",
				},
			],
			{ startedAt: NOW, generatedAt: NOW, complete: true },
		);
	}

	test("masks the email that the internal snapshot keeps", () => {
		const internal = hostileSnapshot();
		expect(internal.providers[0].accounts[0].email).toBe("ada.lovelace@example.com");
		const account = toPublicSnapshot(internal).providers[0].accounts[0];
		expect(account.email).toBe("a***@example.com");
	});

	test("redacts every free-text field, not just the email", () => {
		const account = toPublicSnapshot(hostileSnapshot()).providers[0].accounts[0];
		expect(account.label).toBe("[redacted] on [redacted]");
		expect(account.plan).toBe("Pro [redacted]");
		expect(account.windows[0].label).toBe("Session [redacted]");
		expect(account.windows[0].detail).toBe("token [redacted]");
	});

	test("collapses errors to a generic category", () => {
		const provider = toPublicSnapshot(hostileSnapshot()).providers[0];
		expect(provider.accounts[0].error).toBe("Authentication required");
		expect(provider.error).toBe("Quota data unavailable");
	});

	test("leaks no address, path, or token anywhere in the projection", () => {
		const json = JSON.stringify(toPublicSnapshot(hostileSnapshot()));
		expect(json).not.toContain("ada.lovelace@example.com");
		expect(json).not.toContain("/home/shuv");
		expect(json).not.toContain("sk_live");
	});

	test("keeps the numeric metrics a gauge needs", () => {
		const window = toPublicSnapshot(hostileSnapshot()).providers[0].accounts[0].windows[0];
		expect(window).toMatchObject({
			id: "session",
			percentRemaining: 40,
			percentUsed: 60,
			resetsAt: "2026-01-10T05:00:00.000Z",
			windowSeconds: 18000,
		});
	});

	test("emits only allowlisted keys even for injected fields", () => {
		const public_ = toPublicSnapshot({
			complete: true,
			generatedAt: NOW,
			credentials: { token: "sk_" + "live_abcdefghijklmnopqrstuvwx" },
			providers: [
				{
					id: "codex",
					configPath: "/home/shuv/.codex",
					accounts: [{ label: "work", accountId: "acct_12345", refreshToken: "rt_abcdefghijklmnopqrstuvwx" }],
				},
			],
		});
		expect(Object.keys(public_).sort()).toEqual(
			["complete", "generatedAt", "providers", "schemaVersion", "startedAt", "summary"],
		);
		expect(Object.keys(public_.providers[0]).sort()).toEqual(
			["accounts", "error", "id", "loading", "name"],
		);
		expect(Object.keys(public_.providers[0].accounts[0]).sort()).toEqual(
			["email", "error", "extras", "label", "plan", "status", "windows"],
		);
		const json = JSON.stringify(public_);
		expect(json).not.toContain("acct_12345");
		expect(json).not.toContain("rt_abcdefghijklmnopqrstuvwx");
		expect(json).not.toContain("/home/shuv");
	});

	test("never publishes a generatedAt for an in-flight frame", () => {
		const frame = toPublicSnapshot({ complete: false, generatedAt: NOW, providers: [] });
		expect(frame.generatedAt).toBeNull();
		expect(frame.complete).toBe(false);
	});

	test("recomputes the summary from the projected tree", () => {
		const frame = toPublicSnapshot(hostileSnapshot());
		expect(frame.summary).toEqual({
			providerCount: 1,
			accountCount: 1,
			loadingCount: 0,
			okCount: 0,
			errorCount: 1,
		});
	});

	test("every emitted status is in the documented enum", () => {
		for (const provider of toPublicSnapshot(hostileSnapshot()).providers) {
			for (const account of provider.accounts) {
				expect(ACCOUNT_STATUSES).toContain(account.status);
			}
		}
	});

	test("tolerates junk input", () => {
		expect(toPublicSnapshot(null).providers).toEqual([]);
		expect(toPublicSnapshot({ providers: "nope" }).providers).toEqual([]);
	});

	test("masks the email even when the caller asks it not to", () => {
		// toPublicSnapshot takes no options; anything passed is ignored.
		const account = toPublicSnapshot(hostileSnapshot(), { showEmail: true })
			.providers[0].accounts[0];
		expect(account.email).toBe("a***@example.com");
	});
});

describe("ACCOUNT_STATUSES", () => {
	test("is exactly the three v2 statuses", () => {
		expect([...ACCOUNT_STATUSES]).toEqual(["loading", "ok", "error"]);
	});

	test("carries no severity tier", () => {
		expect(ACCOUNT_STATUSES).not.toContain("attention");
		expect(ACCOUNT_STATUSES).not.toContain("unavailable");
	});

	test("every constructor and normalizer emits only these", () => {
		const produced = [
			createLoadingAccountSnapshot({ label: "work" }),
			createErrorAccountSnapshot({ label: "work" }, new Error("boom")),
			coerceAccountSnapshot({ windows: [{ id: "session", percentRemaining: 1 }] }),
			coerceAccountSnapshot({ windows: [] }),
			normalizeCodexAccount({}, { usage: { rate_limit: { primary_window: { used_percent: 99 } } } }, NOW),
			normalizeClaudeAccount({}, { usage: { five_hour: { utilization: 0.99 } } }, NOW),
			normalizeGrokAccount({}, { usage: { creditUsagePercent: 99 } }, NOW),
			normalizeAntigravityAccount(
				{},
				{ usage: { groups: [{ id: "gemini", buckets: [{ bucketId: "5h", window: "5h", percentRemaining: 1 }] }] } },
				NOW,
			),
			normalizeGenericAccount({}, { usage: { windows: [{ id: "a", used_percent: 99 }] } }, NOW),
		];
		for (const account of produced) {
			expect(ACCOUNT_STATUSES).toContain(account.status);
		}
		// None of the above is an error case, so a 1%-remaining account is `ok`.
		expect(produced.slice(2).filter(account => account.status === "ok")).toHaveLength(6);
	});
});

describe("toDisplaySnapshot", () => {
	/** @returns {object} */
	function snapshot() {
		return buildSnapshot(
			[
				{
					id: "codex",
					accounts: [
						{
							label: "work /home/shuv/x",
							email: "ada.lovelace@example.com",
							status: "ok",
							error: "HTTP 401 reading /home/shuv/.codex/auth.json",
							windows: [{ id: "session", label: "Session", percentRemaining: 40 }],
						},
					],
				},
			],
			{ startedAt: NOW, generatedAt: NOW, complete: true },
		);
	}

	test("masks the email by default, exactly like the public projection", () => {
		expect(toDisplaySnapshot(snapshot())).toEqual(toPublicSnapshot(snapshot()));
	});

	test("shows the full address only when explicitly asked", () => {
		const account = toDisplaySnapshot(snapshot(), { showEmail: true }).providers[0].accounts[0];
		expect(account.email).toBe("ada.lovelace@example.com");
	});

	test("showEmail widens the address and nothing else", () => {
		const account = toDisplaySnapshot(snapshot(), { showEmail: true }).providers[0].accounts[0];
		expect(account.label).toBe("work [redacted]");
		expect(account.error).toBe("Authentication required");
		expect(Object.keys(account).sort()).toEqual(
			["email", "error", "extras", "label", "plan", "status", "windows"],
		);
		const json = JSON.stringify({ ...account, email: null });
		expect(json).not.toContain("/home/shuv");
	});

	test("only an exact true widens it", () => {
		for (const value of ["yes", 1, null, undefined, {}]) {
			const account = toDisplaySnapshot(snapshot(), { showEmail: value }).providers[0].accounts[0];
			expect(account.email).toBe("a***@example.com");
		}
	});
});

describe("context-aware known-secret scrubbing", () => {
	test("show-email does not reflect non-email credential material", () => {
		const projected = toDisplaySnapshot({ providers: [{ id: "codex", accounts: [{
			label: "work", email: "tok-short", status: "error", windows: [],
		}] }] }, { showEmail: true });
		expect(projected.providers[0].accounts[0].email).toBeNull();
		expect(JSON.stringify(projected)).not.toContain("tok-short");
	});
	test("internal display text drops paths while retaining the dedicated email field", () => {
		const account = coerceAccountSnapshot({ label: "work /home/private/auth.json", email: "ada@example.com",
			windows: [{ id: "session", percentRemaining: 50, detail: "from /home/private/cache.json" }] });
		expect(JSON.stringify(account)).not.toContain("/home/private");
		expect(account.email).toBe("ada@example.com");
		expect(account.windows[0].percentRemaining).toBe(50);
	});
	test("keeps the enrollment remedy in a public-safe error", () => {
		expect(safePublicError("Token expired for private-id; run: cq grok add"))
			.toBe("Authentication required; run cq grok add");
	});
	test("scrubs embedded accountId and accessToken from internal normalized accounts", () => {
		const account = {
			label: "work acc_123",
			accountId: "acc_123",
			accessToken: "tok-short",
			email: "ada@example.com",
		};
		const result = {
			usage: {
				usage: {
					plan_type: "pro tok-short",
					rate_limit: {
						primary_window: { used_percent: 30 },
					},
				},
			},
		};
		const snapshot = normalizeCodexAccount(account, result, NOW);
		expect(snapshot.status).toBe("ok");
		expect(snapshot.windows).toHaveLength(1);
		expect(snapshot.windows[0].percentUsed).toBe(30);
		expect(snapshot.label).toBe("work [redacted]");
		expect(snapshot.plan).toBe("Pro [Redacted]");
		const json = JSON.stringify(snapshot);
		expect(json).not.toContain("acc_123");
		expect(json).not.toContain("tok-short");
	});

	test("scrubs embedded secrets in coerceAccountSnapshot with raw options.account", () => {
		const coerced = coerceAccountSnapshot(
			{
				label: "team acc_123",
				plan: "tier tok-short",
				windows: [{ id: "session", percentUsed: 20, detail: "detail tok-short" }],
				extras: [{ id: "note", label: "extra", value: "val acc_123" }],
			},
			{ account: { accountId: "acc_123", accessToken: "tok-short" } },
		);
		expect(coerced.label).toBe("team [redacted]");
		expect(coerced.plan).toBe("tier [redacted]");
		expect(coerced.windows[0].detail).toBe("detail [redacted]");
		expect(coerced.extras[0].value).toBe("val [redacted]");
		const json = JSON.stringify(coerced);
		expect(json).not.toContain("acc_123");
		expect(json).not.toContain("tok-short");
	});

	test("scrubs embedded secrets in createLoadingAccountSnapshot and createErrorAccountSnapshot", () => {
		const loading = createLoadingAccountSnapshot({
			label: "loading acc_123",
			accountId: "acc_123",
			accessToken: "tok-short",
		});
		expect(loading.status).toBe("loading");
		expect(loading.label).toBe("loading [redacted]");
		expect(JSON.stringify(loading)).not.toContain("acc_123");
		expect(JSON.stringify(loading)).not.toContain("tok-short");

		const errorSnap = createErrorAccountSnapshot(
			{ label: "error acc_123", accountId: "acc_123" },
			new Error("auth failed for tok-short"),
			{ account: { accessToken: "tok-short" } },
		);
		expect(errorSnap.status).toBe("error");
		expect(errorSnap.label).toBe("error [redacted]");
		expect(errorSnap.error).toBe("auth failed for [redacted]");
		expect(JSON.stringify(errorSnap)).not.toContain("acc_123");
		expect(JSON.stringify(errorSnap)).not.toContain("tok-short");
	});

	test("public projection and toDisplaySnapshot collect injected secrets and redact occurrences", () => {
		const injected = {
			complete: true,
			credentials: { apiKey: "tok-short" },
			providers: [
				{
					id: "codex",
					configPath: "/home/shuv/.codex",
					accounts: [
						{
							label: "work acc_123",
							email: "ada@example.com",
							accountId: "acc_123",
							status: "ok",
							windows: [{ id: "session", percentRemaining: 70, detail: "quota for acc_123" }],
							extras: [{ id: "token-note", label: "Note", value: "secret tok-short" }],
						},
					],
				},
			],
		};

		const pub = toPublicSnapshot(injected);
		const pubAcc = pub.providers[0].accounts[0];
		expect(pubAcc.label).toBe("work [redacted]");
		expect(pubAcc.email).toBe("a***@example.com");
		expect(pubAcc.windows[0].detail).toBe("quota for [redacted]");
		expect(pubAcc.extras[0].value).toBe("secret [redacted]");
		expect(JSON.stringify(pub)).not.toContain("acc_123");
		expect(JSON.stringify(pub)).not.toContain("tok-short");

		const display = toDisplaySnapshot(injected, { showEmail: true });
		const dispAcc = display.providers[0].accounts[0];
		expect(dispAcc.email).toBe("ada@example.com");
		expect(dispAcc.label).toBe("work [redacted]");
		expect(dispAcc.windows[0].detail).toBe("quota for [redacted]");
		expect(dispAcc.extras[0].value).toBe("secret [redacted]");
		const withoutEmail = { ...dispAcc, email: null };
		expect(JSON.stringify(withoutEmail)).not.toContain("acc_123");
		expect(JSON.stringify(withoutEmail)).not.toContain("tok-short");
	});

	test("preserves arbitrary free text and does not treat window.id or generic words as secrets", () => {
		const snap = normalizeCodexAccount(
			{ label: "production primary cluster", accountId: "acc_999" },
			{ usage: { usage: { plan_type: "team", rate_limit: { primary_window: { used_percent: 50 } } } } },
			NOW,
		);
		expect(snap.label).toBe("production primary cluster");
		expect(snap.plan).toBe("Team");
		expect(snap.windows[0].id).toBe("session");
	});
});
