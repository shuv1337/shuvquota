/**
 * Account-management panel: pure state transitions and the effects they request.
 */

import { describe, expect, test } from "bun:test";
import { LABEL_MAX, beginAuth, editLine, failAuth, manageKey, openManage, showList } from "../../lib/tui/manage.js";

const PROVIDERS = [{ id: "codex", name: "Codex" }, { id: "claude", name: "Claude" }];
const ROWS = [
	{ provider: "codex", providerName: "Codex", label: "work", email: "a@example.test" },
	{ provider: "codex", providerName: "Codex", label: "personal", email: null },
	{ provider: "claude", providerName: "Claude", label: "home", email: null },
];
const type = (manage, text) => { for (const ch of text) manageKey(manage, ch, { name: ch }); };
const key = (manage, name, extra = {}) => manageKey(manage, undefined, { name, ...extra });

describe("openManage", () => {
	test("scopes to a manageable provider tab and selects the focused account", () => {
		const manage = openManage(PROVIDERS, ROWS, { providerFilter: "claude", selectedKey: "claude:home" });
		expect(manage.providers.map(p => p.id)).toEqual(["claude"]);
		expect(manage.rows.map(r => r.label)).toEqual(["home"]);
		const all = openManage(PROVIDERS, ROWS, { providerFilter: "cursor", selectedKey: "codex:personal" });
		expect(all.providers).toHaveLength(2);
		expect(all.cursor).toBe(1);
		expect(openManage(PROVIDERS, ROWS, { selectedKey: "claude:vanished" }).cursor).toBe(2);
	});
});

describe("list", () => {
	test("moves within rows and maps keys to effects", () => {
		const manage = openManage(PROVIDERS, ROWS);
		key(manage, "up");
		expect(manage.cursor).toBe(0);
		manageKey(manage, "j", { name: "j" });
		manageKey(manage, "j", { name: "j" });
		manageKey(manage, "j", { name: "j" });
		expect(manage.cursor).toBe(2);
		expect(manageKey(manage, "r", { name: "r" })).toEqual({ type: "reauth", provider: "claude", label: "home" });
		expect(key(manage, "escape")).toEqual({ type: "close" });
		expect(manageKey(manage, "m", { name: "m" })).toEqual({ type: "close" });
	});

	test("without accounts only add is available", () => {
		const manage = openManage(PROVIDERS, []);
		expect(manageKey(manage, "r", { name: "r" })).toBeNull();
		expect(manageKey(manage, "d", { name: "d" })).toBeNull();
		expect(manage.view).toBe("list");
		manageKey(manage, "a", { name: "a" });
		expect(manage.view).toBe("form");
	});
});

describe("forms", () => {
	test("add picks a provider and trims the label", () => {
		const manage = openManage(PROVIDERS, ROWS, { selectedKey: "claude:home" });
		manageKey(manage, "a", { name: "a" });
		expect(manage.form.providerIndex).toBe(1);
		key(manage, "right");
		expect(manage.form.providerIndex).toBe(0);
		key(manage, "tab", { shift: true });
		expect(manage.form.providerIndex).toBe(1);
		expect(key(manage, "return")).toBeNull();
		expect(manage.form.error).toBe("Enter a label.");
		type(manage, "  side ");
		expect(manage.form.error).toBeNull();
		expect(key(manage, "return")).toEqual({ type: "add", provider: "claude", label: "side" });
		key(manage, "escape");
		expect(manage.view).toBe("list");
		expect(manage.form).toBeNull();
	});

	test("rename starts from the current label", () => {
		const manage = openManage(PROVIDERS, ROWS);
		manageKey(manage, "n", { name: "n" });
		expect(manage.form.input).toBe("work");
		key(manage, "u", { ctrl: true });
		type(manage, "office");
		expect(key(manage, "enter")).toEqual({ type: "rename", provider: "codex", from: "work", to: "office" });
	});

	test("remove needs an explicit y", () => {
		const manage = openManage(PROVIDERS, ROWS);
		manageKey(manage, "d", { name: "d" });
		expect(manage.view).toBe("confirm");
		expect(key(manage, "return")).toBeNull();
		manageKey(manage, "n", { name: "n" });
		expect(manage.view).toBe("list");
		manageKey(manage, "d", { name: "d" });
		expect(manageKey(manage, "y", { name: "y" })).toEqual({ type: "remove", provider: "codex", label: "work" });
	});
});

