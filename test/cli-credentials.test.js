/**
 * Integration: `runCli` against the REAL credential store on a throwaway home.
 *
 * Nothing here mocks the store. Provider objects are injected (the registry is
 * still landing) with a pure `login` that returns a fixture credential, a
 * `discoverSources` that returns fixtures, and `discoverAccounts` that reads
 * back through the same store — so add → list → snapshot → JSON is exercised
 * end to end. No network, no real credentials, no writes outside `home`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../lib/cli.js";
import * as store from "../lib/credential-store.js";
import { codex } from "../lib/providers/codex.js";

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "shuvquota-cli-cred-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const ACCESS = "access-token-fixture-000000000000000000";
const REFRESH = "refresh-token-fixture-00000000000000000";
const ESC = "\x1b";

/** Position of the `options` argument for every store method `runCli` calls. */
const OPTIONS_INDEX = Object.freeze({
	listManagedAccounts: 1,
	findManagedAccount: 2,
	addManagedAccount: 2,
	replaceManagedAccount: 3,
	renameManagedAccount: 3,
	removeManagedAccount: 2,
});

/** The real store, with `options.home` pinned to the fixture home. */
function boundStore() {
	const bound = {};
	for (const [name, index] of Object.entries(OPTIONS_INDEX)) {
		bound[name] = (...args) => {
			const full = Array.from({ length: Math.max(args.length, index + 1) }, (_, i) => args[i]);
			full[index] = { ...(full[index] ?? {}), home };
			return store[name](...full);
		};
	}
	return bound;
}

const storePath = id => store.getManagedStorePath(id, { home });
const readRows = id => JSON.parse(readFileSync(storePath(id), "utf8")).accounts;
const bytesOf = path => readFileSync(path).toString("base64");
const listing = () => readdirSync(home).sort();

/** Store-row-shaped credential as a pure provider `login` would return it. */
function credential(overrides = {}) {
	return {
		accountId: "acct_fixture_1", access: ACCESS, refresh: REFRESH,
		expires: 1_800_003_600_000, email: "alice@example.test", ...overrides,
	};
}

/** Canonical healthy Codex payload (same shape as test/quota.test.js okUsage). */
function canonicalUsage() {
	return { usage: { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } } };
}

/**
 * @param {{ id?: string, name?: string, login?: object | ((ctx: object) => object),
 *   sources?: object[], usage?: () => object }} [config]
 */
function makeProvider(config = {}) {
	const id = config.id ?? "codex";
	const bound = boundStore();
	const calls = { login: [], fetch: 0 };
	const provider = {
		id,
		name: config.name ?? (id === "codex" ? "Codex" : id),
		async login(ctx) {
			calls.login.push(ctx);
			if (!config.login) throw new Error(`login must not run for ${id}`);
			return typeof config.login === "function" ? config.login(ctx) : { ...config.login };
		},
		async discoverSources() {
			return (config.sources ?? []).map(source => ({ ...source }));
		},
		async discoverAccounts() {
			return bound.listManagedAccounts(id).map(row => ({
				label: row.label, email: row.raw.email ?? null, accountId: row.raw.accountId ?? null,
				access: row.raw.access ?? null, refresh: row.raw.refresh ?? null, managed: true,
			}));
		},
		async fetch() {
			calls.fetch += 1;
			return (config.usage ?? canonicalUsage)();
		},
		normalize: codex.normalize,
	};
	return { provider, calls };
}

/** @param {string[]} argv @param {{ providers: object[], promptInput?: Function }} deps */
async function run(argv, { providers, promptInput }) {
	let text = "";
	let errors = "";
	const deps = {
		providers,
		store: boundStore(),
		output: { columns: 80, isTTY: false, write(value) { text += value; } },
		errorOutput: { write(value) { errors += value; } },
	};
	if (promptInput) deps.promptInput = promptInput;
	await runCli(argv, deps);
	return { text, errors, json: () => JSON.parse(text) };
}

async function fails(argv, deps) {
	try {
		await run(argv, deps);
	} catch (error) {
		return error;
	}
	throw new Error(`expected \`${argv.join(" ")}\` to fail`);
}

function seedStore(id, accounts, rootFields = {}) {
	writeFileSync(storePath(id), `${JSON.stringify({ ...rootFields, schemaVersion: 1, accounts }, null, 2)}\n`, { mode: 0o600 });
}

