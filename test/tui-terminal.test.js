import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createTerminal, keyAction, parseKeys } from "../lib/tui/terminal.js";

function fixture(options = {}) {
	const input = new EventEmitter();
	Object.assign(input, { isTTY: true, isRaw: false, paused: true,
		setRawMode(raw) { this.isRaw = raw; }, isPaused() { return this.paused; },
		pause() { this.paused = true; }, resume() { this.paused = false; } });
	const output = new EventEmitter();
	Object.assign(output, { isTTY: true, columns: 80, rows: 24, text: "",
		write(text) { this.text += text; } });
	const proc = new EventEmitter();
	return { input, output, proc,
		terminal: createTerminal({ input, output, proc, ...options }) };
}

describe("terminal lifecycle", () => {
	test("restores original raw and paused states, once", () => {
		const { terminal, input, output, proc } = fixture();
		expect(terminal.start()).toBe(true);
		expect(input.isRaw).toBe(true);
		expect(input.paused).toBe(false);
		terminal.stop();
		const restored = output.text;
		terminal.stop();
		expect(input.isRaw).toBe(false);
		expect(input.paused).toBe(true);
		expect(output.text).toBe(restored);
		expect(output.text).toContain("\x1b[?25h\x1b[?1049l");
		expect(proc.eventNames()).toEqual([]);
	});
	test.each(["exit", "SIGINT", "SIGTERM", "uncaughtExceptionMonitor"])(
		"restores on %s", event => {
			const { terminal, input, proc } = fixture();
			terminal.start(); proc.emit(event);
			expect(input.isRaw).toBe(false);
			expect(terminal.active).toBe(false);
		},
	);
	test("refuses redirected stdin or stdout without writing control sequences", () => {
		for (const target of ["input", "output"]) {
			const f = fixture(); f[target].isTTY = false;
			expect(f.terminal.start()).toBe(false);
			expect(f.output.text).toBe("");
		}
	});
	test("dispatches keys and resize and removes listeners on stop", () => {
		const actions = []; let resized = 0;
		const { terminal, input, output } = fixture({ onAction: a => actions.push(a),
			onResize: () => resized++ });
		terminal.start(); input.emit("data", "r"); output.emit("resize");
		expect(actions).toEqual(["refresh"]); expect(resized).toBe(1);
		terminal.stop(); input.emit("data", "r"); output.emit("resize");
		expect(actions).toEqual(["refresh"]); expect(resized).toBe(1);
	});
	test("onKey sees keys first; Ctrl-C always quits", () => {
		const actions = []; const keys = [];
		let consume = true;
		const { terminal, input } = fixture({ onAction: a => actions.push(a),
			onKey: (text, key) => { keys.push(key.name); return consume; } });
		terminal.start();
		input.emit("data", "q");
		input.emit("data", "\x03");
		expect(keys).toEqual(["q"]);
		expect(actions).toEqual(["quit"]);
		consume = false;
		input.emit("data", Buffer.from("m"));
		expect(actions).toEqual(["quit", "manage"]);
	});
	test("copy writes OSC 52 only while active", () => {
		const { terminal, output } = fixture();
		terminal.copy("https://x");
		expect(output.text).toBe("");
		terminal.start();
		terminal.copy("https://x");
		expect(output.text).toContain(`\x1b]52;c;${Buffer.from("https://x").toString("base64")}\x07`);
	});
	test("key mapping includes explicit all-provider selection", () => {
		expect(keyAction("1")).toBe("all");
		expect(keyAction("5")).toBe("antigravity");
		expect(keyAction("", { ctrl: true, name: "c" })).toBe("quit");
		expect(keyAction("", { name: "pagedown" })).toBe("pageDown");
	});
	test("pauses initially dormant stdin even when isPaused reports false", () => {
		const { terminal, input } = fixture();
		input.readableFlowing = null;
		input.paused = false;
		terminal.start(); terminal.stop();
		expect(input.paused).toBe(true);
	});
	test("preserves an already-flowing input stream", () => {
		const { terminal, input } = fixture();
		input.readableFlowing = true;
		input.paused = false;
		terminal.start(); terminal.stop();
		expect(input.paused).toBe(false);
	});
	test("erases the tail of every line when frames shrink", () => {
		const { terminal, output } = fixture();
		terminal.start();
		terminal.write(["short", ""]);
		expect(output.text).toContain("\x1b[H\x1b[2Jshort\r\n");
		terminal.stop();
	});
	test("never erases after a full-width final cell", () => {
		const { terminal, output } = fixture();
		terminal.start();
		terminal.write(["x".repeat(80)]);
		// Only the synchronized-update terminator follows the final cell.
		expect(output.text.endsWith(`${"x".repeat(80)}\x1b[?2026l`)).toBe(true);
		expect(output.text).toContain(`\x1b[?2026h\x1b[H\x1b[2J${"x".repeat(80)}`);
		terminal.stop();
	});
});

describe("parseKeys", () => {
	const names = chunk => parseKeys(chunk).map(({ key }) => key.name);
	test("a lone ESC is Escape at once, never a pending prefix", () => {
		expect(parseKeys("\x1b")).toEqual([{ text: "\x1b", key: { name: "escape", sequence: "\x1b" } }]);
		expect(names("\x1b\x1b")).toEqual(["escape", "escape"]);
		expect(names("q")).toEqual(["q"]);
	});
	test("cursor, paging, and modified keys", () => {
		expect(names("\x1b[A\x1b[B\x1bOC\x1bOD\x1b[5~\x1b[6~\x1b[3~")).toEqual(["up", "down", "right", "left", "pageup", "pagedown", "delete"]);
		expect(parseKeys("\x1b[Z")[0].key).toMatchObject({ name: "tab", shift: true });
		expect(parseKeys("\x1b[1;5C")[0].key).toMatchObject({ name: "right", ctrl: true, shift: false });
		expect(parseKeys("\x1b[200~")).toEqual([]);
		expect(parseKeys("\x1b[M")).toEqual([]);
	});
	test("control, alt, and plain characters", () => {
		expect(parseKeys("\x03")[0].key).toMatchObject({ name: "c", ctrl: true });
		expect(parseKeys("\x19")[0].key).toMatchObject({ name: "y", ctrl: true });
		expect(names("\r\n\t\x7f\b ")).toEqual(["return", "enter", "tab", "backspace", "backspace", "space"]);
		expect(parseKeys("\x1bq")[0]).toEqual({ text: "q", key: { name: "q", shift: false, meta: true, sequence: "\x1bq" } });
		expect(parseKeys("R")[0].key).toMatchObject({ name: "r", shift: true });
		expect(parseKeys("?")[0]).toEqual({ text: "?", key: { name: undefined, sequence: "?" } });
		expect(parseKeys("日😀").map(({ text }) => text)).toEqual(["日", "😀"]);
	});
	test("a pasted URL arrives as its characters", () => {
		const url = "http://127.0.0.1:1455/auth/callback?code=ab#st";
		expect(parseKeys(url).map(({ text }) => text).join("")).toBe(url);
	});
	test("split UTF-8 across reads decodes once complete", () => {
		const keys = []; const { terminal, input } = fixture({ onKey: (text) => { keys.push(text); return true; } });
		terminal.start();
		const bytes = Buffer.from("é");
		input.emit("data", bytes.subarray(0, 1));
		input.emit("data", bytes.subarray(1));
		expect(keys).toEqual(["é"]);
	});
});
