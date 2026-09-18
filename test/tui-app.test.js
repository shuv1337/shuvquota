import { describe, expect, test } from "bun:test";
import { createAppState, completeScan, renderFrame, runWatch } from "../lib/tui/app.js";
import { cellWidth } from "../lib/tui/width.js";

const providers = [{ id: "codex", name: "Codex" }];
const snapshot = status => ({ schemaVersion: 2, generatedAt: "2026-09-18T20:00:00Z",
	providers: [{ ...providers[0], accounts: [{ label: "work", status, email: null,
		plan: null, windows: [] }] }] });

describe("watch app", () => {
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