describe("cq <provider> add", () => {
	test("persists exactly one independently enrolled row per label and refuses a duplicate without logging in again", async () => {
		const { provider, calls } = makeProvider({ login: credential() });
		const first = await run(["codex", "add", "work", "--json"], { providers: [provider] });
		expect(first.json()).toEqual({ provider: "codex", command: "add", label: "work" });
		expect(calls.login).toEqual([{ label: "work" }]);

		expect(storePath("codex").startsWith(home)).toBe(true);
		expect(listing()).toEqual([".codex-accounts.json"]);
		expect(readRows("codex")).toEqual([{ ...credential(), label: "work", enrollment: "independent" }]);
		const before = bytesOf(storePath("codex"));

		const error = await fails(["codex", "add", "work"], { providers: [provider] });
		expect(error.message).toMatch(/Account 'work' already exists.*reauth/i);
		expect(calls.login).toHaveLength(1);
		expect(bytesOf(storePath("codex"))).toBe(before);

		await run(["codex", "add", "personal"], { providers: [provider] });
		expect(readRows("codex").map(row => row.label)).toEqual(["work", "personal"]);
		expect(readRows("codex").every(row => row.enrollment === "independent")).toBe(true);
	});

	test("a missing label is only ever supplied through the injected prompt", async () => {
		const { provider, calls } = makeProvider({ login: credential() });
		const error = await fails(["codex", "add"], { providers: [provider] });
		expect(error.message).toMatch(/Provide an account label/);
		expect(calls.login).toHaveLength(0);
		expect(existsSync(storePath("codex"))).toBe(false);

		await run(["codex", "add"], { providers: [provider], promptInput: async () => "prompted" });
		expect(calls.login).toEqual([{ label: "prompted" }]);
		expect(readRows("codex").map(row => row.label)).toEqual(["prompted"]);
	});

	test("labels with control characters or no visible text are rejected before login and before any write", async () => {
		const { provider, calls } = makeProvider({ login: credential() });
		for (const label of [`wo${ESC}[31mrk`, "\x7f", "   ", "a\nb", "bell\x07"]) {
			const error = await fails(["codex", "add", label], { providers: [provider] });
			expect(error.message).toMatch(/non-empty account label without control characters/);
		}
		expect(calls.login).toHaveLength(0);
		expect(listing()).toEqual([]);
	});
});

describe("cq <provider> reauth", () => {
	test("requires an existing account and does not log in for a missing one", async () => {
		const { provider, calls } = makeProvider({ login: credential() });
		const error = await fails(["codex", "reauth", "work"], { providers: [provider] });
		expect(error.message).toMatch(/Account 'work' not found/);
		expect(calls.login).toHaveLength(0);
		expect(existsSync(storePath("codex"))).toBe(false);
	});

	test("replaces credential material in place while preserving the CLI label", async () => {
		const rotated = credential({
			access: "access-token-rotated-11111111111111111111",
			refresh: "refresh-token-rotated-1111111111111111111",
			email: "alice.rotated@example.test",
			label: "sneaky-label-from-provider",
		});
		let next = credential();
		const { provider, calls } = makeProvider({ login: () => next });
		await run(["codex", "add", "work"], { providers: [provider] });
		next = rotated;

		const result = await run(["codex", "reauth", "work", "--json"], { providers: [provider] });
		expect(result.json()).toEqual({ provider: "codex", command: "reauth", label: "work" });
		expect(calls.login).toEqual([{ label: "work" }, { label: "work" }]);

		const rows = readRows("codex");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ ...rotated, label: "work", enrollment: "independent" });
		const raw = readFileSync(storePath("codex"), "utf8");
		expect(raw).not.toContain(ACCESS);
		expect(raw).not.toContain(REFRESH);
		expect(raw).not.toContain("sneaky-label-from-provider\"");
	});

	test("a legacy row is listed as read-only and becomes independent only after reauth", async () => {
		seedStore("codex", [{ label: "imported", access: "legacy-access-token-2222222222222222", email: "carol@example.test" }], { note: "keep me" });
		const { provider } = makeProvider({ login: credential({ accountId: "acct_after_reauth" }) });

		const before = await run(["codex", "accounts", "--json"], { providers: [provider] });
		expect(before.json()).toEqual([{ provider: "codex", label: "imported", email: "c***@example.test", enrollment: "legacy", readOnly: true }]);
		expect((await run(["codex", "accounts"], { providers: [provider] })).text).toBe("codex\timported\treauth required\n");

		await run(["codex", "reauth", "imported"], { providers: [provider] });
		expect(readRows("codex")).toEqual([{ ...credential({ accountId: "acct_after_reauth" }), label: "imported", enrollment: "independent" }]);
		expect(JSON.parse(readFileSync(storePath("codex"), "utf8")).note).toBe("keep me");
		expect((await run(["codex", "accounts"], { providers: [provider] })).text).toBe("codex\timported\tmanaged\n");
	});
});

