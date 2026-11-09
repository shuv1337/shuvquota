import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClaudeUserAgent } from "../lib/claude-identity.js";
import { parseClaudeLimitResets, projectLimitReset } from "../lib/claude-limit-resets.js";
import { fetchClaudeLimitResets, fetchClaudeOAuthUsage, fetchClaudeUsageWithResets } from "../lib/claude-usage.js";
import { createClaudeProvider } from "../lib/providers/claude.js";
import { loadSnapshot } from "../lib/quota.js";
import { buildSnapshot, normalizeClaudeAccount, toDisplaySnapshot, toPublicSnapshot } from "../lib/snapshot.js";
import { formatLimitReset } from "../lib/display.js";
import { renderCompact, renderStatic } from "../lib/tui/render.js";
import { renderShell } from "../lib/tui/shell.js";
import { cellWidth } from "../lib/tui/width.js";

// Recorded GET shape; all grant identifiers and labels are fake, telemetry removed.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/claude-limit-resets.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-10T00:00:00Z");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const RESETS_URL = `${USAGE_URL}?cedar_ember=1&skip_spend=1`;
const usage = { seven_day: { utilization: 8, resets_at: "2026-11-15T18:00:00Z" }, spend: { enabled: true } };
const groups = [
	{ type: "fable", count: 3, expiresAt: "2027-03-09T07:59:00.000Z" },
	{ type: "weekly", count: 1, expiresAt: "2026-12-16T04:59:00.000Z" },
];
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const payload = grants => ({ cedar_ember: { eligible: true, grants } });
const grant = fixture.cedar_ember.grants[0];

describe("Claude reset grant normalization", () => {
	test("recorded response groups Fable by gives_back_weekly before type=full", () => {
		expect(parseClaudeLimitResets(fixture, NOW)).toEqual(groups);
	});

	test("groups by expiry as well as type and sums resets_left, not resets_total", () => {
		const data = payload([
			{ ...grant, resets_left: 2, resets_total: 5 },
			{ ...grant, ends_at: "2026-12-20T00:00:00Z" },
		]);
		expect(parseClaudeLimitResets(data, NOW)).toEqual([
			{ type: "weekly", count: 2, expiresAt: groups[1].expiresAt },
			{ type: "weekly", count: 1, expiresAt: "2026-12-20T00:00:00.000Z" },
		]);
	});

	test("held but not usable_now grants still count; spent/paused/expired/malformed do not", () => {
		const data = payload([
			{ ...grant, usable_now: false, use_requires_limit: true },
			...[-1, 0, 1.5, "3", NaN, Infinity].map(resets_left => ({ ...grant, resets_left })),
			{ ...grant, paused: true },
			{ ...grant, ends_at: NOW.toISOString() },
			{ ...grant, ends_at: "invalid" },
			{ ...grant, starts_at: "invalid" },
			null,
		]);
		expect(parseClaudeLimitResets(data, NOW)).toEqual([groups[1]]);
	});

	test("future grants count separately and expose safe availability dates", () => {
		const startsAt = "2026-12-01T00:00:00.000Z";
		const result = parseClaudeLimitResets(payload([grant, { ...grant, starts_at: startsAt }]), NOW);
		expect(result).toEqual([groups[1], { ...groups[1], startsAt }]);
		const future = result[1];
		expect(projectLimitReset({ ...future, secret: "private" })).toEqual(future);
		expect(formatLimitReset(future, { timeZone: "UTC" })).toBe("1 · from Dec 1 · expires Dec 16");
		const account = normalizeClaudeAccount({ label: "future" }, { usage: payload([{ ...grant, starts_at: startsAt }]) }, NOW);
		const data = toPublicSnapshot(buildSnapshot([{ id: "claude", name: "Claude", accounts: [account] }]));
		expect(data.providers[0].accounts[0].extras[0].value).toBe("1");
		expect(data.providers[0].accounts[0].extras[1].reset.startsAt).toBe(startsAt);
		expect(renderCompact(data, { now: NOW, color: false }).join("\n")).toContain("from Nov 30, 2026, 16:00 PST");
	});

	test("missing blocks, unsupported plans and malformed grants are silent", () => {
		for (const data of [null, {}, { cedar_ember: null }, { cedar_ember: { eligible: false, grants: [grant] } }, { cedar_ember: { eligible: true, grants: {} } }]) {
			expect(parseClaudeLimitResets(data, NOW)).toEqual([]);
		}
	});

	test("missing expiry is unknown; older grants infer kinds from clears", () => {
		expect(parseClaudeLimitResets(payload([
			{ ...grant, type: undefined, clears: ["five_hour"], ends_at: null },
			{ ...grant, type: undefined, clears: ["five_hour", "seven_day"] },
			{ ...grant, type: undefined, clears: [] },
		]), NOW)).toEqual([
			{ type: "session", count: 1, expiresAt: null },
			{ type: "full", count: 1, expiresAt: groups[1].expiresAt },
		]);
	});

	test("constructive reset projection keeps only recognized kind, count and ISO expiry", () => {
		expect(projectLimitReset({ ...groups[0], token: "fixture-secret", id: "private" })).toEqual(groups[0]);
		expect(projectLimitReset({ type: "private-name", count: 1 })).toBeNull();
		expect(projectLimitReset({ type: "weekly", count: -1 })).toBeNull();
	});
});

