import { describe, expect, test } from "bun:test";
import { DEFAULT_INTERVAL, createAppState, completeScan, renderFrame, runWatch } from "../lib/tui/app.js";
import { openManage, beginAuth } from "../lib/tui/manage.js";
import { keyAction } from "../lib/tui/terminal.js";
import { cellWidth } from "../lib/tui/width.js";

const providers = [{ id: "codex", name: "Codex" }];
const snapshot = status => ({ schemaVersion: 2, generatedAt: "2026-09-18T20:00:00Z",
	providers: [{ ...providers[0], accounts: [{ label: "work", status, email: null,
		plan: null, windows: [] }] }] });

describe("watch app", () => {
	test("refreshes every 3 minutes by default", () => {
		expect(DEFAULT_INTERVAL).toBe(180);
		expect(createAppState({ providers }).interval).toBe(180);
	});
	test("completed and successful timestamps are distinct", () => {
		const state = createAppState({ providers });
		completeScan(state, snapshot("error"), 1000);
		expect(state.lastSuccessfulAt).toBeNull();
		expect(state.lastUpdatedAt).toBe("2026-09-18T20:00:00Z");
		expect(state.error).toBeNull();
		completeScan(state, snapshot("ok"), 2000);
		expect(state.lastSuccessfulAt).toBe(state.lastUpdatedAt);
	});
	test("chrome and help remain bounded at tiny sizes", () => {
		const state = createAppState({ providers });
		state.showHelp = true;
		for (const cols of [0, 1, 24, 80]) for (const rows of [0, 1, 2, 8, 24]) {
			const frame = renderFrame(state, { cols, rows }, { now: 0 });
			expect(frame.length).toBeLessThanOrEqual(rows);
			for (const line of frame) expect(cellWidth(line)).toBeLessThanOrEqual(cols);
		}
	});
	test("first scan paints loading cards instead of an empty-account result", () => {
		const state = createAppState({ providers });
		state.loading = true;
		const frame = renderFrame(state, { cols: 80, rows: 24 }, { now: 0 }).join("\n");
		expect(frame).toContain("loading");
		expect(frame).not.toContain("no accounts");
	});
	test("non-TTY fallback never starts a scan", async () => {
		let calls = 0;
		expect(await runWatch({ providers, loadSnapshot() { calls++; },
			terminalFactory: () => ({ start: () => false }) })).toBe(false);
		expect(calls).toBe(0);
	});
	test("quit restores immediately and awaits an in-flight scan safely", async () => {
		let hooks; let resolveScan; let stopped = false;
		const work = runWatch({ providers, loadSnapshot: () => new Promise(resolve => { resolveScan = resolve; }),
			terminalFactory(options) { hooks = options; return { start: () => true,
				stop() { stopped = true; }, size: { cols: 80, rows: 24 }, write() {} }; } });
		await Promise.resolve();
		hooks.onAction("quit");
		expect(stopped).toBe(true);
		resolveScan(snapshot("ok"));
		expect(await work).toBe(true);
	});
});

/**
 * Watch session with a fake terminal and an in-memory account service.
 * `press` routes keys the way the real terminal does: onKey first, then actions.
 */
function session({ rows = [], login, cols = 100 } = {}) {
	let hooks;
	const frames = []; const copies = []; const opened = []; const calls = [];
	let scans = 0;
	const service = {
		list: () => rows.map(row => ({ ...row })),
		manageable: id => id !== "cursor",
		async add(provider, label, loginContext) {
			calls.push(["add", label]);
			await provider.login({ ...loginContext, label });
			rows.push({ provider: provider.id, providerName: provider.name, label, email: null });
		},
		async reauth(provider, label, loginContext) {
			calls.push(["reauth", label]);
			await provider.login({ ...loginContext, label });
		},
		rename(provider, from, to) {
			if (rows.some(row => row.label === to)) throw new Error(`Account '${to}' already exists.`);
			rows.find(row => row.label === from).label = to;
		},
		remove(provider, label) { rows.splice(rows.findIndex(row => row.label === label), 1); },
		openBrowser: url => opened.push(url),
	};
	const work = runWatch({ providers: [{ id: "codex", name: "Codex", login }, { id: "cursor", name: "Cursor" }],
		accounts: service, async loadSnapshot() { scans++; return snapshot("ok"); },
		terminalFactory(options) {
			hooks = options;
			return { start: () => true, stop() {}, size: { cols, rows: 30 },
				write(lines) { frames.push(lines.join("\n")); }, copy(text) { copies.push(text); } };
		} });
	const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
	return {
		work, rows, frames, copies, opened, calls, settle, get scans() { return scans; },
		frame: () => frames.at(-1),
		async press(text, key = { name: text }) {
			if (!hooks.onKey(text, key)) {
				const action = keyAction(text, key);
				if (action) hooks.onAction(action);
			}
			await settle();
		},
		async type(text) { for (const ch of text) await this.press(ch); },
		async quit() { hooks.onAction("quit"); return work; },
	};
}

