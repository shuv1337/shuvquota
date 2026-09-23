/**
 * Pure renderers: golden frames at the plan's terminal sizes, width bounds,
 * redaction, control-injection safety, Unicode alignment, colour parity,
 * reset formatting in Pacific time. Imports lib/tui/render.js directly.
 *
 * Regenerate goldens with: UPDATE_GOLDENS=1 bun test test/tui/render.test.js
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cellWidth, stripAnsi } from "../../lib/tui/width.js";
import { computeLayout, cardHeight } from "../../lib/tui/layout.js";
import {
	DEFAULT_TIME_ZONE,
	BAR_MIN_WIDTH,
	BAR_MAX_WIDTH,
	formatReset,
	formatPercent,
	percentTone,
	formatBar,
	barWidthFor,
	redactEmail,
	headerLine,
	windowLine,
	renderCard,
	tableLabel,
	renderTable,
	renderLayout,
	scrollIndicator,
	renderView,
	renderStatic,
	renderCompact,
} from "../../lib/tui/render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const GOLDEN_DIR = join(FIXTURES, "golden");
const BASIC = JSON.parse(readFileSync(join(FIXTURES, "snapshot-basic.json"), "utf8"));
const NOW = "2026-09-17T19:00:00Z"; // 12:00 Thu America/Los_Angeles (PDT)
const UPDATE = process.env.UPDATE_GOLDENS === "1";

const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/**
 * @param {number} count
 * @returns {object}
 */
function manyAccounts(count) {
	return {
		schemaVersion: 2,
		providers: [{
			id: "codex",
			name: "Codex",
			accounts: Array.from({ length: count }, (_, i) => ({
				label: `acct-${String(i + 1).padStart(2, "0")}`,
				email: `user${i}@example.org`,
				plan: "Plus",
				status: "ok",
				windows: [
					{ id: "5h", label: "5h", percentRemaining: 100 - i * 7, resetsAt: "2026-09-17T23:00:00Z" },
					{ id: "weekly", label: "Weekly", percentRemaining: 50, resetsAt: "2026-09-20T07:00:00Z" },
				],
			})),
		}],
	};
}

/**
 * Compare `actual` with the stored golden, or write it when UPDATE_GOLDENS=1.
 * Arrays of lines (the renderStatic/renderCompact return type) are joined with "\n".
 * @param {string} name
 * @param {string | string[]} value
 */
function expectGolden(name, value) {
	const actual = Array.isArray(value) ? value.join("\n") : value;
	const path = join(GOLDEN_DIR, `${name}.txt`);
	if (UPDATE) {
		mkdirSync(GOLDEN_DIR, { recursive: true });
		writeFileSync(path, actual);
		return;
	}
	if (!existsSync(path)) {
		throw new Error(`Missing golden ${path}; run UPDATE_GOLDENS=1 bun test test/tui/render.test.js`);
	}
	expect(actual).toBe(readFileSync(path, "utf8"));
}

/**
 * Every line: ≤ cols cells, no control characters, no ANSI (when colour off).
 * @param {string[]} lines
 * @param {number} cols
 */
function expectBounded(lines, cols) {
	for (const line of lines) {
		expect(cellWidth(line)).toBeLessThanOrEqual(cols);
		expect(line).not.toMatch(CONTROL_RE);
		expect(line).not.toContain("\x1b");
		expect(line).not.toContain("\t");
	}
}