describe("read-only optional HTTP enrichment", () => {
	test("optional read aborts at five seconds without losing ordinary usage", async () => {
		await getClaudeUserAgent();
		const originalTimeout = globalThis.setTimeout;
		const delays = [];
		const timer = spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => {
			delays.push(ms);
			return originalTimeout(fn, 0);
		});
		try {
			const result = await fetchClaudeUsageWithResets("slow-reset", { fetchFn: async (url, options) => {
				if (url === USAGE_URL) return Response.json(usage);
				return new Promise((resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
				});
			} });
			expect(delays).toEqual([15000, 5000]);
			expect(result).toEqual({ success: true, data: usage });
		} finally {
			timer.mockRestore();
		}
	});

	test("successful reset cache avoids requests for 15 minutes and isolates accounts", async () => {
		let now = +NOW;
		let calls = 0;
		const options = { now: () => now, fetchFn: async () => { calls++; return Response.json(fixture); } };
		expect(await fetchClaudeLimitResets("cache-account", options)).toEqual(fixture.cedar_ember);
		now += 14 * 60 * 1000;
		expect(await fetchClaudeLimitResets("cache-account", options)).toEqual(fixture.cedar_ember);
		expect(calls).toBe(1);
		await fetchClaudeLimitResets("cache-other-account", options);
		expect(calls).toBe(2);
		now += 60 * 1000;
		await fetchClaudeLimitResets("cache-account", options);
		expect(calls).toBe(3);
	});

	for (const retryAfter of [null, "600", new Date(+NOW + 600000).toUTCString()]) {
		test(`reset 429 skips next refresh until cooldown ends (${retryAfter})`, async () => {
			let now = +NOW;
			let resetCalls = 0;
			const options = { now: () => now, fetchFn: async url => {
				if (url === USAGE_URL) return Response.json(usage);
				resetCalls++;
				return new Response(null, { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} });
			} };
			const token = `cooldown-${retryAfter}`;
			await fetchClaudeUsageWithResets(token, options);
			now += 299000;
			expect(await fetchClaudeUsageWithResets(token, options)).toEqual({ success: true, data: usage });
			expect(resetCalls).toBe(1);
			if (retryAfter) {
				now = +NOW + 599000;
				await fetchClaudeUsageWithResets(token, options);
				expect(resetCalls).toBe(1);
			}
			now = +NOW + (retryAfter ? 600000 : 300000);
			await fetchClaudeUsageWithResets(token, options);
			expect(resetCalls).toBe(2);
		});
	}

	test("primary cooldown also prevents direct optional reads", async () => {
		let calls = 0;
		const options = { now: () => +NOW, fetchFn: async () => { calls++; return new Response(null, { status: 429 }); } };
		await fetchClaudeOAuthUsage("primary-cooldown-reset", options);
		await fetchClaudeUsageWithResets("primary-cooldown-reset", options);
		expect(await fetchClaudeLimitResets("primary-cooldown-reset", options)).toBeNull();
		expect(calls).toBe(1);
	});

	test("only GETs status; uses account bearer and usage-client header; preserves spend", async () => {
		const calls = [];
		const result = await fetchClaudeUsageWithResets("fixture-access", { fetchFn: async (url, options) => {
			calls.push(url);
			expect(options.method).toBe("GET");
			expect(options.body).toBeUndefined();
			expect(options.headers.Authorization).toBe("Bearer fixture-access");
			expect(options.signal).toBeInstanceOf(AbortSignal);
			if (url === RESETS_URL) expect(options.headers["User-Agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\) shuvquota$/);
			else expect(url).toBe(USAGE_URL);
			return Response.json(url === USAGE_URL ? usage : fixture);
		} });
		expect(calls).toEqual([USAGE_URL, RESETS_URL]);
		expect(result.data).toEqual({ ...usage, ...fixture });
	});

	test("already-enriched usage needs no second request", async () => {
		let calls = 0;
		const result = await fetchClaudeUsageWithResets("fixture-inline", { fetchFn: async () => {
			calls++;
			return Response.json({ ...usage, ...fixture });
		} });
		expect(calls).toBe(1);
		expect(result.data.cedar_ember).toEqual(fixture.cedar_ember);
	});

	for (const mode of ["missing", "invalid-json", "network", "abort", 401, 403, 404, 429, 500]) {
		test(`optional ${mode} leaves normal usage successful`, async () => {
			const result = await fetchClaudeUsageWithResets(`fixture-${mode}`, { fetchFn: async url => {
				if (url === USAGE_URL) return Response.json(usage);
				if (mode === "network") throw new Error("fixture failure");
				if (mode === "abort") throw new DOMException("fixture timeout", "AbortError");
				if (mode === "invalid-json") return new Response("not JSON");
				return Response.json({}, { status: typeof mode === "number" ? mode : 200 });
			} });
			expect(result).toEqual({ success: true, data: usage });
		});
	}

	test("failed primary usage never triggers optional reads or refresh", async () => {
		const calls = [];
		const result = await fetchClaudeUsageWithResets("fixture-denied", { fetchFn: async (url, opts) => {
			calls.push([url, opts.method]);
			return new Response("denied", { status: 401 });
		} });
		expect(result.success).toBe(false);
		expect(calls).toEqual([[USAGE_URL, "GET"]]);
	});
});

