/**
 * lib/accounts.js — owned-account operations shared by the CLI and watch TUI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as store from "../lib/credential-store.js";
import {
	AccountError, addAccount, isManageable, listAccounts, reauthAccount, removeAccount, renameAccount, validateLabel,
} from "../lib/accounts.js";

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "shuvquota-accounts-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** Real store with `home` pinned, matching the argument positions the service uses. */
function bound() {
	const at = { listManagedAccounts: 1, findManagedAccount: 2, addManagedAccount: 2,
		replaceManagedAccount: 3, renameManagedAccount: 3, removeManagedAccount: 2 };
	return Object.fromEntries(Object.entries(at).map(([name, index]) => [name, (...args) => {
		const full = Array.from({ length: index + 1 }, (_, i) => args[i]);
		full[index] = { home };
		return store[name](...full);
	}]));
}

function provider(id = "codex", credential = { access: "fixture-access", refresh: "fixture-refresh", email: "a@example.test" }) {
	const calls = [];
	return { calls, provider: { id, name: id[0].toUpperCase() + id.slice(1), async login(ctx) { calls.push(ctx); return credential; } } };
}

describe("account service", () => {
	test("only providers with an owned store are manageable", () => {
		expect(["codex", "claude", "grok", "antigravity"].every(isManageable)).toBe(true);
		expect(isManageable("cursor")).toBe(false);
	});

	test("add, reauth, rename, and remove round-trip through the owned store", async () => {
		const options = { store: bound() };
		const { provider: codex, calls } = provider();
		await addAccount(codex, "work", { ...options, loginContext: { signal: "s" } });
		expect(calls[0]).toEqual({ signal: "s", label: "work" });
		expect(listAccounts([codex, { id: "cursor", name: "Cursor" }], options)).toEqual([
			{ provider: "codex", providerName: "Codex", label: "work", email: "a@example.test" },
		]);
		await reauthAccount(codex, "work", options);
		expect(calls).toHaveLength(2);
		renameAccount(codex, "work", "office", options);
		expect(listAccounts([codex], options).map(row => row.label)).toEqual(["office"]);
		expect(renameAccount(codex, "office", "office", options)).toEqual({ provider: "codex", label: "office" });
		removeAccount(codex, "office", options);
		expect(listAccounts([codex], options)).toEqual([]);
	});

	test("duplicates and missing accounts fail before any browser opens", async () => {
		const options = { store: bound() };
		const { provider: codex, calls } = provider();
		await addAccount(codex, "work", options);
		await expect(addAccount(codex, "work", options)).rejects.toThrow(AccountError);
		await expect(reauthAccount(codex, "missing", options)).rejects.toThrow(/'missing' not found/);
		expect(calls).toHaveLength(1);
		await addAccount(codex, "other", options);
		expect(() => renameAccount(codex, "work", "other", options)).toThrow(/'other' already exists\.$/);
		expect(() => removeAccount(codex, "missing", options)).toThrow(/'missing' not found/);
	});

	test("read-only providers and invalid labels are refused", async () => {
		const options = { store: bound() };
		const { provider: cursor, calls } = provider("cursor");
		await expect(addAccount(cursor, "x", options)).rejects.toThrow(/read-only sources/);
		expect(() => removeAccount({ id: "proxx", name: "Proxx" }, "x", options)).toThrow(/Proxx accounts are read-only/);
		expect(calls).toHaveLength(0);
		for (const label of ["", "  ", "bad\x1b[0m", 5]) expect(() => validateLabel(label)).toThrow(AccountError);
		expect(validateLabel(" spaced ")).toBe(" spaced ");
	});
});
