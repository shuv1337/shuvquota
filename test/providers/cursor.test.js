import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCursorProvider, fetchCursorUsage } from "../../lib/providers/cursor.js";
import { loadSnapshot } from "../../lib/quota.js";
import { toPublicSnapshot } from "../../lib/snapshot.js";
import { renderStatic } from "../../lib/tui/render.js";

test("T3 keys exchange into ephemeral sessions; source duplicates remain physical and stores stay unchanged", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "cursor-quota-"));
	try {
		mkdirSync(join(stateDir, "secrets"));
		const encode = value => Buffer.from(value).toString("base64url");
		const keyPath = join(stateDir, "secrets", `provider-env-${encode("one")}-${encode("CURSOR_API_KEY")}.bin`);
		writeFileSync(keyPath, "fixture-api-key");
		const settingsPath = join(stateDir, "settings.json");
		const config = JSON.stringify({ providerInstances: {
			one: { driver: "cursor", displayName: "Personal", environment: [{ name: "CURSOR_API_KEY", sensitive: true, valueRedacted: true }] },
			two: { driver: "cursor", environment: [{ name: "CURSOR_API_KEY", value: "fixture-api-key" }] },
		} });
		writeFileSync(settingsPath, config);
		const calls = [];
		const provider = createCursorProvider({ stateDir, authDir: "", fetchFn: async (url, options) => {
			calls.push([url, options.headers.authorization]);
			return Response.json(url.endsWith("exchange_user_api_key")
				? { accessToken: "fixture-access", refreshToken: "must-not-be-written" }
				: { billingCycleEnd: "1791504000000", planUsage: { totalPercentUsed: 0.5, apiPercentUsed: 100 } });
		} });
		expect(provider.discoverSources()).toHaveLength(2);
		expect(JSON.stringify(provider.discoverSources())).not.toContain("fixture-api-key");
		expect(await provider.discoverAccounts()).toHaveLength(1);
		const snapshot = toPublicSnapshot(await loadSnapshot({ providers: [provider] }));
		const account = snapshot.providers[0].accounts[0];
		expect(account.status).toBe("ok");
		expect(account.windows.map(w => w.percentRemaining)).toEqual([99.5, 0]);
		expect(account.windows[0].resetsAt).toBe("2026-10-09T00:00:00.000Z");
		expect(calls.map(c => c[1])).toEqual(["Bearer fixture-api-key", "Bearer fixture-access"]);
		expect(JSON.stringify(snapshot)).not.toContain("fixture-");
		expect(JSON.stringify(snapshot)).not.toContain(stateDir);
		expect(renderStatic(snapshot, { columns: 100, color: false }).join("\n")).toContain("Cursor");
		expect(readFileSync(settingsPath, "utf8")).toBe(config);
		expect(readFileSync(keyPath, "utf8")).toBe("fixture-api-key");
	} finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("authentication failures never echo provider response bodies", async () => {
	await expect(fetchCursorUsage("secret", async () => new Response("secret", { status: 401 })))
		.rejects.toThrow("Cursor authentication required");
});

const jwt = (sub, exp = 4102444800) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.fixture`;

test("cursorprox merges by token subject, preserves physical sources, skips disabled rows and rereads rotated access", async () => {
	const root = mkdtempSync(join(tmpdir(), "cursor-proxy-"));
	try {
		const stateDir = join(root, "t3");
		const authDir = join(root, "auths");
		mkdirSync(stateDir); mkdirSync(authDir);
		writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ providerInstances: {
			personal: { driver: "cursor", displayName: "Cursor-1", environment: [{ name: "CURSOR_API_KEY", value: "fixture-key" }] },
		} }));
		const records = {
			"overlap.json": { type: "cursor", access_token: jwt("same"), email: "person@example.com" },
			"extra.json": { type: "cursor", access_token: jwt("extra"), email: "extra@example.com", refresh_token: "never-refresh-me" },
			"disabled.json": { type: "cursor", access_token: jwt("disabled"), disabled: true },
			"unknown-one.json": { type: "cursor", access_token: "opaque-one" },
			"unknown-two.json": { type: "cursor", access_token: "opaque-two" },
		};
		for (const [file, record] of Object.entries(records)) writeFileSync(join(authDir, file), JSON.stringify(record));
		writeFileSync(join(authDir, "invalid.json"), "{broken");
		const calls = [];
		const provider = createCursorProvider({ stateDir, authDir, fetchFn: async (url, options) => {
			calls.push(options.headers.authorization);
			return Response.json(url.endsWith("exchange_user_api_key")
				? { accessToken: jwt("same"), refreshToken: "discard" }
				: { planUsage: { totalPercentUsed: 35 } });
		} });
		expect(provider.discoverSources()).toHaveLength(5);
		expect(JSON.stringify(provider.discoverSources())).not.toContain("access_token");
		const accounts = await provider.discoverAccounts();
		expect(accounts).toHaveLength(4);
		expect(accounts.find(a => a.accountId === "same").label).toBe("Cursor-1");
		const snapshot = toPublicSnapshot(await loadSnapshot({ providers: [provider] }));
		expect(snapshot.providers[0].accounts).toHaveLength(4);
		expect(snapshot.providers[0].accounts.every(a => a.status === "ok")).toBe(true);
		expect(snapshot.providers[0].accounts[0].windows[0].label).toBe("Total usage");
		const output = JSON.stringify(snapshot);
		for (const secret of ["fixture-key", "never-refresh-me", "person@example.com", root, jwt("extra")]) expect(output).not.toContain(secret);
		expect(calls).not.toContain("Bearer never-refresh-me");
		for (const [file, record] of Object.entries(records)) expect(readFileSync(join(authDir, file), "utf8")).toBe(JSON.stringify(record));
		const rotated = jwt("extra", 4102444900);
		writeFileSync(join(authDir, "extra.json"), JSON.stringify({ ...records["extra.json"], access_token: rotated }));
		const refreshed = (await provider.discoverAccounts()).find(a => a.accountId === "extra");
		await provider.fetch(refreshed);
		expect(calls.at(-1)).toBe(`Bearer ${rotated}`);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("expired cursorprox sessions fail without refreshing or contacting the provider", async () => {
	const authDir = mkdtempSync(join(tmpdir(), "cursor-expired-"));
	try {
		const record = JSON.stringify({ type: "cursor", access_token: jwt("expired", 1), refresh_token: "external-refresh" });
		const file = join(authDir, "expired.json");
		writeFileSync(file, record);
		let calls = 0;
		const provider = createCursorProvider({ stateDir: "", authDir, fetchFn: async () => { calls++; throw new Error("unexpected HTTP"); } });
		await expect(provider.fetch((await provider.discoverAccounts())[0])).rejects.toThrow("reauthenticate in cursorprox");
		expect(calls).toBe(0);
		expect(readFileSync(file, "utf8")).toBe(record);
	} finally { rmSync(authDir, { recursive: true, force: true }); }
});