function snapshot() {
	return buildSnapshot([{ id: "claude", name: "Claude", accounts: [normalizeClaudeAccount(
		{ label: "personal", email: "person@example.test" }, { usage: { ...usage, ...fixture } }, NOW,
	)] }], { complete: true, generatedAt: NOW });
}

describe("snapshot → JSON → terminal", () => {
	test("public and local JSON retain safe typed groups and total, never grant identifiers", () => {
		for (const project of [toDisplaySnapshot, toPublicSnapshot]) {
			const data = project(snapshot());
			const extras = data.providers[0].accounts[0].extras;
			expect(extras[0]).toEqual({ id: "limit-resets", label: "Limit resets", value: "4" });
			expect(extras.slice(1).map(e => e.reset)).toEqual(groups);
			expect(JSON.stringify(data)).not.toContain("fixture-grant");
			expect(JSON.stringify(data)).not.toContain("person@example.test");
		}
	});

	test("compact and static render count/type/expiry; formatting supports local zone and DST", () => {
		const data = toDisplaySnapshot(snapshot());
		const compact = renderCompact(data, { now: NOW, color: false }).join("\n");
		expect(compact).toContain("Limit resets: 4");
		expect(compact).toContain("Fable resets: 3 · expire Mar 8, 2027, 23:59 PST");
		expect(compact).toContain("Weekly reset: 1 · expires Dec 15, 2026, 20:59 PST");
		const lines = renderStatic(data, { cols: 180, now: NOW, color: false });
		expect(lines.join("\n")).toContain("fable resets 3 · expire Mar 8");
		expect(lines.every(line => cellWidth(line) <= 180)).toBe(true);
		expect(formatLimitReset(groups[0], { timeZone: "UTC" })).toBe("3 · expire Mar 9");
		expect(formatLimitReset({ ...groups[0], expiresAt: "2027-07-01T07:59:00Z" }, { timeZone: "America/Los_Angeles", compact: false })).toContain("PDT");
		expect(formatLimitReset({ ...groups[0], expiresAt: null })).toBe("3");
		expect(formatLimitReset({ ...groups[0], expiresAt: "2027-07-01T00:00:00Z" }, { timeZone: "UTC", compact: false })).toBe("3 · expire Jul 1, 2027, 00:00 UTC");
	});

	test("watch detail pane includes groups and stays within narrow/wide geometry", () => {
		for (const cols of [60, 80, 120]) {
			const rendered = renderShell({ snapshot: toDisplaySnapshot(snapshot()), providerFilter: null, selected: null, interval: 180 }, { cols, rows: 40 }, { now: +NOW, color: false });
			const lines = rendered.lines ?? rendered;
			expect(lines.length).toBe(40);
			expect(lines.every(line => cellWidth(line) === cols)).toBe(true);
			if (cols === 120) {
				expect(lines.join("\n")).toContain("Fable resets");
				expect(lines.join("\n")).toContain("3 · expire Mar 8");
				expect(lines.join("\n")).toContain("1 · expires Dec 15");
			}
		}
	});

	test("real adapter fetch path enriches separate accounts without changing external files", async () => {
		const home = mkdtempSync(join(tmpdir(), "sq-reset-test-"));
		const file = join(home, "credentials.json");
		const contents = JSON.stringify({ fixture: "read-only" });
		writeFileSync(file, contents);
		try {
			const calls = [];
			globalThis.fetch = async (url, options) => {
				expect(options.method).toBe("GET");
				calls.push(options.headers.Authorization);
				return Response.json(url === USAGE_URL ? usage : options.headers.Authorization === "Bearer fixture-account-1" ? fixture : {});
			};
			const provider = createClaudeProvider({ home, env: {}, now: () => +NOW,
				external: () => [1, 2].map(n => ({ label: `account-${n}`, kind: "harness", source: file, access: `fixture-account-${n}`, refresh: `fixture-refresh-${n}`, expires: +NOW + 1000 })),
				refresh: () => { throw new Error("Must never refresh external credentials"); },
			});
			const data = await loadSnapshot({ providers: [provider], now: NOW });
			const [first, second] = data.providers[0].accounts;
			expect(first.extras.filter(e => e.reset).map(e => e.reset)).toEqual(groups);
			expect(second.extras.filter(e => e.reset)).toEqual([]);
			expect(calls.length).toBe(4);
			expect(readFileSync(file, "utf8")).toBe(contents);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
