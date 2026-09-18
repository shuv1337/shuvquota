/**
 * Pure layout engine for the TUI (plan §3.3 / Phase 4).
 *
 * Input: a schemaVersion 2 quota snapshot plus terminal geometry.
 * Output: a deterministic, fully-computed layout (tier, grid, card positions,
 * scroll viewport). No terminal access, no I/O, no colour — rendering lives in
 * ./render.js. Depends only on ./width.js.
 *
 * Snapshot contract (plan §3.1, schemaVersion 2). Field names are exact; there
 * is no legacy (v1 `--json`) fallback here — adapters live outside lib/tui.
 *   {
 *     schemaVersion: 2,
 *     generatedAt: string,                       // ISO
 *     providers: Array<{
 *       id: string, name: string, error?: string,
 *       accounts: Array<{
 *         label: string, email: string | null, plan: string | null,
 *         status: "ok" | "error" | "loading", error?: string,
 *         windows: Array<{ id: string, label: string,
 *           percentRemaining: number | null,     // 0–100, null when unknown
 *           resetsAt: string | null,             // ISO
 *           detail?: string }>,
 *         extras?: Array<{ label: string, value: string }>,
 *       }>,
 *     }>,
 *   }
 * Every dynamic string is sanitized (ANSI/control/bidi stripped) and capped
 * before it can reach a renderer.
 */

import { sanitize } from "./width.js";

/** Fixed provider order; unknown ids sort after these, alphabetically. */
export const PROVIDER_ORDER = Object.freeze(["codex", "claude", "grok", "antigravity"]);
/** Columns between cards in the same row. */
export const CARD_GAP = 2;
/** Blank lines between card rows. */
export const ROW_GAP = 1;
/** Preferred card width used to pick the column count. */
export const TARGET_CARD_WIDTH = 48;
/** Minimum card width for each density tier; below tier 1 falls back to the table. */
export const TIER_MIN_WIDTH = Object.freeze({ 3: 44, 2: 36, 1: 28 });
export const MIN_CARD_WIDTH = TIER_MIN_WIDTH[1];
/** Header row + rule line of the tier-0 table. */
export const TABLE_HEADER_HEIGHT = 2;
/** Top border + header line + bottom border of a card. */
export const CARD_CHROME_HEIGHT = 3;
/** Cap on any sanitized dynamic string (characters). */
export const MAX_TEXT_LENGTH = 200;

/**
 * Height fallback order (plan §3.3): tier 3 with extras → tier 3 without extras →
 * tier 2 → tier 1 → tier 0 (table) → scroll (at tier 0). Candidates above the
 * width-derived maximum tier are skipped.
 */
const FALLBACK_SEQUENCE = Object.freeze([
	{ tier: 3, showExtras: true },
	{ tier: 3, showExtras: false },
	{ tier: 2, showExtras: false },
	{ tier: 1, showExtras: false },
	{ tier: 0, showExtras: false },
]);

/**
 * @typedef {{ id: string, label: string, percentRemaining: number | null, resetsAt: string | null, detail: string | null }} LayoutWindow
 * @typedef {{ label: string, email: string | null, plan: string | null,
 *   status: "ok" | "error" | "loading", error: string | null,
 *   windows: LayoutWindow[], extras: Array<{ label: string, value: string }> }} LayoutAccount
 * @typedef {{ id: string, name: string, error: string | null, accounts: LayoutAccount[] }} LayoutProvider
 * @typedef {{ schemaVersion: 2, generatedAt: string | null, providers: LayoutProvider[] }} LayoutSnapshot
 * @typedef {{ key: string, kind: "account" | "provider", providerId: string, providerName: string,
 *   status: "ok" | "error" | "loading" | "empty", account: LayoutAccount | null, message: string | null }} Card
 * @typedef {{ card: Card, row: number, col: number, x: number, y: number, width: number, height: number, rowHeight: number }} PlacedCard
 * @typedef {{ offset: number, maxOffset: number, visibleRows: number, hiddenAbove: number, hiddenBelow: number }} Viewport
 * @typedef {{ schemaVersion: 2, cols: number, rows: number, columns: number, cardWidth: number,
 *   tier: 0 | 1 | 2 | 3, showExtras: boolean, cards: Card[], placed: PlacedCard[],
 *   totalHeight: number, fits: boolean, viewport: Viewport }} Layout
 */