describe("formatReset (Pacific by default)", () => {
	test("long style: HH:MM Weekday in America/Los_Angeles, h23 clock", () => {
		expect(DEFAULT_TIME_ZONE).toBe("America/Los_Angeles");
		expect(formatReset("2026-09-17T22:15:00Z", NOW)).toBe("15:15 Thu");
		expect(formatReset("2026-09-20T07:00:00Z", NOW)).toBe("00:00 Sun");
		expect(formatReset("2026-09-18T07:30:00Z", NOW)).toBe("00:30 Fri");
	});

	test("long style switches to a date when 6+ days out", () => {
		expect(formatReset("2026-09-24T19:00:00Z", NOW)).toBe("12:00 Sep 24");
		expect(formatReset("2026-09-23T18:59:00Z", NOW)).toBe("11:59 Wed");
	});

	test("short style: relative m/h/d", () => {
		expect(formatReset("2026-09-17T19:45:00Z", NOW, "short")).toBe("45m");
		expect(formatReset("2026-09-17T22:15:00Z", NOW, "short")).toBe("3h");
		expect(formatReset("2026-09-20T07:00:00Z", NOW, "short")).toBe("2d");
		expect(formatReset("2026-09-24T19:00:00Z", NOW, "short")).toBe("7d");
	});

	test("past or imminent resets read \"now\"; bad input reads empty", () => {
		expect(formatReset("2026-09-17T18:00:00Z", NOW)).toBe("now");
		expect(formatReset("2026-09-17T19:00:30Z", NOW, "short")).toBe("now");
		expect(formatReset(null, NOW)).toBe("");
		expect(formatReset("not a date", NOW)).toBe("");
		expect(formatReset(undefined, NOW, "short")).toBe("");
	});

	test("honours an explicit time zone and falls back on an invalid one", () => {
		expect(formatReset("2026-09-17T22:15:00Z", NOW, "long", "UTC")).toBe("22:15 Thu");
		expect(formatReset("2026-09-17T22:15:00Z", NOW, "long", "Not/AZone")).toBe("15:15 Thu");
	});

	test("accepts Date and epoch inputs for now", () => {
		expect(formatReset("2026-09-17T22:15:00Z", new Date(NOW))).toBe("15:15 Thu");
		expect(formatReset("2026-09-17T22:15:00Z", Date.parse(NOW))).toBe("15:15 Thu");
	});
});

describe("formatPercent / percentTone / formatBar", () => {
	test("percent text is rounded, clamped, and never missing", () => {
		expect(formatPercent(64)).toBe("64%");
		expect(formatPercent(64.6)).toBe("65%");
		expect(formatPercent(150)).toBe("100%");
		expect(formatPercent(-5)).toBe("0%");
		expect(formatPercent(null)).toBe("--%");
		expect(formatPercent(NaN)).toBe("--%");
	});

	test("tone thresholds (§3.3: ≤20 red, ≤60 yellow, else green)", () => {
		expect(percentTone(100)).toBe("good");
		expect(percentTone(61)).toBe("good");
		expect(percentTone(60.5)).toBe("good");
		expect(percentTone(60)).toBe("warn");
		expect(percentTone(59)).toBe("warn");
		expect(percentTone(21)).toBe("warn");
		expect(percentTone(20)).toBe("bad");
		expect(percentTone(0)).toBe("bad");
		expect(percentTone(null)).toBe("none");
		expect(percentTone(NaN)).toBe("none");
	});

	test("bar geometry is exact, half-cell precise, and uses only single-cell glyphs", () => {
		expect(formatBar(50, 10)).toBe("━━━━━─────");
		expect(formatBar(55, 10)).toBe("━━━━━╸────");
		expect(formatBar(100, 8)).toBe("━━━━━━━━");
		expect(formatBar(0, 8)).toBe("────────");
		expect(formatBar(null, 8)).toBe("────────");
		expect(formatBar(33, 9)).toBe("━━━──────");
		for (const width of [0, 1, 8, 30]) {
			expect(cellWidth(formatBar(64, width))).toBe(width);
		}
		expect(formatBar(50, -3)).toBe("");
		expect(formatBar(50, NaN)).toBe("");
	});

	test("barWidthFor clamps to [BAR_MIN_WIDTH, BAR_MAX_WIDTH]", () => {
		expect(BAR_MIN_WIDTH).toBe(8);
		expect(BAR_MAX_WIDTH).toBe(56);
		// label + 2 + bar + 2 + percent(4) + 2 + tail
		expect(barWidthFor(44, 6, 16)).toBe(44 - 14 - 18);
		expect(barWidthFor(200, 6, 16)).toBe(56);
		expect(barWidthFor(20, 6, 16)).toBe(8);
		expect(barWidthFor(44, 6, 0)).toBe(30);
	});
});