describe("account management in watch mode", () => {
	test("m opens the panel over the shell and esc closes it", async () => {
		const s = session({ rows: [{ provider: "codex", providerName: "Codex", label: "work", email: "a@example.test" }],
			login: ctx => { ctx.openBrowser("https://auth.example.test/r", { noBrowser: true }); return new Promise(() => {}); } });
		await s.settle();
		await s.press("m");
		expect(s.frame()).toContain("Accounts");
		expect(s.frame()).toContain("› work");
		expect(s.frame()).toContain("a***@example.test");
		expect(s.frame()).not.toContain("CURSOR");
		await s.press("r");
		expect(s.calls).toEqual([["reauth", "work"]]);
		expect(s.frame()).toContain("Reauthenticate");
		await s.press(undefined, { name: "escape" });
		expect(s.frame()).toContain("Sign-in cancelled");
		await s.press(undefined, { name: "escape" });
		expect(s.frame()).not.toContain("Accounts");
		expect(await s.quit()).toBe(true);
	});

	test("add signs in through the panel: URL, pasted code, persist, rescan", async () => {
		let seen;
		const s = session({ async login(ctx) {
			seen = ctx;
			ctx.stdout.write("Waiting for browser authentication...\n");
			ctx.openBrowser("https://auth.example.test/authorize?state=x", { noBrowser: false });
			const code = await ctx.prompt("Paste the code shown by Claude (code#state): ");
			return { access: code };
		} });
		await s.settle();
		const before = s.scans;
		await s.press("m");
		await s.press("a");
		await s.type("side");
		await s.press(undefined, { name: "return" });
		expect(seen.label).toBe("side");
		expect(s.opened).toEqual(["https://auth.example.test/authorize?state=x"]);
		expect(s.frame()).toContain("https://auth.example.test/authorize?state=x");
		expect(s.frame()).toContain("Paste the code shown by Claude");
		await s.press(undefined, { name: "y", ctrl: true });
		expect(s.copies).toEqual(["https://auth.example.test/authorize?state=x"]);
		expect(s.frame()).toContain("URL sent to the clipboard");
		await s.type("code#state");
		await s.press(undefined, { name: "return" });
		expect(s.rows.map(row => row.label)).toEqual(["side"]);
		expect(s.frame()).toContain("Added Codex side");
		expect(s.frame()).toContain("› side");
		expect(s.scans).toBeGreaterThan(before);
		await s.quit();
	});

	test("cancel aborts the sign-in and a late credential is never persisted", async () => {
		let release; let signal;
		const s = session({ async login(ctx) {
			signal = ctx.signal;
			ctx.openBrowser("https://auth.example.test/a", { noBrowser: true });
			await new Promise(resolve => { release = resolve; });
			return { access: "late" };
		} });
		await s.settle();
		await s.press("m");
		await s.press("a");
		await s.type("late");
		await s.press(undefined, { name: "return" });
		expect(s.opened).toEqual([]);
		await s.press(undefined, { name: "escape" });
		expect(signal.aborted).toBe(true);
		release();
		await s.settle();
		expect(s.rows).toEqual([]);
		expect(s.frame()).toContain("Sign-in cancelled");
		await s.quit();
	});

	test("quitting mid sign-in aborts it", async () => {
		let signal;
		const s = session({ login(ctx) { signal = ctx.signal; return new Promise(() => {}); } });
		await s.settle();
		await s.press("m");
		await s.press("a");
		await s.type("x");
		await s.press(undefined, { name: "return" });
		expect(await s.quit()).toBe(true);
		expect(signal.aborted).toBe(true);
	});

	test("rename and remove update the list; errors stay in the panel", async () => {
		const s = session({ rows: [
			{ provider: "codex", providerName: "Codex", label: "work", email: null },
			{ provider: "codex", providerName: "Codex", label: "home", email: null },
		] });
		await s.settle();
		await s.press("m");
		await s.press("n");
		await s.press(undefined, { name: "u", ctrl: true });
		await s.type("home");
		await s.press(undefined, { name: "return" });
		expect(s.frame()).toContain("already exists");
		await s.press(undefined, { name: "u", ctrl: true });
		await s.type("office");
		await s.press(undefined, { name: "return" });
		expect(s.frame()).toContain("Renamed work to office");
		expect(s.frame()).toContain("› office");
		await s.press("d");
		expect(s.frame()).toContain("Remove");
		await s.press("y");
		expect(s.rows.map(row => row.label)).toEqual(["home"]);
		expect(s.frame()).toContain("Removed Codex office");
		await s.quit();
	});

	test("panel frames stay bounded at every size and view", () => {
		const providers = [{ id: "codex", name: "Codex" }, { id: "claude", name: "Claude" }];
		const rows = Array.from({ length: 30 }, (_, i) => ({ provider: i % 2 ? "claude" : "codex",
			providerName: "x", label: `account-${i}-日本語-${"w".repeat(i)}`, email: `user${i}@example.test` }));
		const views = [
			m => m,
			m => { m.view = "form"; m.form = { kind: "add", providerIndex: 1, row: null, input: "x".repeat(200), error: "bad" }; return m; },
			m => { m.view = "confirm"; m.confirm = { row: rows[3] }; return m; },
			m => { beginAuth(m, { kind: "add", provider: "codex", label: "work" });
				Object.assign(m.auth, { url: `https://auth.example.test/?${"q".repeat(900)}`, prompt: "Paste", input: "c".repeat(300), note: "copied" }); return m; },
			m => { beginAuth(m, { kind: "reauth", provider: "codex", label: "work" }); Object.assign(m.auth, { url: "u", status: "error", error: "e".repeat(300) }); return m; },
		];
		for (const make of views) for (const cols of [0, 1, 20, 31, 50, 80, 140]) for (const height of [0, 1, 6, 8, 12, 24, 50]) {
			const state = createAppState({ providers });
			state.manage = make(openManage(providers, rows, { selectedKey: "claude:account-29" }));
			const frame = renderFrame(state, { cols, rows: height }, { now: 0, color: true });
			expect(frame.length).toBe(cols && height ? height : 0);
			for (const text of frame) expect(cellWidth(text)).toBe(cols);
		}
	});
});