describe("cq <provider> rename / remove", () => {
	/** Files in the fixture home that must never change under codex mutations. */
	function seedNeighbours() {
		seedStore("claude", [{ label: "claude-work", access: "sk-ant-oat-fixture", enrollment: "independent" }]);
		seedStore("grok", [{ label: "grok-work", access: "xai-fixture", enrollment: "independent" }]);
		mkdirSync(join(home, ".codex"));
		writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "harness-fixture" } }));
		return () => ({
			claude: bytesOf(storePath("claude")),
			grok: bytesOf(storePath("grok")),
			harness: bytesOf(join(home, ".codex", "auth.json")),
			listing: listing(),
		});
	}

	test("rename touches only the provider's own store and validates both labels", async () => {
		const snapshot = seedNeighbours();
		const { provider, calls } = makeProvider({ login: credential() });
		await run(["codex", "add", "work"], { providers: [provider] });
		await run(["codex", "add", "other"], { providers: [provider] });
		const neighbours = snapshot();

		const result = await run(["codex", "rename", "work", "personal", "--json"], { providers: [provider] });
		expect(result.json()).toEqual({ provider: "codex", command: "rename", label: "personal" });
		expect(readRows("codex").map(row => row.label)).toEqual(["personal", "other"]);
		expect(readRows("codex")[0]).toEqual({ ...credential(), label: "personal", enrollment: "independent" });

		expect((await fails(["codex", "rename", "personal", `bad${ESC}[0m`], { providers: [provider] })).message).toMatch(/valid new label/);
		expect((await fails(["codex", "rename", "personal", "  "], { providers: [provider] })).message).toMatch(/valid new label/);
		expect((await fails(["codex", "rename", "missing", "x"], { providers: [provider] })).message).toMatch(/'missing' not found/);
		expect((await fails(["codex", "rename", "personal", "other"], { providers: [provider] })).message).toMatch(/'other' already exists/);
		expect(readRows("codex").map(row => row.label)).toEqual(["personal", "other"]);

		expect(calls.login).toHaveLength(2);
		expect(snapshot()).toEqual(neighbours);
	});

	test("remove deletes exactly one row, is an error when absent, and leaves neighbours untouched", async () => {
		const snapshot = seedNeighbours();
		const { provider } = makeProvider({ login: credential() });
		await run(["codex", "add", "work"], { providers: [provider] });
		await run(["codex", "add", "other"], { providers: [provider] });
		const neighbours = snapshot();

		const result = await run(["codex", "remove", "work", "--json"], { providers: [provider] });
		expect(result.json()).toEqual({ provider: "codex", command: "remove", label: "work" });
		expect(readRows("codex").map(row => row.label)).toEqual(["other"]);
		expect(readFileSync(storePath("codex"), "utf8")).not.toContain("\"work\"");

		expect((await fails(["codex", "remove", "work"], { providers: [provider] })).message).toMatch(/'work' not found/);
		expect(readRows("codex").map(row => row.label)).toEqual(["other"]);

		await run(["codex", "remove", "other"], { providers: [provider] });
		expect(readRows("codex")).toEqual([]);
		expect(snapshot()).toEqual(neighbours);
	});
});