describe("redactEmail", () => {
	test("keeps the first local character and the domain", () => {
		expect(redactEmail("someone@example.com")).toBe("s***@example.com");
		expect(redactEmail("日本@example.jp")).toBe("日***@example.jp");
		expect(redactEmail("a@b.c")).toBe("a***@b.c");
	});

	test("handles missing @ and empty input", () => {
		expect(redactEmail("nomail")).toBe("n***");
		expect(redactEmail("@x.y")).toBe("***@x.y");
		expect(redactEmail("")).toBe("");
		expect(redactEmail(null)).toBe("");
	});
});

describe("headerLine", () => {
	const [personal, work, claude, grok] = computeLayout(BASIC, { cols: 200 }).cards;

	test("redacts email by default and shows it with showEmail", () => {
		expect(headerLine(work, { showEmail: false })).toBe("Codex · work · Plus · s***@example.org");
		expect(headerLine(work, { showEmail: true })).toBe("Codex · work · Plus · shuv@example.org");
	});

	test("omits missing plan/email and renders provider cards as the provider name", () => {
		expect(headerLine(personal, { showEmail: false })).toBe("Codex · personal · Free · p***@example.org");
		expect(headerLine(claude, { showEmail: false })).toBe("Claude · main 👩‍💻 · Max 20x · s***@example.com");
		expect(headerLine(grok, { showEmail: false })).toBe("SuperGrok");
	});
});

describe("windowLine", () => {
	const ctx = { innerWidth: 44, labelWidth: 6, now: new Date(NOW), timeZone: DEFAULT_TIME_ZONE, color: false };
	const weekly = { id: "weekly", label: "Weekly", percentRemaining: 41, resetsAt: "2026-09-22T17:00:00Z" };
	const unknown = { id: "x", label: "Sonnet", percentRemaining: null, resetsAt: null };

	test("tier 3 keeps label, bar, percent, countdown, and clock within innerWidth", () => {
		const line = windowLine(weekly, { ...ctx, tier: 3 });
		// 44 − label 6 − gaps 8 − percent 4 − countdown 6 − clock 9 = bar 11; 41% of 22 halves → 4½.
		expect(line).toBe("Weekly  ━━━━╸──────   41%  4d 22h  Tue 10:00");
		expect(cellWidth(line)).toBe(44);
	});

	test("tier 2 drops the clock and widens the bar", () => {
		const line = windowLine(weekly, { ...ctx, tier: 2, innerWidth: 36 });
		expect(line).toBe("Weekly  ━━━━━╸────────   41%  4d 22h");
		expect(cellWidth(line)).toBe(36);
	});

	test("tier 1 drops the bar but keeps percent and countdown", () => {
		expect(windowLine(weekly, { ...ctx, tier: 1, innerWidth: 28 })).toBe("Weekly   41%  4d 22h");
		expect(windowLine(unknown, { ...ctx, tier: 1, innerWidth: 28 })).toBe("Sonnet   --%");
	});

	test("unknown percent renders --% with an empty bar", () => {
		const line = windowLine(unknown, { ...ctx, tier: 3 });
		expect(line).toContain("--%");
		expect(line).not.toContain("━");
	});

	test("percent text survives at the minimum widths; the reset tail gives way first", () => {
		for (const [tier, innerWidth] of [[3, 40], [2, 32], [1, 24]]) {
			for (const window of [weekly, { ...weekly, percentRemaining: 100 }, unknown]) {
				const line = windowLine(window, { ...ctx, tier, innerWidth });
				expect(cellWidth(line)).toBeLessThanOrEqual(innerWidth);
				expect(line).toContain(formatPercent(window.percentRemaining));
			}
		}
	});

	test("shared column geometry is honoured when supplied", () => {
		const line = windowLine(weekly, { ...ctx, tier: 3, labelWidth: 6, barWidth: 10, relWidth: 6, clockWidth: 0 });
		expect(line).toBe("Weekly  ━━━━──────   41%  4d 22h");
	});

	test("colour styles bar, percent, and clock without changing width", () => {
		const plain = windowLine(weekly, { ...ctx, tier: 3 });
		const colored = windowLine(weekly, { ...ctx, tier: 3, color: true });
		expect(stripAnsi(colored)).toBe(plain);
		expect(colored).toContain("\x1b[33m");
		expect(colored).toContain("\x1b[1;33m");
		expect(cellWidth(colored)).toBe(cellWidth(plain));
	});
});

