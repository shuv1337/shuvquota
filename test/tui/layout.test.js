/**
 * Pure layout engine: grid math, tiers, deterministic ordering, height
 * fallback, scroll clamping, degenerate sizes. Imports lib/tui/layout.js directly.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	PROVIDER_ORDER,
	CARD_GAP,
	ROW_GAP,
	TARGET_CARD_WIDTH,
	TIER_MIN_WIDTH,
	MIN_CARD_WIDTH,
	TABLE_HEADER_HEIGHT,
	listRowCount,
	CARD_CHROME_HEIGHT,
	MAX_TEXT_LENGTH,
	normalizeSnapshot,
	buildCards,
	computeGrid,
	tierForWidth,
	cardHeight,
	clampScroll,
	computeLayout,
} from "../../lib/tui/layout.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASIC = JSON.parse(readFileSync(join(HERE, "fixtures", "snapshot-basic.json"), "utf8"));

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
				email: `u${i}@example.org`,
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

describe("constants", () => {
	test("fixed provider order and geometry match plan §3.3", () => {
		expect([...PROVIDER_ORDER]).toEqual(["codex", "claude", "grok", "antigravity", "cursor"]);
		expect(Object.isFrozen(PROVIDER_ORDER)).toBe(true);
		expect(CARD_GAP).toBe(2);
		expect(ROW_GAP).toBe(1);
		expect(TARGET_CARD_WIDTH).toBe(48);
		expect(TIER_MIN_WIDTH).toEqual({ 3: 44, 2: 36, 1: 28 });
		expect(MIN_CARD_WIDTH).toBe(28);
		expect(TABLE_HEADER_HEIGHT).toBe(0);
		expect(CARD_CHROME_HEIGHT).toBe(2);
	});
});

describe("normalizeSnapshot", () => {
	test("sorts providers into fixed order and accounts by label (code-unit order)", () => {
		const normalized = normalizeSnapshot(BASIC);
		expect(normalized.schemaVersion).toBe(2);
		expect(normalized.providers.map(p => p.id)).toEqual(["codex", "claude", "grok", "antigravity"]);
		expect(normalized.providers[0].accounts.map(a => a.label)).toEqual(["personal", "work"]);
		// "pending" (ASCII) sorts before "日本語ラベル" (U+65E5) by code unit.
		expect(normalized.providers[3].accounts.map(a => a.label)).toEqual(["pending", "日本語ラベル"]);
	});

	test("unknown provider ids sort after the fixed order, alphabetically", () => {
		const normalized = normalizeSnapshot({
			providers: [{ id: "zeta" }, { id: "grok" }, { id: "alpha" }, { id: "codex" }],
		});
		expect(normalized.providers.map(p => p.id)).toEqual(["codex", "grok", "alpha", "zeta"]);
	});

	test("sorting is stable across input permutations", () => {
		const a = normalizeSnapshot(BASIC);
		const shuffled = { ...BASIC, providers: [...BASIC.providers].reverse().map(p => ({
			...p,
			accounts: [...(p.accounts ?? [])].reverse(),
		})) };
		const b = normalizeSnapshot(shuffled);
		expect(JSON.stringify(b)).toBe(JSON.stringify(a));
	});

	test("tolerates malformed input without throwing", () => {
		for (const bad of [null, undefined, 42, "x", [], {}, { providers: "nope" }, { providers: [null, 1, {}] }]) {
			const out = normalizeSnapshot(bad);
			expect(out.schemaVersion).toBe(2);
			expect(Array.isArray(out.providers)).toBe(true);
		}
		const withJunkAccounts = normalizeSnapshot({ providers: [{ id: "codex", accounts: [null, "x", { windows: "bad", extras: 7 }] }] });
		expect(withJunkAccounts.providers[0].accounts).toHaveLength(1);
		// Junk entries are dropped before numbering, so the survivor is "account 1".
		expect(withJunkAccounts.providers[0].accounts[0]).toMatchObject({ label: "account 1", windows: [], extras: [] });
	});

	test("sanitizes every dynamic string (ANSI, controls, bidi) and caps length", () => {
		const long = "x".repeat(MAX_TEXT_LENGTH + 50);
		const normalized = normalizeSnapshot({
			providers: [{
				id: "codex\x1b[31m",
				name: "Co\tdex\u202e",
				error: "boom\x1b[2J",
				accounts: [{
					label: "\x1b]0;evil\x07lab\nel",
					email: "a\u200bb@x.y",
					plan: long,
					error: "err\x1b[H",
					windows: [{ label: "5h\x1b[31m", resetsAt: "2026-01-01T00:00:00Z\x07" }],
					extras: [{ label: "k\x1b[0m", value: "v\r" }],
				}],
			}],
		});
		const provider = normalized.providers[0];
		expect(provider.id).toBe("codex");
		expect(provider.name).toBe("Codex");
		expect(provider.error).toBe("boom");
		const account = provider.accounts[0];
		expect(account.label).toBe("label");
		expect(account.email).toBe("ab@x.y");
		expect(account.plan.length).toBe(MAX_TEXT_LENGTH);
		expect(account.error).toBe("err");
		expect(account.windows[0].label).toBe("5h");
		expect(account.windows[0].resetsAt).toBe("2026-01-01T00:00:00Z");
		expect(account.extras[0]).toEqual({ label: "k", value: "v" });
		expect(JSON.stringify(normalized)).not.toMatch(/\\u001b|\\t|\\n|\\r|\\u202e|\\u200b/);
	});

	test("derives status and remaining percent", () => {
		const normalized = normalizeSnapshot({
			providers: [{
				id: "codex",
				accounts: [
					{ label: "a", error: "x" },
					{ label: "b", status: "loading" },
					{ label: "c", status: "weird" },
					{ label: "d", windows: [{ label: "w", percentRemaining: 30, detail: "1.2M / 5M tokens" }, { label: "v", percentRemaining: 150 }, { label: "u", percentRemaining: "nan" }, { label: "t", percentRemaining: -5 }] },
				],
			}],
		});
		const [a, b, c, d] = normalized.providers[0].accounts;
		expect(a.status).toBe("error");
		expect(b.status).toBe("loading");
		expect(c.status).toBe("ok");
		expect(d.windows.map(w => w.percentRemaining)).toEqual([30, 100, null, 0]);
		expect(d.windows.map(w => w.detail)).toEqual(["1.2M / 5M tokens", null, null, null]);
	});

	test("uses v2 window fields only; legacy v1 names are ignored (no fallback)", () => {
		const normalized = normalizeSnapshot({
			providers: [{
				id: "codex",
				accounts: [{
					label: "a",
					windows: [
						{ label: "legacy", remainingPercent: 64, usedPercent: 36, resetAt: "2026-09-17T23:00:00Z" },
						{ label: "v2", percentRemaining: 64, resetsAt: "2026-09-17T23:00:00Z" },
					],
				}],
			}],
		});
		const [legacy, v2] = normalized.providers[0].accounts[0].windows;
		expect(legacy).toEqual({ id: "legacy", label: "legacy", percentRemaining: null, resetsAt: null, detail: null });
		expect(v2).toEqual({ id: "v2", label: "v2", percentRemaining: 64, resetsAt: "2026-09-17T23:00:00Z", detail: null });
		expect(Object.keys(legacy).sort()).toEqual(["detail", "id", "label", "percentRemaining", "resetsAt"]);
	});
});

describe("buildCards", () => {
	test("one card per account; providers with no accounts get a visible provider card", () => {
		const cards = buildCards(normalizeSnapshot(BASIC));
		expect(cards.map(c => c.key)).toEqual([
			"codex:personal",
			"codex:work",
			"claude:main 👩‍💻",
			"grok:",
			"antigravity:pending",
			"antigravity:日本語ラベル",
		]);
		const grok = cards[3];
		expect(grok.kind).toBe("provider");
		expect(grok.status).toBe("error");
		expect(grok.message).toBe("error: token refresh failed: invalid_grant");
	});

	test("provider-level error and empty states are distinct; no provider-level loading (§3.1)", () => {
		const cards = buildCards(normalizeSnapshot({
			providers: [{ id: "codex", error: "config incomplete" }, { id: "claude", loading: true }],
		}));
		expect(cards.map(c => [c.status, c.message])).toEqual([
			["error", "error: config incomplete"],
			["empty", "no accounts"],
		]);
		expect(normalizeSnapshot({ providers: [{ id: "codex", loading: true }] }).providers[0]).not.toHaveProperty("loading");
	});

	test("empty snapshot yields no cards", () => {
		expect(buildCards(normalizeSnapshot({ providers: [] }))).toEqual([]);
	});
});

describe("computeGrid", () => {
	test.each([
		[200, 6, 4, 48],
		[120, 6, 2, 59],
		[100, 6, 2, 49],
		[98, 6, 2, 48],
		[97, 6, 1, 97],
		[80, 6, 1, 80],
		[60, 6, 1, 60],
		[45, 6, 1, 45],
		[30, 6, 1, 30],
		[24, 6, 1, 24],
	])("cols=%i cards=%i → columns=%i cardWidth=%i", (cols, cards, columns, cardWidth) => {
		expect(computeGrid(cols, cards)).toEqual({ columns, cardWidth });
	});

	test("columns never exceed the card count", () => {
		expect(computeGrid(200, 1)).toEqual({ columns: 1, cardWidth: 200 });
		expect(computeGrid(200, 2)).toEqual({ columns: 2, cardWidth: 99 });
	});

	test("degenerate inputs", () => {
		expect(computeGrid(0, 6)).toEqual({ columns: 0, cardWidth: 0 });
		expect(computeGrid(80, 0)).toEqual({ columns: 0, cardWidth: 0 });
		expect(computeGrid(-5, 6)).toEqual({ columns: 0, cardWidth: 0 });
		expect(computeGrid(NaN, 6)).toEqual({ columns: 0, cardWidth: 0 });
		expect(computeGrid(1, 6)).toEqual({ columns: 1, cardWidth: 1 });
	});
});

describe("tierForWidth", () => {
	test.each([
		[100, 3], [48, 3], [44, 3], [43, 2], [36, 2], [35, 1], [28, 1], [27, 0], [1, 0], [0, 0],
	])("width %i → tier %i", (width, tier) => {
		expect(tierForWidth(width)).toBe(tier);
	});
});

describe("cardHeight", () => {
	const cards = buildCards(normalizeSnapshot(BASIC));
	const byKey = Object.fromEntries(cards.map(c => [c.key, c]));

	test("tier 0 is one list line per window (one for message cards)", () => {
		expect(cards.map(card => cardHeight(card, 0, true))).toEqual([1, 2, 3, 1, 1, 2]);
		expect(cards.map(listRowCount)).toEqual([1, 2, 3, 1, 1, 2]);
	});

	test("ok account: chrome + one line per window; extras live in the border", () => {
		expect(cardHeight(byKey["codex:work"], 3, false)).toBe(2 + 2);
		expect(cardHeight(byKey["codex:work"], 3, true)).toBe(2 + 2);
		expect(cardHeight(byKey["claude:main 👩‍💻"], 2, false)).toBe(2 + 3);
		expect(cardHeight(byKey["claude:main 👩‍💻"], 3, true)).toBe(2 + 3);
	});

	test("error, loading, and provider cards are chrome + one message line", () => {
		expect(cardHeight(byKey["codex:personal"], 3, true)).toBe(3);
		expect(cardHeight(byKey["antigravity:pending"], 3, true)).toBe(3);
		expect(cardHeight(byKey["grok:"], 3, true)).toBe(3);
	});

	test("ok account with no windows still reserves one body line", () => {
		const [card] = buildCards(normalizeSnapshot({ providers: [{ id: "codex", accounts: [{ label: "x" }] }] }));
		expect(cardHeight(card, 3, false)).toBe(3);
	});
});

describe("clampScroll", () => {
	test("clamps offset into [0, maxOffset] and reports hidden rows", () => {
		expect(clampScroll(33, 12, 0)).toEqual({ offset: 0, maxOffset: 21, visibleRows: 12, hiddenAbove: 0, hiddenBelow: 21 });
		expect(clampScroll(33, 12, 10)).toEqual({ offset: 10, maxOffset: 21, visibleRows: 12, hiddenAbove: 10, hiddenBelow: 11 });
		expect(clampScroll(33, 12, 999)).toEqual({ offset: 21, maxOffset: 21, visibleRows: 12, hiddenAbove: 21, hiddenBelow: 0 });
		expect(clampScroll(33, 12, -4)).toMatchObject({ offset: 0 });
		expect(clampScroll(33, 12, NaN)).toMatchObject({ offset: 0 });
	});

	test("content that fits has no scroll range", () => {
		expect(clampScroll(10, 24, 5)).toEqual({ offset: 0, maxOffset: 0, visibleRows: 24, hiddenAbove: 0, hiddenBelow: 0 });
		expect(clampScroll(10, Infinity, 5)).toEqual({ offset: 0, maxOffset: 0, visibleRows: 10, hiddenAbove: 0, hiddenBelow: 0 });
	});
});

describe("computeLayout", () => {
	test("200×50: 4 columns, tier 3 with extras, everything fits", () => {
		const layout = computeLayout(BASIC, { cols: 200, rows: 50 });
		expect(layout).toMatchObject({ columns: 4, cardWidth: 48, tier: 3, showExtras: true, fits: true });
		expect(layout.placed).toHaveLength(6);
		expect(layout.placed.map(p => [p.row, p.col])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1]]);
		expect(layout.placed.map(p => p.x)).toEqual([0, 50, 100, 150, 0, 50]);
		// Row 0 tallest card is Claude (3 windows + chrome = 5).
		expect(layout.placed[0].rowHeight).toBe(5);
		expect(layout.placed[4].y).toBe(5 + ROW_GAP);
		expect(layout.totalHeight).toBe(5 + 1 + 4);
	});

	test("120×40: 2 columns, tier 3 with extras", () => {
		const layout = computeLayout(BASIC, { cols: 120, rows: 40 });
		expect(layout).toMatchObject({ columns: 2, cardWidth: 59, tier: 3, showExtras: true, fits: true, totalHeight: 15 });
	});

	test("80×24: one column is too tall, so two narrower tier-2 columns are used", () => {
		const layout = computeLayout(BASIC, { cols: 80, rows: 24 });
		expect(layout).toMatchObject({ columns: 2, cardWidth: 39, tier: 2, showExtras: false, fits: true, totalHeight: 15 });
		expect(layout.viewport).toEqual({ offset: 0, maxOffset: 0, visibleRows: 24, hiddenAbove: 0, hiddenBelow: 0 });
	});

	test("height fallback: tier3 → more columns → tier2 → tier1 → tier0 list → scroll (§3.3)", () => {
		// 60 cols: one tier-3 column is 27 lines; two tier-1 columns are 15; the list is 10.
		const expectations = [
			[27, { columns: 1, tier: 3, showExtras: true, fits: true, totalHeight: 27 }],
			[26, { columns: 2, cardWidth: 29, tier: 1, fits: true, totalHeight: 15 }],
			[15, { columns: 2, tier: 1, fits: true }],
			[14, { columns: 1, tier: 0, fits: true, totalHeight: 10 }],
			[10, { tier: 0, fits: true, totalHeight: 10 }],
			[9, { tier: 0, fits: false, totalHeight: 10 }],
		];
		for (const [rows, expected] of expectations) {
			expect(computeLayout(BASIC, { cols: 60, rows })).toMatchObject(expected);
		}
		// Tier 2 and tier 1 are genuinely tried before tier 0 when they fit but tier 3 does not.
		const snapshot = {
			providers: [{
				id: "codex",
				accounts: Array.from({ length: 3 }, (_, i) => ({
					label: `acct${i}`,
					windows: [{ id: "5h", label: "5h", percentRemaining: 50, resetsAt: "2026-09-17T23:00:00Z" }],
					extras: [{ label: "tier", value: "pro" }],
				})),
			}],
		};
		// 3 cards × 3 lines + 2 gaps = 11 at every card tier.
		expect(computeLayout(snapshot, { cols: 48, rows: 11 })).toMatchObject({ tier: 3, showExtras: true });
		expect(computeLayout(snapshot, { cols: 48, rows: 10 })).toMatchObject({ tier: 0, fits: true, totalHeight: 3 });
		expect(computeLayout(snapshot, { cols: 40, rows: 11 })).toMatchObject({ tier: 2, fits: true });
		expect(computeLayout(snapshot, { cols: 30, rows: 11 })).toMatchObject({ tier: 1, fits: true });
		expect(computeLayout(snapshot, { cols: 30, rows: 10 })).toMatchObject({ tier: 0, fits: true });
		// Scrolling only begins once even the tier-0 list overflows.
		expect(computeLayout(snapshot, { cols: 30, rows: 2 })).toMatchObject({ tier: 0, fits: false, totalHeight: 3 });
		expect(computeLayout(snapshot, { cols: 30, rows: 2 }).viewport.maxOffset).toBe(1);
	});

	test("80 columns with unbounded rows keeps tier 3", () => {
		const layout = computeLayout(BASIC, { cols: 80 });
		expect(layout).toMatchObject({ tier: 3, showExtras: true, fits: true, rows: Infinity });
		expect(layout.viewport.maxOffset).toBe(0);
	});

	test("extras never add height (they render in the bottom border)", () => {
		const layout = computeLayout(BASIC, { cols: 60, rows: 27 });
		expect(layout).toMatchObject({ tier: 3, showExtras: true, fits: true, totalHeight: 27 });
	});

	test("width below MIN_CARD_WIDTH always yields the tier-0 list", () => {
		const layout = computeLayout(BASIC, { cols: 24, rows: 10 });
		expect(layout).toMatchObject({ tier: 0, cardWidth: 24, totalHeight: 10, fits: true });
		expect(layout.placed.map(p => p.y)).toEqual([0, 1, 3, 6, 7, 8]);
		expect(computeLayout(BASIC, { cols: 27, rows: 100 }).tier).toBe(0);
		expect(computeLayout(BASIC, { cols: 28, rows: 100 }).tier).toBe(1);
	});

	test("12 accounts at 80×12: tier-0 list (24 lines) scrolls; offset clamps", () => {
		const snapshot = manyAccounts(12);
		const layout = computeLayout(snapshot, { cols: 80, rows: 12, scroll: 500 });
		expect(layout.tier).toBe(0);
		expect(layout.cards).toHaveLength(12);
		expect(layout.totalHeight).toBe(TABLE_HEADER_HEIGHT + 24);
		expect(layout.fits).toBe(false);
		expect(layout.viewport).toEqual({ offset: 12, maxOffset: 12, visibleRows: 12, hiddenAbove: 12, hiddenBelow: 0 });
		expect(computeLayout(snapshot, { cols: 80, rows: 12, scroll: 1 }).viewport).toEqual({ offset: 1, maxOffset: 12, visibleRows: 12, hiddenAbove: 1, hiddenBelow: 11 });
		// Card tiers are never scrolled: with unbounded rows the same snapshot is tier 3.
		expect(computeLayout(snapshot, { cols: 80 })).toMatchObject({ tier: 3, fits: true, totalHeight: 12 * 4 + 11 });
	});

	test("scroll is only requested state; layout itself is scroll-independent", () => {
		const snapshot = manyAccounts(12);
		const a = computeLayout(snapshot, { cols: 80, rows: 12, scroll: 0 });
		const b = computeLayout(snapshot, { cols: 80, rows: 12, scroll: 1 });
		expect(b.placed).toEqual(a.placed);
		expect(b.tier).toBe(a.tier);
		expect(a.viewport.offset).toBe(0);
		expect(b.viewport.offset).toBe(1);
	});

	test("degenerate terminal sizes never throw", () => {
		expect(computeLayout(BASIC, { cols: 0, rows: 0 })).toMatchObject({ columns: 0, tier: 0, totalHeight: 0, placed: [] });
		expect(computeLayout(BASIC, { cols: 1, rows: 1 })).toMatchObject({ columns: 1, tier: 0, totalHeight: 10 });
		expect(computeLayout(BASIC, { cols: 80, rows: 0 })).toMatchObject({ tier: 0, fits: false, totalHeight: 10 });
		expect(computeLayout(BASIC, { cols: 80, rows: 1 }).viewport.visibleRows).toBe(1);
		expect(computeLayout(BASIC, { cols: -3, rows: -3 })).toMatchObject({ cols: 0, rows: 0 });
		expect(computeLayout(BASIC, { cols: "abc", rows: null }).cols).toBe(80);
	});

	test("empty snapshot reserves a single message line", () => {
		expect(computeLayout({ providers: [] }, { cols: 80, rows: 24 })).toMatchObject({ tier: 0, totalHeight: 1, placed: [], cards: [] });
		expect(computeLayout(null, { cols: 80, rows: 24 }).totalHeight).toBe(1);
		expect(computeLayout({ providers: [] }, { cols: 0 }).totalHeight).toBe(0);
	});

	test("every placed card height equals cardHeight for the chosen tier", () => {
		for (const [cols, rows] of [[200, 50], [120, 40], [80, 24], [60, 20], [45, 30], [30, 12]]) {
			const layout = computeLayout(BASIC, { cols, rows });
			for (const placed of layout.placed) {
				expect(placed.height).toBe(cardHeight(placed.card, layout.tier, layout.showExtras));
				expect(placed.height).toBeLessThanOrEqual(placed.rowHeight);
				expect(placed.x + placed.width).toBeLessThanOrEqual(cols);
			}
		}
	});
});