describe("malformed existing store", () => {
	test.each([
		["not JSON", "{ \"accounts\": [ oops"],
		["accounts is not an array", JSON.stringify({ schemaVersion: 1, accounts: { label: "work" } })],
		["root is a scalar", "42"],
	])("%s: every mutation refuses and the bytes are left exactly as found", async (_name, contents) => {
		writeFileSync(storePath("codex"), contents);
		const before = bytesOf(storePath("codex"));
		const { provider } = makeProvider({ login: credential() });

		for (const argv of [
			["codex", "add", "work"],
			["codex", "reauth", "work"],
			["codex", "rename", "work", "personal"],
			["codex", "remove", "work"],
		]) {
			await fails(argv, { providers: [provider] });
			expect(bytesOf(storePath("codex"))).toBe(before);
		}
		expect(listing()).toEqual([".codex-accounts.json"]);

		const accounts = await run(["codex", "accounts", "--json"], { providers: [provider] });
		expect(accounts.json()).toEqual([]);
		expect((await run(["codex", "accounts"], { providers: [provider] })).text).toMatch(/No managed accounts/);
		expect(bytesOf(storePath("codex"))).toBe(before);
	});

	test("a corrupt store names the file and the reason on add", async () => {
		writeFileSync(storePath("codex"), "{ nope");
		const { provider } = makeProvider({ login: credential() });
		const error = await fails(["codex", "add", "work"], { providers: [provider] });
		expect(error.message).toMatch(/not valid JSON|malformed/i);
	});
});

describe("cq accounts", () => {
	test("JSON carries an allowlist only: no tokens, no paths, masked email by default, full email on --show-email", async () => {
		let next = credential();
		const { provider } = makeProvider({ login: () => next });
		await run(["codex", "add", "work"], { providers: [provider] });
		next = credential({ accountId: "acct_fixture_2", email: "bob@example.test", access: "access-token-bob-3333333333333333333333" });
		await run(["codex", "add", "bob@example.test"], { providers: [provider] });
		seedStore("codex", [...readRows("codex"), { label: "imported", access: "legacy-access-token-4444444444444444", email: "carol@example.test" }]);

		const masked = await run(["codex", "accounts", "--json"], { providers: [provider] });
		const records = masked.json();
		expect(records).toHaveLength(3);
		for (const record of records) {
			expect(Object.keys(record).sort()).toEqual(["email", "enrollment", "label", "provider", "readOnly"]);
			expect(record.provider).toBe("codex");
		}
		expect(records[0]).toEqual({ provider: "codex", label: "work", email: "a***@example.test", enrollment: "independent", readOnly: false });
		expect(records[1].email).toBe("b***@example.test");
		expect(records[1].label).not.toContain("bob@example.test");
		expect(records[2]).toMatchObject({ label: "imported", email: "c***@example.test", enrollment: "legacy", readOnly: true });

		for (const secret of [ACCESS, REFRESH, "access-token-bob", "legacy-access-token", home, "alice@example.test", "bob@example.test", "carol@example.test", "acct_fixture"]) {
			expect(masked.text).not.toContain(secret);
		}

		const shown = await run(["codex", "accounts", "--json", "--show-email"], { providers: [provider] });
		expect(shown.json().map(record => record.email)).toEqual(["alice@example.test", "bob@example.test", "carol@example.test"]);
		expect(shown.json()[1].label).not.toContain("bob@example.test");
		for (const secret of [ACCESS, REFRESH, "access-token-bob", "legacy-access-token", home, "acct_fixture"]) {
			expect(shown.text).not.toContain(secret);
		}

		const text = await run(["codex", "accounts"], { providers: [provider] });
		expect(text.text.split("\n").filter(Boolean)).toEqual([
			"codex\twork\tmanaged", "codex\t[redacted]\tmanaged", "codex\timported\treauth required",
		]);
	});

	test("without a provider it lists every registry provider's own store", async () => {
		const codexProvider = makeProvider({ login: credential() }).provider;
		const claudeProvider = makeProvider({ id: "claude", name: "Claude", login: { access: "sk-ant-oat-fixture", refresh: "sk-ant-ort-fixture", email: "dana@example.test" } }).provider;
		await run(["codex", "add", "work"], { providers: [codexProvider, claudeProvider] });
		await run(["claude", "add", "home"], { providers: [codexProvider, claudeProvider] });
		expect(listing()).toEqual([".claude-accounts.json", ".codex-accounts.json"]);

		const all = await run(["accounts", "--json"], { providers: [codexProvider, claudeProvider] });
		expect(all.json().map(record => [record.provider, record.label, record.email])).toEqual([
			["codex", "work", "a***@example.test"], ["claude", "home", "d***@example.test"],
		]);
		expect(all.text).not.toContain("sk-ant-");
		expect(all.text).not.toContain(ACCESS);
		const only = await run(["claude", "accounts", "--json"], { providers: [codexProvider, claudeProvider] });
		expect(only.json().map(record => record.provider)).toEqual(["claude"]);
	});
});