describe("renderCard", () => {
	const cards = computeLayout(BASIC, { cols: 200 }).cards;
	const byKey = Object.fromEntries(cards.map(c => [c.key, c]));

	test("emits exactly cardHeight lines of exactly width cells with a rounded border", () => {
		for (const card of cards) {
			for (const tier of [1, 2, 3]) {
				for (const width of [28, 36, 44, 48, 59, 80]) {
					const lines = renderCard(card, { tier, width, showExtras: tier === 3, now: NOW });
					expect(lines).toHaveLength(cardHeight(card, tier, tier === 3));
					for (const line of lines) expect(cellWidth(line)).toBe(width);
					expect(lines[0].startsWith("╭")).toBe(true);
					expect(lines[0].endsWith("╮")).toBe(true);
					expect(lines.at(-1).startsWith("╰")).toBe(true);
					expect(lines.at(-1).endsWith("╯")).toBe(true);
					for (const line of lines.slice(1, -1)) {
						expect(line.startsWith("│ ")).toBe(true);
						expect(line.endsWith(" │")).toBe(true);
					}
				}
			}
		}
	});

	test("bars inside one card share a width so the percent column aligns", () => {
		const lines = renderCard(byKey["claude:main 👩‍💻"], { tier: 3, width: 59, now: NOW });
		const bodies = lines.slice(1, 4);
		const barLengths = bodies.map(line => (line.match(/[━╸─]+/) ?? [""])[0].length);
		expect(new Set(barLengths).size).toBe(1);
		const pctColumns = bodies.map(line => line.indexOf("%"));
		expect(new Set(pctColumns).size).toBe(1);
	});

	test("error, loading, provider-error, and empty states are visible", () => {
		expect(renderCard(byKey["codex:personal"], { tier: 3, width: 48, now: NOW })[1]).toContain("✕ HTTP 401 unauthorized");
		expect(renderCard(byKey["antigravity:pending"], { tier: 3, width: 48, now: NOW })[1]).toContain("loading…");
		expect(renderCard(byKey["grok:"], { tier: 3, width: 48, now: NOW })[1]).toContain("✕ token refresh failed: invalid_grant");
		const [empty] = computeLayout({ providers: [{ id: "claude", name: "Claude" }] }, { cols: 80 }).cards;
		expect(renderCard(empty, { tier: 3, width: 48, now: NOW })[1]).toContain("no accounts");
		const [noWindows] = computeLayout({ providers: [{ id: "claude", accounts: [{ label: "x" }] }] }, { cols: 80 }).cards;
		expect(renderCard(noWindows, { tier: 3, width: 48, now: NOW })[1]).toContain("no quota windows");
	});

	test("the title sits in the top border and drops email before the label", () => {
		const work = byKey["codex:work"];
		expect(renderCard(work, { tier: 3, width: 48, now: NOW })[0]).toBe("╭─ Codex  work · Plus ────── s***@example.org ─╮");
		expect(renderCard(work, { tier: 3, width: 30, now: NOW })[0]).toBe("╭─ Codex  work · Plus ───────╮");
		expect(renderCard(work, { tier: 3, width: 14, now: NOW })[0]).toBe("╭─ Codex  w…─╮");
	});

	test("extras appear in the bottom border only when showExtras is set", () => {
		const with_ = renderCard(byKey["codex:work"], { tier: 3, width: 48, showExtras: true, now: NOW });
		const without = renderCard(byKey["codex:work"], { tier: 3, width: 48, showExtras: false, now: NOW });
		expect(with_.at(-1)).toBe(`╰─ credits 12 ${"─".repeat(33)}╯`);
		expect(without.join("\n")).not.toContain("credits");
		expect(with_.length).toBe(without.length);
	});

	test("explicit height pads or truncates deterministically", () => {
		const padded = renderCard(byKey["codex:personal"], { tier: 3, width: 40, height: 7, now: NOW });
		expect(padded).toHaveLength(7);
		expect(padded[5]).toBe(`│ ${" ".repeat(36)} │`);
		expect(padded[6].startsWith("╰")).toBe(true);
		const clipped = renderCard(byKey["claude:main 👩‍💻"], { tier: 3, width: 40, height: 3, now: NOW });
		expect(clipped).toHaveLength(3);
		expect(clipped[2].startsWith("╰")).toBe(true);
	});

	test("tiny widths and zero height never crash", () => {
		for (const width of [0, 1, 2, 3, 4, 5]) {
			const lines = renderCard(byKey["codex:work"], { tier: 3, width, now: NOW });
			for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(renderCard(byKey["codex:work"], { tier: 3, width: 48, height: 0, now: NOW })).toEqual([]);
		expect(renderCard(byKey["codex:work"], { tier: 3, width: 48, height: 1, now: NOW })).toHaveLength(1);
	});
});

describe("renderTable (tier 0)", () => {
	test("abbreviates known window labels and truncates others", () => {
		expect(tableLabel("Weekly")).toBe("wk");
		expect(tableLabel("monthly")).toBe("mo");
		expect(tableLabel("Session")).toBe("sess");
		expect(tableLabel("5h")).toBe("5h");
		expect(tableLabel("Opus 4.1 long")).toBe("Opu…");
	});

	test("emits one line per window, naming provider and account once per group", () => {
		const layout = computeLayout(BASIC, { cols: 80, rows: 10 });
		expect(layout.tier).toBe(0);
		const lines = renderTable(layout, { now: NOW });
		expect(lines).toHaveLength(layout.totalHeight);
		expectBounded(lines, 80);
		expect(lines[1]).toMatch(/^\s+work\s+5h\s+━+\s+100%\s+4h 59m$/);
		expect(lines[2]).toMatch(/^\s+Weekly\s+━+─+\s+7%\s+7d$/);
		expect(lines[0]).toMatch(/^ Codex\s+personal\s+✕ HTTP 401 unauthorized$/);
		// Bars and percents align across every window row.
		const pct = lines.filter(line => line.includes("%")).map(line => cellWidth(line.slice(0, line.indexOf("%"))));
		expect(new Set(pct).size).toBe(1);
	});

	test("narrow lists abbreviate labels and drop the countdown instead of cutting it", () => {
		const lines = renderTable(computeLayout(BASIC, { cols: 27, rows: 40 }), { now: NOW });
		expectBounded(lines, 27);
		expect(lines[1]).toMatch(/5h\s+100%$/);
		expect(lines[2]).toMatch(/wk\s+7%$/);
	});

	test("empty snapshot renders a single message", () => {
		const layout = computeLayout({ providers: [] }, { cols: 20 });
		expect(renderTable(layout, {})).toEqual(["No quota data       "]);
		expect(renderLayout(layout, {})).toEqual(["No quota data       "]);
	});
});

describe("renderLayout / renderView", () => {
	test("emits exactly layout.totalHeight lines at every plan size", () => {
		for (const [cols, rows] of [[200, 50], [120, 40], [80, 24], [60, 20], [45, 30], [30, 12], [24, 8]]) {
			const layout = computeLayout(BASIC, { cols, rows });
			const lines = renderLayout(layout, { now: NOW });
			expect(lines).toHaveLength(layout.totalHeight);
			expectBounded(lines, cols);
		}
	});

	test("renderView slices to the viewport and reports an indicator", () => {
		// 12 accounts at 80×12 fall to the tier-0 list (24 lines) and scroll.
		const layout = computeLayout(manyAccounts(12), { cols: 80, rows: 12, scroll: 1 });
		expect(layout.tier).toBe(0);
		const view = renderView(layout, { now: NOW });
		expect(view.lines).toHaveLength(12);
		expect(view.lines).toEqual(renderLayout(layout, { now: NOW }).slice(1, 13));
		expect(view.indicator).toBe("↑1 ↓11");
		expect(view.viewport.offset).toBe(1);
	});

	test("scrollIndicator is empty when everything fits", () => {
		const layout = computeLayout(BASIC, { cols: 200, rows: 50 });
		expect(scrollIndicator(layout.viewport)).toBe("");
		expect(renderView(layout, { now: NOW }).lines).toHaveLength(layout.totalHeight);
		expect(scrollIndicator(null)).toBe("");
	});

	test("unbounded rows returns every line", () => {
		const layout = computeLayout(BASIC, { cols: 80 });
		expect(renderView(layout, { now: NOW }).lines).toHaveLength(layout.totalHeight);
	});

	test("cols 0 and 1 and rows 0 and 1 never crash", () => {
		expect(renderLayout(computeLayout(BASIC, { cols: 0, rows: 0 }), { now: NOW })).toEqual([]);
		expect(renderStatic(BASIC, { cols: 0, rows: 0, now: NOW })).toEqual([]);
		const one = renderLayout(computeLayout(BASIC, { cols: 1, rows: 1 }), { now: NOW });
		expectBounded(one, 1);
		expect(renderView(computeLayout(BASIC, { cols: 1, rows: 1 }), { now: NOW }).lines).toHaveLength(1);
		expect(renderView(computeLayout(BASIC, { cols: 80, rows: 0 }), { now: NOW }).lines).toEqual([]);
		expect(renderView(computeLayout(BASIC, { cols: 80, rows: 1 }), { now: NOW }).lines).toHaveLength(1);
		expect(renderLayout(null, {})).toEqual([]);
	});
});

describe("renderStatic goldens", () => {
	test.each([
		[200, 50],
		[120, 40],
		[80, 24],
		[60, 20],
		[45, 30],
		[30, 12],
		[24, 8],
	])("basic snapshot at %i×%i", (cols, rows) => {
		const out = renderStatic(BASIC, { cols, rows, now: NOW });
		expect(Array.isArray(out)).toBe(true);
		expectBounded(out, cols);
		expectGolden(`basic-${cols}x${rows}`, out);
	});

	test("renderStatic returns string[] with exactly layout.totalHeight lines (§3.4)", () => {
		for (const [cols, rows] of [[200, 50], [120, 40], [80, 24], [24, 8]]) {
			const out = renderStatic(BASIC, { cols, rows, now: NOW });
			expect(Array.isArray(out)).toBe(true);
			expect(out).toHaveLength(computeLayout(BASIC, { cols, rows }).totalHeight);
			for (const line of out) expect(typeof line).toBe("string");
		}
	});

	test("basic snapshot at 80 cols with unbounded rows (tier 3 + extras)", () => {
		const out = renderStatic(BASIC, { cols: 80, now: NOW });
		expectBounded(out, 80);
		expectGolden("basic-80xinf", out);
	});

	test("12 accounts at 80×12: tier-0 list, full content (scrolling is the app's job)", () => {
		const snapshot = manyAccounts(12);
		const layout = computeLayout(snapshot, { cols: 80, rows: 12 });
		expect(layout.tier).toBe(0);
		const out = renderStatic(snapshot, { cols: 80, rows: 12, now: NOW });
		expect(out).toHaveLength(24);
		expectBounded(out, 80);
		expectGolden("many-80x12", out);
		const view = renderView(computeLayout(snapshot, { cols: 80, rows: 12, scroll: 30 }), { now: NOW });
		expect(view.lines).toHaveLength(12);
		expect(view.viewport.offset).toBe(12); // clamped from 30 (24 lines − 12 visible)
		expectGolden("many-80x12-view-scroll30", `${view.lines.join("\n")}\n[${view.indicator}]`);
	});

	test("showEmail golden", () => {
		const out = renderStatic(BASIC, { cols: 120, rows: 40, now: NOW, showEmail: true }).join("\n");
		expect(out).toContain("shuv@example.org");
		expect(out).toContain("someone@example.com");
		expectGolden("basic-120x40-show-email", out);
	});

	test("compact golden", () => {
		const out = renderCompact(BASIC, { now: NOW });
		expect(Array.isArray(out)).toBe(true);
		expect(out.join("\n")).not.toContain("\x1b");
		expectGolden("basic-compact", out);
	});

	test("goldens are deterministic across the host time zone", () => {
		const prev = process.env.TZ;
		try {
			process.env.TZ = "Asia/Tokyo";
			expectGolden("basic-120x40", renderStatic(BASIC, { cols: 120, rows: 40, now: NOW }));
		} finally {
			if (prev === undefined) delete process.env.TZ;
			else process.env.TZ = prev;
		}
	});
});

describe("privacy and injection safety", () => {
	test("emails are redacted by default at every tier and in compact mode", () => {
		for (const [cols, rows] of [[200, 50], [120, 40], [80, 24], [45, 30], [24, 8]]) {
			const out = renderStatic(BASIC, { cols, rows, now: NOW }).join("\n");
			expect(out).not.toContain("shuv@example.org");
			expect(out).not.toContain("someone@example.com");
			expect(out).not.toContain("kenji@example.jp");
		}
		const compact = renderCompact(BASIC, { now: NOW }).join("\n");
		expect(compact).not.toContain("shuv@example.org");
		expect(compact).toContain("s***@example.org");
		expect(renderCompact(BASIC, { now: NOW, showEmail: true }).join("\n")).toContain("shuv@example.org");
	});

	test("dynamic values cannot inject control or escape sequences", () => {
		const hostile = {
			schemaVersion: 2,
			providers: [{
				id: "codex",
				name: "Codex\x1b[2J",
				accounts: [{
					label: "\x1b[31mred\x1b[0m\x1b]0;title\x07\u202eevil\n\r\tlabel",
					email: "a\x1b[1mb@x.y",
					plan: "Plus\x1b[H",
					status: "ok",
					windows: [{ label: "5h\x1b[31m", percentRemaining: 50, resetsAt: "2026-09-17T23:00:00Z" }],
					extras: [{ label: "k\x00", value: "v\x1b[2J" }],
				}, {
					label: "broken",
					status: "error",
					error: "boom\x1b[2J\x07\x1b]52;c;ZXZpbA==\x07",
				}],
			}, {
				id: "grok",
				name: "Grok",
				error: "\x1b[?1049h\x1b[2Jfail",
				accounts: [],
			}],
		};
		for (const [cols, rows] of [[200, 50], [120, 40], [80, 24], [45, 30], [30, 12], [24, 8]]) {
			const out = renderStatic(hostile, { cols, rows, now: NOW });
			expectBounded(out, cols);
			expect(out.join("\n")).not.toContain("\u202e");
		}
		const compact = renderCompact(hostile, { now: NOW }).join("\n");
		expect(compact).not.toContain("\x1b");
		expect(compact).not.toMatch(CONTROL_RE);
		expect(compact).toContain("redevillabel");
		expect(compact).toContain("error: boom");
		expect(compact).toContain("error: fail");
	});

	test("colour output strips back to the no-colour frame with identical geometry", () => {
		for (const [cols, rows] of [[200, 50], [120, 40], [80, 24], [24, 8]]) {
			const plain = renderStatic(BASIC, { cols, rows, now: NOW });
			const colored = renderStatic(BASIC, { cols, rows, now: NOW, color: true });
			expect(colored.map(stripAnsi)).toEqual(plain);
			for (const line of colored) expect(cellWidth(line)).toBeLessThanOrEqual(cols);
		}
		const colored = renderStatic(BASIC, { cols: 120, rows: 40, now: NOW, color: true }).join("\n");
		expect(colored).toContain("\x1b[31m"); // 7% weekly → bad
		expect(colored).toContain("\x1b[32m"); // 100% → good
		expect(colored).toContain("\x1b[33m"); // 41% → warn
		expect(renderCompact(BASIC, { now: NOW, color: true }).map(stripAnsi)).toEqual(renderCompact(BASIC, { now: NOW }));
	});
});

describe("Unicode alignment", () => {
	test("CJK, combining, and ZWJ labels keep card borders aligned", () => {
		const snapshot = {
			schemaVersion: 2,
			providers: [{
				id: "codex",
				name: "Codex",
				accounts: [
					{ label: "日本語ラベル", plan: "Plus", windows: [{ label: "五時間", percentRemaining: 50 }] },
					{ label: "cafe\u0301 ñ", plan: "Plus", windows: [{ label: "Wk", percentRemaining: 50 }] },
					{ label: "team 👩‍💻🇯🇵 1️⃣", plan: "Plus", windows: [{ label: "☠️ x", percentRemaining: 50 }] },
					{ label: "Ａ全角Ｂ", plan: "Plus", windows: [{ label: "Ｗ", percentRemaining: 50 }] },
				],
			}],
		};
		for (const [cols, rows] of [[200, 50], [100, 40], [48, 40], [36, 40], [28, 40], [20, 40]]) {
			const layout = computeLayout(snapshot, { cols, rows });
			const lines = renderLayout(layout, { now: NOW });
			expectBounded(lines, cols);
			if (layout.tier > 0) {
				for (const placed of layout.placed) {
					for (let i = 0; i < placed.height; i++) {
						const line = lines[placed.y + i];
						expect(cellWidth(line)).toBeGreaterThanOrEqual(placed.x + placed.width);
					}
				}
			}
		}
		const out = renderStatic(snapshot, { cols: 48, now: NOW });
		// Every card line is exactly 48 cells; only ROW_GAP separators are empty.
		for (const line of out) expect(cellWidth(line)).toBe(line === "" ? 0 : 48);
		const joined = out.join("\n");
		expect(joined).toContain("日本語ラベル");
		expect(joined).toContain("👩‍💻");
		expect(joined).toContain("cafe\u0301");
		expectGolden("unicode-48xinf", out);
	});
});

describe("renderCompact", () => {
	test("one metric per line, grep-friendly, provider errors and empties visible", () => {
		const lines = renderCompact(BASIC, { now: NOW });
		expect(Array.isArray(lines)).toBe(true);
		expect(lines).toContain("Codex · work · Plus · s***@example.org");
		expect(lines).toContain("  5h: 100% left, resets 16:59 Thu");
		expect(lines).toContain("  Weekly: 7% left, resets 12:00 Sep 24");
		expect(lines).toContain("  Sonnet: --% left");
		expect(lines).toContain("  credits: 12");
		expect(lines).toContain("SuperGrok");
		expect(lines).toContain("  error: token refresh failed: invalid_grant");
		expect(lines).toContain("  loading…");
		expect(renderCompact({ providers: [{ id: "claude", name: "Claude" }] }, { now: NOW }))
			.toEqual(["Claude", "  no accounts"]);
	});

	test("window detail is appended when present (§3.1 `detail?`)", () => {
		const lines = renderCompact({
			providers: [{
				id: "codex",
				name: "Codex",
				accounts: [{
					label: "work",
					email: null,
					plan: null,
					status: "ok",
					windows: [
						{ id: "5h", label: "5h", percentRemaining: 64, resetsAt: "2026-09-17T23:00:00Z", detail: "1.2M / 5M tokens" },
						{ id: "wk", label: "Weekly", percentRemaining: 22, resetsAt: null },
					],
				}],
			}],
		}, { now: NOW });
		expect(lines).toEqual([
			"Codex · work",
			"  5h: 64% left, resets 16:00 Thu (1.2M / 5M tokens)",
			"  Weekly: 22% left",
		]);
	});

	test("empty snapshot", () => {
		expect(renderCompact({ providers: [] }, { now: NOW })).toEqual(["No quota data"]);
		expect(renderCompact(null, { now: NOW })).toEqual(["No quota data"]);
	});
});