/**
 * @param {unknown} value
 * @param {number} [max=MAX_TEXT_LENGTH]
 * @returns {string}
 */
function text(value, max = MAX_TEXT_LENGTH) {
	if (value == null) return "";
	const clean = sanitize(typeof value === "string" ? value : String(value)).trim();
	return clean.length > max ? sanitize(clean.slice(0, max)) : clean;
}

/**
 * Locale-independent ordering (UTF-16 code units) so sort order never depends on ICU.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {string} id
 * @returns {number}
 */
function providerRank(id) {
	const index = PROVIDER_ORDER.indexOf(id);
	return index === -1 ? PROVIDER_ORDER.length : index;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toNonNegativeInt(value, fallback) {
	if (value === Infinity) return Infinity;
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.floor(n));
}

/**
 * @param {unknown} window
 * @returns {number | null}
 */
function normalizePercent(window) {
	if (window.percentRemaining == null) return null;
	const remaining = Number(window.percentRemaining);
	if (!Number.isFinite(remaining)) return null;
	return Math.min(100, Math.max(0, remaining));
}

/**
 * @param {unknown} window
 * @param {number} index
 * @returns {LayoutWindow}
 */
function normalizeWindow(window, index) {
	const label = text(window.label) || text(window.id) || `w${index + 1}`;
	const resetsAt = text(window.resetsAt);
	return {
		id: text(window.id) || label,
		label,
		percentRemaining: normalizePercent(window),
		resetsAt: resetsAt || null,
		detail: text(window.detail) || null,
	};
}

/**
 * @param {unknown} account
 * @param {number} index
 * @returns {LayoutAccount}
 */
function normalizeAccount(account, index) {
	const error = text(account.error) || null;
	const status = error || account.status === "error"
		? "error"
		: account.status === "loading" ? "loading" : "ok";
	const windows = Array.isArray(account.windows)
		? account.windows.filter(w => w && typeof w === "object").map(normalizeWindow)
		: [];
	const extras = Array.isArray(account.extras)
		? account.extras
			.filter(e => e && typeof e === "object")
			.map(e => ({ label: text(e.label), value: text(e.value) }))
			.filter(e => e.label || e.value)
		: [];
	return {
		label: text(account.label) || `account ${index + 1}`,
		email: text(account.email) || null,
		plan: text(account.plan) || null,
		status,
		error: status === "error" ? (error || "unknown error") : null,
		windows,
		extras,
	};
}

/**
 * @param {unknown} provider
 * @returns {LayoutProvider}
 */
function normalizeProvider(provider) {
	const id = text(provider.id) || "unknown";
	const accounts = Array.isArray(provider.accounts)
		? provider.accounts.filter(a => a && typeof a === "object").map(normalizeAccount)
		: [];
	accounts.sort((a, b) => compareText(a.label, b.label));
	return {
		id,
		name: text(provider.name) || id,
		error: text(provider.error) || null,
		accounts,
	};
}

/**
 * Sanitize and deterministically order a snapshot. Never throws on malformed input.
 * @param {unknown} snapshot
 * @returns {LayoutSnapshot}
 */
export function normalizeSnapshot(snapshot) {
	const source = snapshot && typeof snapshot === "object" ? snapshot : {};
	const providers = Array.isArray(source.providers)
		? source.providers.filter(p => p && typeof p === "object").map(normalizeProvider)
		: [];
	providers.sort((a, b) => providerRank(a.id) - providerRank(b.id) || compareText(a.id, b.id));
	return {
		schemaVersion: 2,
		generatedAt: text(source.generatedAt) || null,
		providers,
	};
}