describe("cq sources", () => {
	const SOURCE_KEYS = ["identityKey", "kind", "label", "location", "provider", "writable"];

	function fixtureSources() {
		const managedPath = storePath("codex");
		return [
			{ provider: "codex", label: "work", kind: "managed", location: managedPath, identityKey: "acct_fixture_1", writable: true,
				access: ACCESS, refresh: REFRESH, token: "raw-token-should-never-print-5555555555" },
			{ provider: "codex", label: "team", kind: "env", location: "env:CODEX_ACCOUNTS", identityKey: null, writable: false, raw: { access_token: ACCESS } },
			{ provider: "codex", label: "cli", kind: "harness", location: join(home, ".codex", "auth.json"), identityKey: "acct_fixture_1", writable: false },
			{ provider: "codex", label: "cli", kind: "harness", location: join(home, ".codex", "auth.json"), identityKey: "acct_fixture_1", writable: false },
			{ provider: "codex", label: "proxx", kind: "remote", location: "https://user:pa55@proxx.example.test/api/usage?token=raw-query-token-6666&x=1#frag", identityKey: null, writable: false },
			{ provider: "codex", label: "odd", kind: "legacy", location: managedPath, identityKey: "erin@example.test", writable: "yes" },
			{ provider: "codex", label: `wo${ESC}[31mrk${ESC}[0m\x07 alice@example.test`, kind: "harness", location: `${home}/\x1b]0;title\x07x.json`, identityKey: null, writable: false },
		];
	}

	test("JSON is an allowlist of six fields with no raw tokens, duplicates preserved, credentials stripped from remote locations", async () => {
		const sources = fixtureSources();
		const { provider } = makeProvider({ sources });
		const result = await run(["codex", "sources", "--json"], { providers: [provider] });
		const records = result.json();

		expect(records).toHaveLength(sources.length);
		for (const record of records) {
			expect(Object.keys(record).sort()).toEqual(SOURCE_KEYS);
			expect(["managed", "env", "harness", "remote"]).toContain(record.kind);
			expect(typeof record.writable).toBe("boolean");
		}
		expect(records[2]).toEqual(records[3]);
		expect(records[0]).toMatchObject({ provider: "codex", label: "work", kind: "managed", identityKey: "acct_fixture_1", writable: true });
		expect(records[4].location).toBe("https://proxx.example.test/api/usage");
		expect(records[5].identityKey).toBe("e***@example.test");
		expect(records[5].writable).toBe(true);

		for (const secret of [ACCESS, REFRESH, "raw-token-should-never-print", "raw-query-token", "pa55", "erin@example.test", "alice@example.test", ESC, "\x07"]) {
			expect(result.text).not.toContain(secret);
		}
	});

	test("human output identifies unsafe labels safely: control sequences stripped, emails masked unless --show-email", async () => {
		const sources = fixtureSources();
		const { provider } = makeProvider({ sources });
		const text = (await run(["codex", "sources"], { providers: [provider] })).text;
		const lines = text.split("\n").filter(Boolean);
		expect(lines).toHaveLength(sources.length);
		for (const line of lines) {
			expect(line.split("\t")).toHaveLength(5);
			expect(line).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
		}
		expect(lines[6]).toContain("work a***@example.test");
		expect(lines[6]).not.toContain("alice@example.test");
		expect(lines[6]).not.toContain("title");
		expect(lines[5]).not.toContain("erin@example.test");
		expect(lines[4]).toContain("read-only\thttps://proxx.example.test/api/usage");
		expect(text).not.toContain(ACCESS);

		const shown = (await run(["codex", "sources", "--show-email"], { providers: [provider] })).text;
		expect(shown).toContain("work alice@example.test");
		expect(shown).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
		const shownJson = (await run(["codex", "sources", "--json", "--show-email"], { providers: [provider] })).json();
		expect(shownJson[5].identityKey).toBe("erin@example.test");
		expect(shownJson[6].label).toBe("work alice@example.test");
	});
});

