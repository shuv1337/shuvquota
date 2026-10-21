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
		const provider = createCursorProvider({ stateDir, fetchFn: async (url, options) => {
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
		expect(account.windows.map(w => [w.id, w.percentRemaining])).toEqual([["api", 0], ["total", 99.5]]);
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

test("every T3 instance with a key is an account, disabled ones included; enabled wins a shared key", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "cursor-disabled-"));
	try {
		writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ providerInstances: {
			off: { driver: "cursor", displayName: "Cursor-3", enabled: false, environment: [{ name: "CURSOR_API_KEY", value: "key-off" }] },
			dupe: { driver: "cursor", displayName: "Cursor-9", enabled: false, environment: [{ name: "CURSOR_API_KEY", value: "key-on" }] },
			on: { driver: "cursor", displayName: "Cursor-4", environment: [{ name: "CURSOR_API_KEY", value: "key-on" }] },
			nokey: { driver: "cursor", displayName: "Cursor-5", environment: [] },
			other: { driver: "codex", displayName: "Codex", environment: [{ name: "CURSOR_API_KEY", value: "key-x" }] },
		} }));
		const provider = createCursorProvider({ stateDir, fetchFn: async () => { throw new Error("no network in discovery"); } });
		expect(provider.discoverSources().map(s => s.label)).toEqual(["Cursor-3", "Cursor-9", "Cursor-4"]);
		expect((await provider.discoverAccounts()).map(a => a.label)).toEqual(["Cursor-4", "Cursor-3"]);
	} finally { rmSync(stateDir, { recursive: true, force: true }); }
});
