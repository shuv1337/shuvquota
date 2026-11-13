import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeGoProvider } from "../../lib/providers/opencode-go.js";

describe("OpenCode Go", () => {
	test("discovers a read-only key and normalizes server usage", async () => {
		const home = mkdtempSync(join(tmpdir(), "go-quota-"));
		try {
			mkdirSync(join(home, "opencode"));
			writeFileSync(join(home, "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "fixture-key" } }));
			const provider = createOpenCodeGoProvider({ dataHome: home, dbPaths: [], envKey: "", fetchFn: async (_url, options) => {
				expect(options.headers.Authorization).toBe("Bearer fixture-key");
				return { ok: true, json: async () => ({ usage: { rolling: { percent: 5, resetsAt: "2026-12-01T00:00:00Z" }, weekly: { percent: 46 }, monthly: { percent: 100 } } }) };
			} });
			const [account] = await provider.discoverAccounts();
			expect(JSON.stringify(await provider.discoverSources())).not.toContain("fixture-key");
			const snapshot = provider.normalize(account, await provider.fetch(account));
			expect(snapshot.windows.map(w => w.percentRemaining)).toEqual([95, 54, 0]);
			expect(snapshot.windows[0].resetsAt).toBe("2026-12-01T00:00:00.000Z");
		} finally { rmSync(home, { recursive: true, force: true }); }
	});
	test("does not expose HTTP response content", async () => {
		const provider = createOpenCodeGoProvider({ fetchFn: async () => ({ ok: false, status: 401 }) });
		await expect(provider.fetch({ apiKey: "secret" })).rejects.toThrow("HTTP 401");
	});
});