describe("add → discover → fetch → provider.normalize → loadSnapshot → runCli --json", () => {
	/** Allowlisted public account/window keys (lib/snapshot.js toPublicAccount/toPublicWindow). */
	const ACCOUNT_KEYS = ["email", "error", "extras", "label", "plan", "status", "windows"];
	const WINDOW_KEYS = ["id", "label", "percentRemaining", "percentUsed", "resetsAt", "windowSeconds"];

	function expectRealSchema(display) {
		expect(display.schemaVersion).toBe(2);
		expect(display.complete).toBe(true);
		expect(display.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(display.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(display.providers).toHaveLength(1);
		expect(Object.keys(display.providers[0]).sort()).toEqual(["accounts", "error", "id", "loading", "name"]);
		expect(display.providers[0]).toMatchObject({ id: "codex", name: "Codex", error: null, loading: false });
		expect(display.providers[0].accounts).toHaveLength(1);
		expect(Object.keys(display.providers[0].accounts[0]).sort()).toEqual(ACCOUNT_KEYS);
		for (const window of display.providers[0].accounts[0].windows) {
			expect(Object.keys(window).sort()).toEqual(WINDOW_KEYS);
		}
		expect(display.summary).toMatchObject({ providerCount: 1, accountCount: 1 });
	}

	test("canonical Codex usage payload renders one healthy 5h window through the real pipeline", async () => {
		const { provider, calls } = makeProvider({ login: credential() });
		await run(["codex", "add", "work"], { providers: [provider] });

		const result = await run(["codex", "--json"], { providers: [provider] });
		const display = result.json();
		expectRealSchema(display);
		expect(calls.fetch).toBe(1);

		const account = display.providers[0].accounts[0];
		expect(account.label).toBe("work");
		expect(account.email).toBe("a***@example.test");
		expect(account.status).toBe("ok");
		expect(account.error).toBeNull();
		expect(account.windows).toHaveLength(1);
		expect(account.windows[0]).toMatchObject({ id: "session", percentRemaining: 90 });
		expect(account.windows[0].label).toMatch(/\S/);
		expect(display.summary).toMatchObject({ okCount: 1, errorCount: 0, loadingCount: 0 });

		for (const secret of [ACCESS, REFRESH, home, "alice@example.test", "acct_fixture"]) {
			expect(result.text).not.toContain(secret);
		}
		const shown = await run(["codex", "--json", "--show-email"], { providers: [provider] });
		expect(shown.json().providers[0].accounts[0].email).toBe("alice@example.test");
		expect(shown.text).not.toContain(ACCESS);
	});

	test("percent-remaining payload variant with absolute reset renders both windows with ISO resets", async () => {
		const usage = () => ({ usage: { rate_limit: {
			primary_window: { remaining_percent: 84, limit_window_seconds: 18000, reset_at: "2026-09-18T23:00:00Z" },
			secondary_window: { remaining_percent: 58, limit_window_seconds: 604800, reset_at: 1_790_000_000 },
		} } });
		const { provider } = makeProvider({ login: credential(), usage });
		await run(["codex", "add", "work"], { providers: [provider] });

		const display = (await run(["codex", "--json"], { providers: [provider] })).json();
		expectRealSchema(display);
		const account = display.providers[0].accounts[0];
		expect(account.status).toBe("ok");
		expect(account.windows.map(window => [window.id, window.percentRemaining, window.resetsAt])).toEqual([
			["session", 84, "2026-09-18T23:00:00.000Z"],
			["weekly", 58, new Date(1_790_000_000 * 1000).toISOString()],
		]);
	});

	test("a label filter scopes the scan to the matching managed row", async () => {
		let next = credential();
		const { provider, calls } = makeProvider({ login: () => next });
		await run(["codex", "add", "work"], { providers: [provider] });
		next = credential({ accountId: "acct_fixture_2", email: "bob@example.test" });
		await run(["codex", "add", "personal"], { providers: [provider] });

		const display = (await run(["codex", "personal", "--json"], { providers: [provider] })).json();
		expect(display.providers[0].accounts.map(account => [account.label, account.email])).toEqual([["personal", "b***@example.test"]]);
		expect(calls.fetch).toBe(1);
	});
});
