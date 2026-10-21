import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allProviders as providers, getProvider } from "../../lib/providers/index.js";
import { createCodexProvider } from "../../lib/providers/codex.js";
import { createClaudeProvider } from "../../lib/providers/claude.js";
import { createGrokProvider } from "../../lib/providers/grok.js";
import { createAntigravityProvider } from "../../lib/providers/antigravity.js";
import { loadSnapshot } from "../../lib/quota.js";
import { MANAGED_STORE_FILENAMES } from "../../lib/credential-store.js";

const NOW = new Date("2026-01-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
/** Owned-row expiry checks use the real clock via the token modules' predicates. */
const FRESH = Date.now() + DAY;
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = payload => `${b64({ alg: "none" })}.${b64(payload)}.sig`;

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "shuvquota-providers-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function writeStore(id, accounts) {
	writeFileSync(join(home, MANAGED_STORE_FILENAMES[id]), JSON.stringify({ accounts }));
}
function readStore(id) {
	return JSON.parse(readFileSync(join(home, MANAGED_STORE_FILENAMES[id]), "utf-8")).accounts;
}
/** Base deps: fixture home, no env/harness credentials, no network. */
function deps(extra = {}) {
	return { home, external: () => [], env: {}, now: () => NOW.getTime(), ...extra };
}
async function scan(provider, options = {}) {
	const snapshot = await loadSnapshot({ providers: [provider], now: NOW, ...options });
	return snapshot.providers[0].accounts;
}
const pct = account => account.windows.map(w => [w.id, w.percentUsed, w.percentRemaining]);

describe("registry", () => {
	test("fixed order and lookup", () => {
		expect(providers.map(p => p.id)).toEqual(["codex", "claude", "grok", "antigravity", "cursor"]);
		for (const p of providers) {
			for (const fn of ["discoverAccounts", "discoverSources", "fetch", "normalize", "login"]) expect(typeof p[fn]).toBe("function");
		}
		expect(getProvider(" Grok ")?.id).toBe("grok");
		expect(getProvider("nope")).toBeNull();
	});
});

describe("pipeline + canonical normalizers", () => {
	test("codex: managed row through loadSnapshot yields fixture percentages", async () => {
		writeStore("codex", [{ label: "work", accountId: "acct-1", access: "at", refresh: "rt", expires: FRESH, enrollment: "independent" }]);
		const seen = [];
		const provider = createCodexProvider(deps({
			fetchUsage: async account => {
				seen.push(account.access);
				return { usage: { rate_limit: {
					primary_window: { used_percent: 25, reset_after_seconds: 3600 },
					secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_after_seconds: 86400 },
				} } };
			},
		}));
		const [account] = await scan(provider);
		expect(seen).toEqual(["at"]);
		expect(account.status).toBe("ok");
		expect(pct(account)).toEqual([["session", 25, 75], ["weekly", 60, 40]]);
		expect(account.windows[0].resetsAt).toBe("2026-01-10T01:00:00.000Z");
		expect(account.extras.find(e => e.label === "Source")).toBeUndefined();
	});

	test("claude: env credential is normalized and marked read-only", async () => {
		const provider = createClaudeProvider(deps({
			external: () => [{ label: "claude-code", kind: "harness", source: "/x/.credentials.json", access: "cc-at", refresh: "cc-rt", expires: NOW.getTime() + DAY, subscriptionType: "max" }],
			fetchUsage: async () => ({ usage: { five_hour: { utilization: 42 }, seven_day: { utilization: 80 } } }),
		}));
		const [account] = await scan(provider);
		expect(account.status).toBe("ok");
		expect(pct(account)).toEqual([["session", 42, 58], ["weekly", 80, 20]]);
		expect(account.extras).toContainEqual({ id: "source", label: "Source", value: "Read-only" });
	});

	test("grok + antigravity normalizers delegate to snapshot.js", async () => {
		writeStore("grok", [{ label: "g", accountId: "xai-1", access: "g-at", refresh: "g-rt", expires: FRESH, enrollment: "independent" }]);
		writeStore("antigravity", [{ label: "a", access: "a-at", refresh: "a-rt", expires: FRESH, email: "a@example.test", projectId: "p1", enrollment: "independent" }]);
		const grok = createGrokProvider(deps({ fetchUsage: async () => ({ usage: { creditUsagePercent: 25, period: { start: "2026-01-05T00:00:00Z", end: "2026-01-12T00:00:00Z" } } }) }));
		const antigravity = createAntigravityProvider(deps({ fetchUsage: async () => ({ usage: { groups: [{ id: "gemini", displayName: "Gemini", buckets: [{ bucketId: "5h", displayName: "5h", remainingFraction: 0.62, resetTime: "2026-01-10T05:00:00.000Z" }] }] } }) }));
		const [g] = await scan(grok);
		const [a] = await scan(antigravity);
		expect(pct(g)[0]).toEqual(["credits", 25, 75]);
		expect(a.status).toBe("ok");
		expect(a.windows[0]).toMatchObject({ percentUsed: 38, percentRemaining: 62, resetsAt: "2026-01-10T05:00:00.000Z" });
		expect(a.email).toBe("a@example.test");
	});
});