/**
 * Flatten a normalized snapshot into cards. Providers with no accounts (error
 * or simply unconfigured) still produce one visible provider card.
 * @param {LayoutSnapshot} snapshot
 * @returns {Card[]}
 */
export function buildCards(snapshot) {
	const cards = [];
	for (const provider of snapshot.providers) {
		if (provider.accounts.length === 0) {
			const status = provider.error ? "error" : "empty";
			cards.push({
				key: `${provider.id}:`,
				kind: "provider",
				providerId: provider.id,
				providerName: provider.name,
				status,
				account: null,
				message: status === "error" ? `error: ${provider.error}` : "no accounts",
			});
			continue;
		}
		for (const account of provider.accounts) {
			cards.push({
				key: `${provider.id}:${account.label}`,
				kind: "account",
				providerId: provider.id,
				providerName: provider.name,
				status: account.status,
				account,
				message: null,
			});
		}
	}
	return cards;
}

/**
 * Column count and card width for a terminal width (plan §3.3 grid math).
 * @param {number} cols - Terminal columns
 * @param {number} cardCount
 * @returns {{ columns: number, cardWidth: number }}
 */
export function computeGrid(cols, cardCount) {
	const width = toNonNegativeInt(cols, 0);
	const count = toNonNegativeInt(cardCount, 0);
	if (width <= 0 || count <= 0) return { columns: 0, cardWidth: 0 };
	let columns = Math.floor((width + CARD_GAP) / (TARGET_CARD_WIDTH + CARD_GAP));
	columns = Math.max(1, Math.min(columns, count));
	const cardWidth = Math.floor((width - CARD_GAP * (columns - 1)) / columns);
	return { columns, cardWidth: Math.max(0, cardWidth) };
}

/**
 * Density tier for a card width: 3 full, 2 short resets, 1 no bars, 0 table.
 * @param {number} cardWidth
 * @returns {0 | 1 | 2 | 3}
 */
export function tierForWidth(cardWidth) {
	if (cardWidth >= TIER_MIN_WIDTH[3]) return 3;
	if (cardWidth >= TIER_MIN_WIDTH[2]) return 2;
	if (cardWidth >= TIER_MIN_WIDTH[1]) return 1;
	return 0;
}

/**
 * Exact rendered height of a card at a tier (borders included). Renderers must
 * emit exactly this many lines.
 * @param {Card} card
 * @param {0 | 1 | 2 | 3} tier
 * @param {boolean} [showExtras=false]
 * @returns {number}
 */
export function cardHeight(card, tier, showExtras = false) {
	if (tier === 0) return 1;
	if (card.kind === "provider") return CARD_CHROME_HEIGHT + 1;
	const account = card.account;
	if (account.status !== "ok") return CARD_CHROME_HEIGHT + 1;
	const body = Math.max(1, account.windows.length) + (showExtras ? account.extras.length : 0);
	return CARD_CHROME_HEIGHT + body;
}

/**
 * Row-major placement; every card in a row shares that row's tallest height.
 * @param {Card[]} cards
 * @param {{ columns: number, cardWidth: number }} grid
 * @param {1 | 2 | 3} tier
 * @param {boolean} showExtras
 * @returns {{ placed: PlacedCard[], totalHeight: number }}
 */
function placeCards(cards, grid, tier, showExtras) {
	const placed = [];
	let y = 0;
	for (let start = 0; start < cards.length; start += grid.columns) {
		const rowCards = cards.slice(start, start + grid.columns);
		const heights = rowCards.map(card => cardHeight(card, tier, showExtras));
		const rowHeight = Math.max(...heights);
		const row = start / grid.columns;
		if (row > 0) y += ROW_GAP;
		rowCards.forEach((card, col) => {
			placed.push({
				card,
				row,
				col,
				x: col * (grid.cardWidth + CARD_GAP),
				y,
				width: grid.cardWidth,
				height: heights[col],
				rowHeight,
			});
		});
		y += rowHeight;
	}
	return { placed, totalHeight: y };
}