describe("editLine", () => {
	test("edits, strips control sequences, and caps length", () => {
		expect(editLine("ab", "c", { name: "c" })).toBe("abc");
		expect(editLine("ab", undefined, { name: "backspace" })).toBe("a");
		expect(editLine("日本", undefined, { name: "backspace" })).toBe("日");
		expect(editLine("one two ", undefined, { name: "w", ctrl: true })).toBe("one ");
		expect(editLine("x", "\x1b[A", { name: "up" })).toBeNull();
		expect(editLine("x", "\r", { name: "return" })).toBeNull();
		expect(editLine("x", "a", { name: "a", meta: true })).toBeNull();
		expect(editLine("", "https://e.test/cb?code=1#s", {})).toBe("https://e.test/cb?code=1#s");
		expect(editLine("a".repeat(LABEL_MAX), "b", {}, LABEL_MAX)).toHaveLength(LABEL_MAX);
	});
});

describe("sign-in", () => {
	test("copy and open need a URL; the prompt edits and submits", () => {
		const manage = openManage(PROVIDERS, ROWS);
		beginAuth(manage, { kind: "reauth", provider: "codex", label: "work" });
		expect(manage.auth).toMatchObject({ providerName: "Codex", status: "starting" });
		expect(key(manage, "y", { ctrl: true })).toBeNull();
		manage.auth.url = "https://auth.example.test/authorize";
		expect(key(manage, "y", { ctrl: true })).toEqual({ type: "copy" });
		expect(key(manage, "o", { ctrl: true })).toEqual({ type: "open" });
		type(manage, "ignored");
		expect(manage.auth.input).toBe("");
		manage.auth.prompt = "Paste the code";
		expect(key(manage, "return")).toBeNull();
		type(manage, "code#state");
		expect(key(manage, "return")).toEqual({ type: "submit", value: "code#state" });
		expect(key(manage, "escape")).toEqual({ type: "cancel" });
	});

	test("failures before a URL return to the form; later ones stay on screen", () => {
		const manage = openManage(PROVIDERS, ROWS);
		manageKey(manage, "a", { name: "a" });
		beginAuth(manage, { kind: "add", provider: "codex", label: "work" });
		failAuth(manage, "Account 'work' already exists. Use reauth.");
		expect(manage.view).toBe("form");
		expect(manage.form.error).toMatch(/already exists/);

		beginAuth(manage, { kind: "reauth", provider: "codex", label: "work" });
		manage.form = null;
		failAuth(manage, "Port in use");
		expect(manage.view).toBe("list");
		expect(manage.notice).toEqual({ text: "Port in use", tone: "bad" });

		beginAuth(manage, { kind: "reauth", provider: "codex", label: "work" });
		manage.auth.url = "https://auth.example.test";
		manage.auth.prompt = "Paste";
		failAuth(manage, "State mismatch");
		expect(manage.auth).toMatchObject({ status: "error", error: "State mismatch", prompt: null });
		expect(key(manage, "escape")).toBeNull();
		expect(manage.view).toBe("list");
	});

	test("showList reloads rows and keeps the cursor on the changed account", () => {
		const manage = openManage(PROVIDERS, ROWS);
		showList(manage, { text: "Renamed", tone: "good" }, [...ROWS, { provider: "codex", providerName: "Codex", label: "new", email: null }], "codex:new");
		expect(manage.rows[manage.cursor].label).toBe("new");
		expect(manage.notice.text).toBe("Renamed");
	});
});