describe("discovery", () => {
	test("sources list every physical credential without tokens; accounts dedupe on identity with managed winning", async () => {
		writeStore("codex", [
			{ label: "work", accountId: "acct-1", access: "m-at", refresh: "m-rt", expires: 1, enrollment: "independent" },
			{ label: "imported", accountId: "acct-9", access: "l-at", refresh: "l-rt", expires: 1 },
		]);
		const provider = createCodexProvider(deps({ external: () => [
			{ label: "env-1", kind: "env", source: "env:CODEX_ACCOUNTS", accountId: "acct-1", access: "e-at", refresh: "e-rt", expires: 1 },
			{ label: "codex-cli", kind: "harness", source: "/x/.codex/auth.json", accountId: "acct-1", access: "h-at", refresh: "h-rt", expires: 1 },
			{ label: "other", kind: "harness", source: "/x/.opencode/auth.json", accountId: "acct-2", access: "o-at", refresh: null, expires: 1 },
		] }));
		const sources = await provider.discoverSources();
		expect(sources.map(s => [s.label, s.kind, s.writable])).toEqual([
			["work", "managed", true],
			["env-1", "env", false], ["codex-cli", "harness", false], ["other", "harness", false],
		]);
		expect(sources[0].location).toBe(join(home, ".codex-accounts.json"));
		for (const source of sources) {
			expect(Object.keys(source).sort()).toEqual(["identityKey", "kind", "label", "location", "provider", "writable"]);
			expect(JSON.stringify(source)).not.toMatch(/-at|-rt/);
		}
		const accounts = await provider.discoverAccounts();
		expect(accounts.map(a => a.label)).toEqual(["work", "other"]);
	});

	test("claude sources expose a fingerprint, never the token", async () => {
		const provider = createClaudeProvider(deps({ external: () => [{ label: "opencode", kind: "harness", source: "/x/auth.json", access: "secret-access", refresh: "secret-refresh", expires: null }] }));
		const [source] = await provider.discoverSources();
		expect(source.identityKey).toMatch(/^sha256:[0-9a-f]{16}$/);
		expect(JSON.stringify(source)).not.toContain("secret");
	});
});

