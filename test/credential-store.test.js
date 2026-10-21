import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	getManagedStorePath, listManagedAccounts, addManagedAccount, replaceManagedAccount,
	renameManagedAccount, removeManagedAccount, findManagedAccount, updateManagedAccountTokens,
	fanOutManagedAccountTokens, withManagedAccountLock,
} from "../lib/credential-store.js";

let home;
let options;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "shuvquota-owned-")); options = { home }; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const credential = label => ({ label, access: "old-access", refresh: "old-refresh", expires: 1 });

describe.each(["codex", "claude", "grok", "antigravity"])("%s managed-store contract", provider => {
	test("add, rename, reauth, remove with private atomic writes", () => {
		const path = getManagedStorePath(provider, options);
		writeFileSync(path, JSON.stringify({ activeLabel: "obsolete", note: "keep", accounts: [] }));
		addManagedAccount(provider, credential("work"), options);
		expect(listManagedAccounts(provider, options)[0]).toMatchObject({ label: "work", raw: { enrollment: "independent" } });
		expect(() => addManagedAccount(provider, credential("work"), options)).toThrow("already exists");
		renameManagedAccount(provider, "work", "office", options);
		replaceManagedAccount(provider, "office", { access: "fresh-access", refresh: "fresh-refresh" }, options);
		expect(findManagedAccount(provider, "office", options).entry.access).toBe("fresh-access");
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ note: "keep" });
		expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("activeLabel");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(removeManagedAccount(provider, "office", options).removed).toBe(true);
		expect(listManagedAccounts(provider, options)).toEqual([]);
		expect(() => replaceManagedAccount(provider, "missing", credential("x"), options)).toThrow("not found");
	});
	test("rows without the enrollment stamp are ignored and dropped by the next write", () => {
		const path = getManagedStorePath(provider, options);
		writeFileSync(path, JSON.stringify([credential("legacy")]));
		expect(listManagedAccounts(provider, options)).toEqual([]);
		expect(findManagedAccount(provider, "legacy", options)).toBeNull();
		expect(updateManagedAccountTokens(provider, "legacy", { access: "new" }, {}, options).reason).toBe("not-found");
		expect(() => renameManagedAccount(provider, "legacy", "renamed", options)).toThrow("not found");
		expect(() => replaceManagedAccount(provider, "legacy", credential("legacy"), options)).toThrow("not found");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([credential("legacy")]);
		addManagedAccount(provider, credential("legacy"), options);
		expect(JSON.parse(readFileSync(path, "utf8")).accounts).toEqual([{ ...credential("legacy"), enrollment: "independent" }]);
	});
	test("refresh CAS never falls back to shared access when refresh sessions diverged", () => {
		addManagedAccount(provider, credential("work"), options);
		const result = updateManagedAccountTokens(provider, "work", { refresh: "wrong" },
			{ previousRefresh: "different-session", previousAccess: "old-access" }, options);
		expect(result.reason).toBe("stale");
		expect(findManagedAccount(provider, "work", options).entry.refresh).toBe("old-refresh");
	});
	test("known external token coincidence refuses persistence", () => {
		addManagedAccount(provider, credential("work"), options);
		const before = readFileSync(getManagedStorePath(provider, options), "utf8");
		const result = updateManagedAccountTokens(provider, "work", { refresh: "new" }, {},
			{ ...options, harnessRefreshTokens: ["old-refresh"] });
		expect(result.reason).toBe("coincident-harness-token");
		expect(readFileSync(getManagedStorePath(provider, options), "utf8")).toBe(before);
	});
	test("fan-out changes only owned entries in the same refresh session", () => {
		addManagedAccount(provider, credential("a"), options);
		addManagedAccount(provider, credential("b"), options);
		addManagedAccount(provider, { ...credential("other"), refresh: "another-session" }, options);
		const result = fanOutManagedAccountTokens(provider, { access: "next-access", refresh: "next-refresh" },
			{ previousRefresh: "old-refresh", previousAccess: "old-access" }, options);
		expect(result.updatedLabels).toEqual(["a", "b"]);
		expect(findManagedAccount(provider, "b", options).entry.refresh).toBe("next-refresh");
		expect(findManagedAccount(provider, "other", options).entry.refresh).toBe("another-session");
	});
	test("two labels sharing credentials serialize and reread the refreshed store", async () => {
		addManagedAccount(provider, credential("a"), options);
		addManagedAccount(provider, credential("b"), options);
		let refreshes = 0;
		const refresh = label => withManagedAccountLock(provider, label, async () => {
			const current = findManagedAccount(provider, label, options).entry;
			if (current.refresh !== "old-refresh") return;
			refreshes++;
			await Promise.resolve();
			fanOutManagedAccountTokens(provider, { refresh: "next-refresh" }, { previousRefresh: current.refresh }, options);
		}, options);
		await Promise.all([refresh("a"), refresh("b")]);
		expect(refreshes).toBe(1);
	});
	test("every mutation rejects corrupted containers", () => {
		const path = getManagedStorePath(provider, options);
		for (const corrupt of ["{broken", '{"accounts":"not an array"}']) {
			writeFileSync(path, corrupt);
			for (const mutate of [
				() => addManagedAccount(provider, credential("x"), options),
				() => replaceManagedAccount(provider, "x", credential("x"), options),
				() => renameManagedAccount(provider, "x", "y", options),
				() => removeManagedAccount(provider, "x", options),
				() => updateManagedAccountTokens(provider, "x", {}, {}, options),
				() => fanOutManagedAccountTokens(provider, {}, {}, options),
			]) expect(mutate).toThrow();
			expect(readFileSync(path, "utf8")).toBe(corrupt);
		}
	});
});
