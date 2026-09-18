import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createTerminal, keyAction } from "../lib/tui/terminal.js";

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
		terminal: createTerminal({ input, output, proc, keypress() {}, ...options }) };
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
		terminal.start(); input.emit("keypress", "r", {}); output.emit("resize");
		expect(actions).toEqual(["refresh"]); expect(resized).toBe(1);
		terminal.stop(); input.emit("keypress", "r", {}); output.emit("resize");
		expect(actions).toEqual(["refresh"]); expect(resized).toBe(1);
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
		expect(output.text.endsWith("x".repeat(80))).toBe(true);
		expect(output.text).toContain(`\x1b[H\x1b[2J${"x".repeat(80)}`);
		terminal.stop();
	});
});