describe("refresh discipline", () => {
	test("two owned rows sharing a refresh token: one exchange, fan-out to both, no duplicate rotation", async () => {
		writeStore("grok", [
			{ label: "a", accountId: "xai-1", access: "old-at", refresh: "shared-rt", expires: NOW.getTime() - 1000, enrollment: "independent" },
			{ label: "b", accountId: "xai-1", access: "old-at", refresh: "shared-rt", expires: NOW.getTime() - 1000, enrollment: "independent" },
		]);
		let calls = 0;
		const used = [];
		const provider = createGrokProvider(deps({
			refresh: async () => { calls += 1; await new Promise(r => setTimeout(r, 5)); return { access: "new-at", refresh: "new-rt", expires: Date.now() + DAY }; },
			fetchUsage: async account => { used.push(account.access); return { usage: { creditUsagePercent: 10 } }; },
		}));
		const accounts = await provider.discoverAccounts();
		const rows = readStore("grok");
		const both = rows.map(row => accounts.find(a => a.label === row.label) ?? { ...accounts[0], label: row.label });
		const results = await Promise.all(both.map(account => provider.fetch(account, { now: NOW })));
		expect(results.every(r => r.usage)).toBe(true);
		expect(calls).toBe(1);
		expect(used).toEqual(["new-at", "new-at"]);
		expect(readStore("grok").map(r => [r.label, r.access, r.refresh])).toEqual([["a", "new-at", "new-rt"], ["b", "new-at", "new-rt"]]);
	});

	test("external credentials are never refreshed: hard expiry only, buffer ignored", async () => {
		let refreshes = 0;
		const fetched = [];
		const provider = createCodexProvider(deps({
			external: () => [
				{ label: "expired", kind: "env", source: "env:CODEX_ACCOUNTS", accountId: "acct-1", access: "x-at", refresh: "x-rt", expires: NOW.getTime() - 1 },
				{ label: "in-buffer", kind: "harness", source: "/x/auth.json", accountId: "acct-2", access: "b-at", refresh: "b-rt", expires: NOW.getTime() + 30_000 },
			],
			refresh: async () => { refreshes += 1; return { access: "nope" }; },
			fetchUsage: async account => { fetched.push(account.label); return { usage: { rate_limit: { primary_window: { used_percent: 1 } } } }; },
		}));
		const accounts = await scan(provider);
		const byLabel = Object.fromEntries(accounts.map(a => [a.label, a]));
		expect(byLabel.expired.status).toBe("error");
		expect(byLabel.expired.error).toContain("cq codex add");
		expect(byLabel["in-buffer"].status).toBe("ok");
		expect(fetched).toEqual(["in-buffer"]);
		expect(refreshes).toBe(0);
		expect(existsSync(join(home, ".codex-accounts.json"))).toBe(false);
	});

	test("unstamped managed rows are ignored; rows sharing a refresh with an external session are never rotated or written", async () => {
		writeStore("claude", [
			{ label: "legacy", oauthToken: "l-at", oauthRefreshToken: "l-rt", oauthExpiresAt: NOW.getTime() - 1 },
			{ label: "shared", oauthToken: "s-at", oauthRefreshToken: "harness-rt", oauthExpiresAt: NOW.getTime() - 1, enrollment: "independent" },
		]);
		const before = readFileSync(join(home, ".claude-accounts.json"), "utf-8");
		let refreshes = 0;
		const provider = createClaudeProvider(deps({
			external: () => [{ label: "claude-code", kind: "harness", source: "/x/.credentials.json", access: "h-at", refresh: "harness-rt", expires: NOW.getTime() + DAY }],
			refresh: async () => { refreshes += 1; return { access: "nope", refresh: "nope", expires: 1 }; },
			fetchUsage: async () => ({ usage: { five_hour: { utilization: 1 } } }),
		}));
		const accounts = await provider.discoverAccounts();
		expect(accounts.map(a => a.label)).toEqual(["shared"]);
		const shared = await provider.fetch(accounts.find(a => a.label === "shared"), { now: NOW });
		expect(shared.error).toMatch(/shared with an external session/);
		expect(refreshes).toBe(0);
		expect(readFileSync(join(home, ".claude-accounts.json"), "utf-8")).toBe(before);
	});
});

