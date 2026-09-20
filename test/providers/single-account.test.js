import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeProvider } from "../../lib/providers/claude.js";
import { createAntigravityProvider } from "../../lib/providers/antigravity.js";
import { addManagedAccount, getManagedStorePath } from "../../lib/credential-store.js";

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "shuvquota-single-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

for (const [id, createProvider] of [["claude", createClaudeProvider], ["antigravity", createAntigravityProvider]]) {
	test(`${id}: explicit single-account preference picks the usable session, retains all sources`, async () => {
		const rows = [
			{ label: "old", kind: "harness", source: "old.json", access: "old-access", refresh: "old-refresh", expires: 1, email: "person@example.test" },
			{ label: "current", kind: "harness", source: "current.json", access: "new-access", refresh: "new-refresh", expires: Date.now() + 3600000 },
		];
		let refreshed = false;
		const provider = createProvider({ home, external: () => rows,
			env: { SHUVQUOTA_SINGLE_ACCOUNT_PROVIDERS: "claude,antigravity" },
			refresh: () => { refreshed = true; throw new Error("must not refresh external sessions"); },
			fetchUsage: async account => ({ selected: account.access }),
		});
		const accounts = await provider.discoverAccounts();
		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toMatchObject({ label: "current", email: "person@example.test", readOnly: true });
		expect(await provider.fetch(accounts[0])).toEqual({ selected: "new-access" });
		expect(refreshed).toBe(false);
		expect(await provider.discoverSources()).toHaveLength(2);
		expect(rows[1].email).toBeUndefined();
	});
	test(`${id}: no opt-in never collapses different credentials`, async () => {
		const provider = createProvider({ home, env: {}, external: () => [
			{ label: "one", kind: "harness", access: "one", refresh: "one-refresh", projectId: "shared-project" },
			{ label: "two", kind: "harness", access: "two", refresh: "two-refresh", projectId: "shared-project" },
		] });
		expect(await provider.discoverAccounts()).toHaveLength(2);
	});
	test(`${id}: explicit grouping retains the owned refresh identity and leaves the store intact`, async () => {
		addManagedAccount(id, { label: "owned", access: "owned-access", refresh: "owned-refresh", expires: 1 }, { home });
		const path = getManagedStorePath(id, { home });
		const before = readFileSync(path, "utf8");
		const provider = createProvider({ home, env: { SHUVQUOTA_SINGLE_ACCOUNT_PROVIDERS: id },
			external: () => [{ label: "external", kind: "harness", access: "external-access", refresh: "external-refresh", expires: Date.now() + 3600000 }],
		});
		const accounts = await provider.discoverAccounts();
		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toMatchObject({ label: "owned", managed: true, readOnly: false });
		expect(readFileSync(path, "utf8")).toBe(before);
	});
}