/**
 * Tier-0 table placement: one line per card under a two-line header.
 * @param {Card[]} cards
 * @param {number} cols
 * @returns {{ placed: PlacedCard[], totalHeight: number }}
 */
function placeTable(cards, cols) {
	if (cols <= 0) return { placed: [], totalHeight: 0 };
	if (cards.length === 0) return { placed: [], totalHeight: 1 };
	const placed = cards.map((card, index) => ({
		card,
		row: index,
		col: 0,
		x: 0,
		y: TABLE_HEADER_HEIGHT + index,
		width: cols,
		height: 1,
		rowHeight: 1,
	}));
	return { placed, totalHeight: TABLE_HEADER_HEIGHT + cards.length };
}

/**
 * Clamp a requested scroll offset to the content and compute hidden-row counts.
 * @param {number} totalHeight
 * @param {number} rowLimit - Visible rows (Infinity = unbounded)
 * @param {unknown} scroll - Requested offset
 * @returns {Viewport}
 */
export function clampScroll(totalHeight, rowLimit, scroll) {
	const visibleRows = rowLimit === Infinity ? totalHeight : toNonNegativeInt(rowLimit, totalHeight);
	const maxOffset = Math.max(0, totalHeight - visibleRows);
	const offset = Math.min(maxOffset, toNonNegativeInt(scroll, 0));
	return {
		offset,
		maxOffset,
		visibleRows,
		hiddenAbove: offset,
		hiddenBelow: Math.max(0, totalHeight - offset - visibleRows),
	};
}

/**
 * Compute the full layout for a snapshot and terminal size.
 *
 * Width picks the column count and the maximum tier. Height falls back in
 * order (plan §3.3): tier 3 with extras → tier 3 → tier 2 → tier 1 → tier 0
 * (table) → scroll (at tier 0). Width below `MIN_CARD_WIDTH` always yields the
 * tier-0 table. `cols` 0 yields an empty layout; an empty snapshot yields a
 * single message line.
 *
 * @param {unknown} snapshot - schemaVersion 2 snapshot (malformed input tolerated)
 * @param {{ cols?: number, rows?: number, scroll?: number }} [options]
 * @returns {Layout}
 */
export function computeLayout(snapshot, options = {}) {
	const cols = toNonNegativeInt(options.cols, 80);
	const rowLimit = options.rows == null ? Infinity : toNonNegativeInt(options.rows, Infinity);
	const normalized = normalizeSnapshot(snapshot);
	const cards = buildCards(normalized);
	const grid = computeGrid(cols, cards.length);
	const maxTier = grid.columns > 0 ? tierForWidth(grid.cardWidth) : 0;

	let tier = 0;
	let showExtras = false;
	let placement = placeTable(cards, cols);
	for (const candidate of FALLBACK_SEQUENCE) {
		if (candidate.tier > maxTier) continue;
		tier = candidate.tier;
		showExtras = candidate.showExtras;
		placement = tier === 0 ? placeTable(cards, cols) : placeCards(cards, grid, tier, showExtras);
		if (placement.totalHeight <= rowLimit) break;
	}

	const { placed, totalHeight } = placement;
	return {
		schemaVersion: 2,
		cols,
		rows: rowLimit,
		columns: tier === 0 ? (cards.length > 0 && cols > 0 ? 1 : 0) : grid.columns,
		cardWidth: tier === 0 ? cols : grid.cardWidth,
		tier,
		showExtras,
		cards,
		placed,
		totalHeight,
		fits: totalHeight <= rowLimit,
		viewport: clampScroll(totalHeight, rowLimit, options.scroll),
	};
}