describe("codex proxx merge", () => {
	const remote = { success: true, data: { accounts: [
		{ accountId: "acct-1", displayName: "remote-name", rate_limit: { primary_window: { used_percent: 70 } } },
		{ accountId: "acct-7", displayName: "remote-only", rate_limit: { primary_window: { used_percent: 5 } } },
	] } };

	test("local label wins on verified id, unmatched becomes remote card, local usage falls back to remote", async () => {
		writeStore("codex", [{ label: "work", accountId: "acct-1", access: "at", refresh: "rt", expires: FRESH, enrollment: "independent" }]);
		const provider = createCodexProvider(deps({
			env: { PROXX_AUTH_TOKEN: "t", PROXX_BASE_URL: "http://proxx.local:1" },
			fetchProxx: async () => remote,
			fetchUsage: async () => ({ error: "HTTP 500" }),
		}));
		const accounts = await scan(provider);
		expect(accounts.map(a => [a.label, a.status])).toEqual([["remote-only", "ok"], ["work", "ok"]]);
		expect(pct(accounts[1])[0]).toEqual(["session", 70, 30]);
		// Sources are physical and un-deduplicated: both remote records appear.
		const sources = await provider.discoverSources();
		expect(sources.filter(s => s.kind === "remote").map(s => [s.label, s.writable, s.location])).toEqual([
			["remote-name", false, "http://proxx.local:1"], ["remote-only", false, "http://proxx.local:1"],
		]);
	});

	test("remote failure or missing token leaves local results unchanged", async () => {
		writeStore("codex", [{ label: "work", accountId: "acct-1", access: "at", refresh: "rt", expires: FRESH, enrollment: "independent" }]);
		const failing = createCodexProvider(deps({ env: { PROXX_AUTH_TOKEN: "t" }, fetchProxx: async () => ({ success: false, error: "down" }) }));
		const disabled = createCodexProvider(deps({ fetchProxx: async () => { throw new Error("must not be called"); } }));
		expect((await failing.discoverAccounts()).map(a => a.label)).toEqual(["work"]);
		expect((await disabled.discoverAccounts()).map(a => a.label)).toEqual(["work"]);
	});
	test("throwing remote clients and malformed URLs preserve local accounts and sources", async () => {
		writeStore("codex", [{ label: "work", accountId: "acct-1", access: "at", refresh: "rt", expires: FRESH, enrollment: "independent" }]);
		for (const extra of [
			{ env: { PROXX_AUTH_TOKEN: "t" }, fetchProxx: async () => { throw new TypeError("fetch failed"); } },
			{ env: { PROXX_AUTH_TOKEN: "t", PROXX_BASE_URL: "localhost:8789" } },
		]) {
			const provider = createCodexProvider(deps(extra));
			expect((await provider.discoverAccounts()).map(a => a.label)).toEqual(["work"]);
			expect((await provider.discoverSources()).map(a => a.label)).toEqual(["work"]);
		}
	});
});

describe("login", () => {
	const credential = { accessToken: "new-at", refreshToken: "new-rt", expiresAt: NOW.getTime() + DAY, email: "me@example.test", enrollment: "independent" };

	test("returns a raw store row and persists nothing", async () => {
		const calls = [];
		const loginProvider = async (id, ctx) => { calls.push([id, ctx.label]); return { ...credential, accountId: `${id}-id` }; };
		const codexEntry = await createCodexProvider(deps({ loginProvider })).login({ label: "new" });
		const claudeEntry = await createClaudeProvider(deps({ loginProvider })).login({ label: "new" });
		expect(codexEntry).toEqual({ label: "new", access: "new-at", refresh: "new-rt", expires: credential.expiresAt, email: "me@example.test", accountId: "codex-id" });
		expect(claudeEntry).toEqual({ label: "new", oauthToken: "new-at", oauthRefreshToken: "new-rt", oauthExpiresAt: credential.expiresAt, email: "me@example.test" });
		expect(calls).toEqual([["codex", "new"], ["claude", "new"]]);
		for (const file of Object.values(MANAGED_STORE_FILENAMES)) expect(existsSync(join(home, file))).toBe(false);
	});

	test("rejects non-independent or tokenless results", async () => {
		await expect(createGrokProvider(deps({ loginProvider: async () => ({ ...credential, enrollment: "legacy" }) })).login({ label: "x" })).rejects.toThrow(/independent/);
		await expect(createAntigravityProvider(deps({ loginProvider: async () => null })).login({ label: "x" })).rejects.toThrow(/independent/);
	});
});
