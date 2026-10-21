/**
 * Watch shell and cell canvas: exact frame geometry at every size, colour
 * parity, email masking, selection, and the help overlay.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Canvas } from "../../lib/tui/canvas.js";
import {
	SIDEBAR_MIN_COLS, duration, renderShell, selectedIndex, summaryPercents, visibleCards,
} from "../../lib/tui/shell.js";
import { createAppState, completeScan, moveSelection, renderFrame } from "../../lib/tui/app.js";
import { cellWidth, stripAnsi } from "../../lib/tui/width.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASIC = JSON.parse(readFileSync(join(HERE, "fixtures", "snapshot-basic.json"), "utf8"));
const NOW = Date.parse("2026-09-17T19:00:00Z");

function view(overrides = {}) {
	return {
		snapshot: BASIC, providerFilter: null, selected: null, showEmail: false, showHelp: false,
		loading: false, error: null, lastUpdatedAt: "2026-09-17T19:00:00Z", nextRefreshAt: NOW + 42_000,
		interval: 60, ...overrides,
	};
}

describe("Canvas", () => {
	test("rows are exactly cols cells, with or without colour", () => {
		const canvas = new Canvas(10, 2, { bg: "#000000" });
		canvas.fill(0, 0, 10, 1, { bg: "#112233" });
		canvas.text(1, 0, "hello", { fg: "#ffffff", bold: true });
		canvas.text(0, 1, "日本語テキスト");
		const plain = canvas.toLines(false);
		expect(plain).toEqual([" hello    ", "日本語テ… "]);
		const colored = canvas.toLines(true);
		expect(colored.map(stripAnsi)).toEqual(plain);
		expect(colored[0]).toContain("\x1b[0;1;38;2;255;255;255;48;2;17;34;51m");
	});

	test("text inherits the painted background and clips with an ellipsis", () => {
		const canvas = new Canvas(8, 1);
		canvas.fill(0, 0, 8, 1, { bg: "#010203" });
		expect(canvas.text(2, 0, "abcdefgh", { fg: "#ffffff" })).toBe(8);
		expect(canvas.toLines(false)).toEqual(["  abcde…"]);
		expect(canvas.cells[0][3].style.bg).toBe("#010203");
	});

	test("overwriting half of a wide glyph blanks the other half", () => {
		const canvas = new Canvas(4, 1);
		canvas.text(0, 0, "日");
		canvas.text(1, 0, "x");
		expect(canvas.toLines(false)).toEqual([" x  "]);
		const filled = new Canvas(4, 1);
		filled.text(0, 0, "日本");
		filled.fill(1, 0, 2, 1, {});
		expect(filled.toLines(false)).toEqual(["    "]);
	});

	test("sanitizes control and escape sequences in text", () => {
		const canvas = new Canvas(12, 1);
		canvas.text(0, 0, "a\x1b[2Jb\x07c");
		expect(canvas.toLines(false)[0]).toBe("abc         ");
	});
});

describe("renderShell", () => {
	test("every frame is exactly rows × cols at many sizes, coloured or not", () => {
		for (const cols of [1, 10, 24, 40, 71, 72, 80, 120, 200]) {
			for (const rows of [1, 2, 3, 5, 8, 24, 50]) {
				for (const extra of [{}, { showHelp: true }, { showUpNext: true }, { loading: true }, { error: "Quota unavailable" }]) {
					const plain = renderShell(view(extra), { cols, rows }, { now: NOW, color: false }).lines;
					const colored = renderShell(view(extra), { cols, rows }, { now: NOW, color: true }).lines;
					expect(plain).toHaveLength(rows);
					for (const line of plain) expect(cellWidth(line)).toBe(cols);
					expect(colored.map(stripAnsi)).toEqual(plain);
				}
			}
		}
	});

	test("wide terminals show sidebar and detail; narrow ones show only the list", () => {
		const wide = renderShell(view(), { cols: 120, rows: 30 }, { now: NOW, color: false }).lines.join("\n");
		expect(wide).toContain("ACCOUNTS");
		expect(wide).toContain("personal");
		expect(wide).toContain("日本語ラベル");
		const narrow = renderShell(view(), { cols: SIDEBAR_MIN_COLS - 1, rows: 30 }, { now: NOW, color: false }).lines.slice(1, -1).join("\n");
		expect(narrow).toContain("ACCOUNTS");
		expect(narrow).not.toContain("LIMITS");
		expect(narrow).not.toContain("│");
		expect(narrow).toMatch(/● work {10,}7%/);
	});

	test("each provider is a block with an accent bar and closing padding row", () => {
		const lines = renderShell(view(), { cols: 50, rows: 24 }, { now: NOW, color: false }).lines;
		const start = lines.findIndex(line => line.includes("CODEX"));
		expect(lines.slice(start, start + 5).map(line => line.slice(0, 3))).toEqual([" ▎ ", " ▎ ", " ▎ ", " ▎ ", "   "]);
		expect(lines[start + 3].trim()).toBe("▎");
	});

	test("narrow provider views stack the list above the selected account's detail", () => {
		const size = { cols: SIDEBAR_MIN_COLS - 1, rows: 30 };
		const lines = renderShell(view({ providerFilter: "claude" }), size, { now: NOW, color: false }).lines;
		const text = lines.join("\n");
		expect(text).toContain("LIMITS");
		expect(lines.findIndex(line => line.includes("● main"))).toBeLessThan(lines.findIndex(line => line.includes("LIMITS")));
		expect(text).not.toContain("‹");
		const short = renderShell(view({ providerFilter: "claude" }), { ...size, rows: 12 }, { now: NOW, color: false }).lines.join("\n");
		expect(short).not.toContain("LIMITS");
		const all = renderShell(view(), size, { now: NOW, color: false }).lines.join("\n");
		expect(all).not.toContain("LIMITS");
	});

	test("top bar starts with the gauge wordmark", () => {
		const [top] = renderShell(view(), { cols: 80, rows: 10 }, { now: NOW, color: false }).lines;
		expect(top.startsWith(" ▂▄▆█ shuvquota │")).toBe(true);
	});

	test("emails are masked unless revealed", () => {
		const selected = "codex:work";
		const masked = renderShell(view({ selected }), { cols: 120, rows: 30 }, { now: NOW, color: false }).lines.join("\n");
		expect(masked).toContain("s***@example.org");
		expect(masked).not.toContain("shuv@example.org");
		const shown = renderShell(view({ selected, showEmail: true }), { cols: 120, rows: 30 }, { now: NOW, color: false }).lines.join("\n");
		expect(shown).toContain("shuv@example.org");
	});

	test("the detail pane shows the selected account's windows, countdowns, and extras", () => {
		const lines = renderShell(view({ selected: "claude:main 👩‍💻" }), { cols: 120, rows: 40 }, { now: NOW, color: false }).lines.join("\n");
		expect(lines).toContain("Session");
		expect(lines).toContain("64%");
		expect(lines).toContain("LIMITS");
		expect(lines).toContain("Resets in 3h 15m");
		expect(lines).toContain("MAX 20X");
		expect(lines).toContain("DETAILS");
		expect(lines).toMatch(/ org {10,}acme /);
		expect(lines).not.toContain("UP NEXT");
	});

	test("upcoming resets appear only when toggled on, soonest first", () => {
		const lines = renderShell(view({ selected: "codex:work", showUpNext: true }), { cols: 120, rows: 40 }, { now: NOW, color: false }).lines;
		const start = lines.findIndex(line => line.includes("UP NEXT"));
		expect(start).toBeGreaterThan(0);
		const rows = lines.slice(start + 2).filter(line => /\d+%/.test(line.slice(40)));
		expect(rows[0]).toContain("2h 30m");
		expect(rows.find(line => line.includes("▸"))).toContain("work");
	});

	test("error accounts show their message in the detail pane", () => {
		const lines = renderShell(view({ selected: "codex:personal" }), { cols: 120, rows: 30 }, { now: NOW, color: false }).lines.join("\n");
		expect(lines).toContain("✕  HTTP 401 unauthorized");
		expect(lines).toContain("Manage sign-ins with  m");
	});

	test("empty providers suggest the enrollment command", () => {
		const snapshot = { schemaVersion: 2, providers: [{ id: "grok", name: "Grok", accounts: [] }] };
		const lines = renderShell(view({ snapshot }), { cols: 100, rows: 20 }, { now: NOW, color: false }).lines.join("\n");
		expect(lines).toContain("Add one with  m  a");
	});

	test("status bar summarizes accounts, low quota, and errors", () => {
		const lines = renderShell(view(), { cols: 160, rows: 30 }, { now: NOW, color: false }).lines;
		const status = lines.at(-1);
		expect(status).toContain("LIVE");
		expect(status).toContain("next 42s");
		expect(status).toContain("5 accounts");
		expect(status).toContain("2 low");
		expect(status).toContain("2 errors");
		expect(status).toContain("every 1m");
		expect(status).toContain("? help");
	});

	test("help renders as an overlay", () => {
		const lines = renderShell(view({ showHelp: true }), { cols: 100, rows: 30 }, { now: NOW, color: false }).lines.join("\n");
		expect(lines).toContain("Keys");
		expect(lines).toContain("filter by provider");
	});

	test("provider filter narrows the visible accounts and marks the active tab", () => {
		const cards = visibleCards(BASIC, "claude");
		expect(cards.map(card => card.key)).toEqual(["claude:main 👩‍💻"]);
		const lines = renderShell(view({ providerFilter: "claude" }), { cols: 100, rows: 30 }, { now: NOW, color: false }).lines.join("\n");
		expect(lines).not.toContain("personal");
	});
});

describe("summaries", () => {
	test("Claude shows total weekly plus model-specific weekly limits", () => {
		const card = { providerId: "claude", kind: "account", account: { windows: [
			{ id: "session", label: "Session", percentRemaining: 83 },
			{ id: "weekly", label: "Weekly", percentRemaining: 55 },
			{ id: "fable-weekly", label: "Fable weekly", percentRemaining: 29 },
		] } };
		expect(summaryPercents(card)).toEqual([{ label: "", percent: 55 }, { label: "fable", percent: 29 }]);
		const lines = renderShell(view({ snapshot: { schemaVersion: 2, providers: [{ id: "claude", name: "Claude",
			accounts: [{ label: "work", status: "ok", windows: card.account.windows }] }] } }),
		{ cols: 50, rows: 12 }, { now: NOW, color: false }).lines.join("\n");
		expect(lines).toMatch(/● work {5,}fable 29% {3}55%/);
	});

	test("Cursor headlines API usage even when total is lower", () => {
		const windows = [
			{ id: "api", label: "API", percentRemaining: 40 },
			{ id: "total", label: "Total usage", percentRemaining: 12 },
			{ id: "auto", label: "Auto", percentRemaining: 100 },
		];
		expect(summaryPercents({ providerId: "cursor", kind: "account", account: { windows } }))
			.toEqual([{ label: "", percent: 40 }]);
		const lines = renderShell(view({ snapshot: { schemaVersion: 2, providers: [{ id: "cursor", name: "Cursor",
			accounts: [{ label: "Cursor-3", status: "ok", windows }] }] } }),
		{ cols: 50, rows: 12 }, { now: NOW, color: false }).lines.join("\n");
		expect(lines).toMatch(/● Cursor-3 +40%/);
	});

	test("other providers show their lowest window", () => {
		const card = { providerId: "codex", kind: "account", account: { windows: [
			{ id: "5h", label: "5h", percentRemaining: 80 }, { id: "weekly", label: "Weekly", percentRemaining: 23 },
		] } };
		expect(summaryPercents(card)).toEqual([{ label: "", percent: 23 }]);
	});

	test("durations read naturally", () => {
		expect(duration(42)).toBe("42s");
		expect(duration(180)).toBe("3m");
		expect(duration(178)).toBe("2m 58s");
	});
});

describe("selection", () => {
	test("selectedIndex falls back to the same provider, then the first card", () => {
		const cards = visibleCards(BASIC, null);
		expect(selectedIndex(cards, "claude:main 👩‍💻")).toBe(2);
		expect(selectedIndex(cards, "antigravity:gone")).toBe(4);
		expect(selectedIndex(cards, "nope")).toBe(0);
		expect(selectedIndex([], "x")).toBe(-1);
	});

	test("moveSelection clamps to the visible accounts", () => {
		const state = createAppState({ providers: BASIC.providers });
		completeScan(state, BASIC, NOW);
		renderFrame(state, { cols: 100, rows: 30 }, { now: NOW });
		expect(state.selected).toBe("codex:personal");
		moveSelection(state, 1);
		expect(state.selected).toBe("codex:work");
		moveSelection(state, 99);
		expect(state.selected).toBe("antigravity:日本語ラベル");
		moveSelection(state, -99);
		expect(state.selected).toBe("codex:personal");
	});
});
