/**
 * Pure renderers for the TUI (plan §3.4 / Phase 4).
 *
 * Every function here is deterministic given its inputs: `now` is injected,
 * reset times are formatted in a fixed IANA time zone (Pacific by default),
 * colour is opt-in and never affects geometry, and no function touches the
 * terminal. Depends only on ./width.js and ./layout.js.
 *
 * Public API (see the final report for integration notes):
 *   renderStatic(snapshot, opts)  → string[] full layout, all lines (one-shot print)
 *   renderCompact(snapshot, opts) → string[] grep-friendly, one metric per line
 *   renderView(layout, opts)      → { lines, viewport, indicator }  scrolled viewport
 *   renderLayout(layout, opts)    → string[] exactly layout.totalHeight lines
 *   renderCard(card, opts)        → string[] exactly `height` lines, rounded border
 *   renderTable(layout, opts)     → string[] tier-0 fallback table
 *   formatReset / formatBar / formatPercent / redactEmail / scrollIndicator
 *
 * opts: { now?: Date|string|number, timeZone?: string, color?: boolean, showEmail?: boolean }
 */

import { cellWidth, padEnd, truncate } from "./width.js";
import {
	CARD_GAP,
	ROW_GAP,
	TABLE_HEADER_HEIGHT,
	cardHeight,
	computeLayout,
} from "./layout.js";

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
export const BAR_MIN_WIDTH = 8;
export const BAR_MAX_WIDTH = 30;
/** Widest window label shown in a card row. */
export const LABEL_MAX_WIDTH = 8;
/** Remaining-percent thresholds for colour tone (plan §3.3: ≤20 red, ≤60 yellow, else green). */
export const TONE_THRESHOLDS = Object.freeze({ bad: 20, warn: 60 });

const BAR_FILL = "█";
const BAR_EMPTY = "░";
const PERCENT_WIDTH = 4; // " 64%" / "100%" / " --%"
const SGR = Object.freeze({
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	dim: "\x1b[2m",
	reset: "\x1b[0m",
});
const DAY_MS = 24 * 60 * 60 * 1000;
const LONG_RESET_DATE_AFTER_MS = 6 * DAY_MS;

const TABLE_ABBREVIATIONS = new Map([
	["weekly", "wk"],
	["week", "wk"],
	["monthly", "mo"],
	["month", "mo"],
	["daily", "day"],
	["requests", "req"],
	["search", "srch"],
	["session", "sess"],
]);

/** @type {Map<string, { time: Intl.DateTimeFormat, date: Intl.DateTimeFormat }>} */
const formatterCache = new Map();

/**
 * @param {unknown} value
 * @returns {Date | null}
 */
function toDate(value) {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value === "number" || typeof value === "string") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	return null;
}

/**
 * @param {string} timeZone
 * @returns {{ time: Intl.DateTimeFormat, date: Intl.DateTimeFormat }}
 */
function formattersFor(timeZone) {
	let cached = formatterCache.get(timeZone);
	if (!cached) {
		cached = {
			time: new Intl.DateTimeFormat("en-US", {
				timeZone,
				hourCycle: "h23",
				hour: "2-digit",
				minute: "2-digit",
				weekday: "short",
			}),
			date: new Intl.DateTimeFormat("en-US", {
				timeZone,
				hourCycle: "h23",
				hour: "2-digit",
				minute: "2-digit",
				month: "short",
				day: "numeric",
			}),
		};
		formatterCache.set(timeZone, cached);
	}
	return cached;
}

/**
 * @param {Intl.DateTimeFormat} formatter
 * @param {Date} date
 * @returns {Record<string, string>}
 */
function parts(formatter, date) {
	const out = {};
	for (const part of formatter.formatToParts(date)) out[part.type] = part.value;
	return out;
}

/**
 * Resolve shared render options with deterministic defaults.
 * @param {object} [opts]
 * @returns {{ now: Date, timeZone: string, color: boolean, showEmail: boolean }}
 */
function resolveOptions(opts = {}) {
	return {
		now: toDate(opts.now) ?? new Date(),
		timeZone: typeof opts.timeZone === "string" && opts.timeZone ? opts.timeZone : DEFAULT_TIME_ZONE,
		color: Boolean(opts.color),
		showEmail: Boolean(opts.showEmail),
	};
}

/**
 * Format a reset instant relative to `now`.
 *  - long:  "15:15 Thu" (same week) / "12:00 Sep 25" (6+ days out) / "now"
 *  - short: "45m" / "3h" / "2d" / "now"
 * Returns "" for missing or unparseable input.
 * @param {unknown} resetsAt
 * @param {Date | string | number} now
 * @param {"long" | "short"} [style="long"]
 * @param {string} [timeZone=DEFAULT_TIME_ZONE]
 * @returns {string}
 */
export function formatReset(resetsAt, now, style = "long", timeZone = DEFAULT_TIME_ZONE) {
	const reset = toDate(resetsAt);
	if (!reset) return "";
	const base = toDate(now) ?? new Date();
	const diff = reset.getTime() - base.getTime();
	if (diff < 60_000) return "now";
	if (style === "short") {
		if (diff < 60 * 60_000) return `${Math.ceil(diff / 60_000)}m`;
		if (diff < DAY_MS) return `${Math.floor(diff / (60 * 60_000))}h`;
		return `${Math.floor(diff / DAY_MS)}d`;
	}
	let zone;
	try {
		zone = formattersFor(timeZone);
	} catch {
		zone = formattersFor(DEFAULT_TIME_ZONE);
	}
	if (diff >= LONG_RESET_DATE_AFTER_MS) {
		const p = parts(zone.date, reset);
		return `${p.hour}:${p.minute} ${p.month} ${p.day}`;
	}
	const p = parts(zone.time, reset);
	return `${p.hour}:${p.minute} ${p.weekday}`;
}

/**
 * "64%" for a remaining percentage, "--%" when unknown. Always 3–4 cells.
 * @param {number | null | undefined} percent
 * @returns {string}
 */
export function formatPercent(percent) {
	if (percent == null || !Number.isFinite(percent)) return "--%";
	return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

/**
 * Colour tone for a remaining percentage.
 * @param {number | null | undefined} percent
 * @returns {"good" | "warn" | "bad" | "none"}
 */
export function percentTone(percent) {
	if (percent == null || !Number.isFinite(percent)) return "none";
	if (percent <= TONE_THRESHOLDS.bad) return "bad";
	if (percent <= TONE_THRESHOLDS.warn) return "warn";
	return "good";
}

/**
 * Fixed-width remaining bar: filled cells scale with `percent`, unknown = empty.
 * Uses only single-cell block glyphs so geometry is exact.
 * @param {number | null | undefined} percent
 * @param {number} width
 * @returns {string}
 */
export function formatBar(percent, width) {
	const cells = Math.max(0, Math.floor(Number(width) || 0));
	if (cells === 0) return "";
	const value = percent == null || !Number.isFinite(percent) ? 0 : Math.min(100, Math.max(0, percent));
	const filled = Math.min(cells, Math.max(0, Math.round((cells * value) / 100)));
	return BAR_FILL.repeat(filled) + BAR_EMPTY.repeat(cells - filled);
}

/**
 * Mask an email to its first local character plus domain: "s***@example.com".
 * @param {string | null | undefined} email
 * @returns {string}
 */
export function redactEmail(email) {
	const value = String(email ?? "");
	if (!value) return "";
	const at = value.indexOf("@");
	if (at < 0) return `${Array.from(value)[0] ?? ""}***`;
	const first = Array.from(value.slice(0, at))[0] ?? "";
	return `${first}***${value.slice(at)}`;
}

/**
 * @param {string} text
 * @param {"good" | "warn" | "bad" | "none" | "dim"} tone
 * @param {boolean} color
 * @returns {string}
 */
function paint(text, tone, color) {
	if (!color || !text) return text;
	const code = tone === "good" ? SGR.green
		: tone === "warn" ? SGR.yellow
			: tone === "bad" ? SGR.red
				: tone === "dim" ? SGR.dim : "";
	return code ? `${code}${text}${SGR.reset}` : text;
}

/**
 * Pad/truncate a possibly-coloured line to exactly `width` cells. Colour is
 * dropped only when truncation is required (so codes are never cut mid-sequence).
 * @param {string} line
 * @param {number} width
 * @returns {string}
 */
function fitLine(line, width) {
	if (width <= 0) return "";
	return cellWidth(line) <= width ? padEnd(line, width) : padEnd(truncate(line, width), width);
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function padLeft(text, width) {
	const missing = width - cellWidth(text);
	return missing > 0 ? " ".repeat(missing) + text : text;
}

/**
 * Card header: "Provider · label · plan · email" (email redacted unless showEmail).
 * @param {import("./layout.js").Card} card
 * @param {{ showEmail: boolean }} opts
 * @returns {string}
 */
export function headerLine(card, opts) {
	const segments = [card.providerName];
	if (card.account) {
		segments.push(card.account.label);
		if (card.account.plan) segments.push(card.account.plan);
		if (card.account.email) {
			segments.push(opts.showEmail ? card.account.email : redactEmail(card.account.email));
		}
	}
	return segments.join(" · ");
}

/**
 * Bar width that leaves room for label, percent, and a reset tail of
 * `tailWidth` cells, clamped to [BAR_MIN_WIDTH, BAR_MAX_WIDTH].
 * @param {number} innerWidth
 * @param {number} labelWidth
 * @param {number} tailWidth - 0 when there is no reset tail
 * @returns {number}
 */
export function barWidthFor(innerWidth, labelWidth, tailWidth) {
	const fixed = labelWidth + 1 + 1 + PERCENT_WIDTH;
	const wanted = innerWidth - fixed - (tailWidth > 0 ? 1 + tailWidth : 0);
	return Math.max(BAR_MIN_WIDTH, Math.min(BAR_MAX_WIDTH, wanted));
}

/**
 * One quota window row for a card body at a given tier.
 *  tier 3: "label    ████░░░░  64% resets 15:15 Thu"
 *  tier 2: "label    ████░░░░  64% resets 3h"
 *  tier 1: "label     64%  resets 3h"
 * The percent text is always present; the bar shrinks (≥ BAR_MIN_WIDTH) and the
 * reset tail is truncated or dropped before the percent is ever displaced.
 * @param {import("./layout.js").LayoutWindow} window
 * @param {{ tier: 1 | 2 | 3, innerWidth: number, labelWidth: number, now: Date, timeZone: string, color: boolean }} ctx
 * @returns {string}
 */
export function windowLine(window, ctx) {
	const labelWidth = Math.max(1, Math.min(LABEL_MAX_WIDTH, ctx.labelWidth));
	const label = padEnd(truncate(window.label, labelWidth), labelWidth);
	const pctPlain = padLeft(formatPercent(window.percentRemaining), PERCENT_WIDTH);
	const tone = percentTone(window.percentRemaining);
	const style = ctx.tier === 3 ? "long" : "short";
	const resetText = window.resetsAt ? formatReset(window.resetsAt, ctx.now, style, ctx.timeZone) : "";
	const tailText = resetText ? `resets ${resetText}` : "";

	if (ctx.tier === 1) {
		const head = `${label} `;
		const tail = tailText ? `  ${tailText}` : "";
		const plain = `${head}${pctPlain}${tail}`;
		if (cellWidth(plain) > ctx.innerWidth) return truncate(plain, ctx.innerWidth);
		return `${head}${paint(pctPlain, tone, ctx.color)}${tail}`;
	}

	const fixed = labelWidth + 1 + 1 + PERCENT_WIDTH; // label, space, bar, space, percent
	const barWidth = Number.isInteger(ctx.barWidth)
		? ctx.barWidth
		: barWidthFor(ctx.innerWidth, labelWidth, tailText ? cellWidth(tailText) : 0);
	const remaining = ctx.innerWidth - fixed - barWidth;
	let tail = "";
	if (tailText) {
		const tailWidth = cellWidth(tailText);
		if (remaining >= 1 + tailWidth) tail = ` ${tailText}`;
		else if (remaining >= 3) tail = ` ${truncate(tailText, remaining - 1)}`;
	}
	const bar = formatBar(window.percentRemaining, barWidth);
	const plain = `${label} ${bar} ${pctPlain}${tail}`;
	if (cellWidth(plain) > ctx.innerWidth) return truncate(plain, ctx.innerWidth);
	return `${label} ${paint(`${bar} ${pctPlain}`, tone, ctx.color)}${tail}`;
}

/**
 * Body lines (no border, no header) for a card.
 * @param {import("./layout.js").Card} card
 * @param {{ tier: 1 | 2 | 3, innerWidth: number, showExtras: boolean, now: Date, timeZone: string, color: boolean }} ctx
 * @returns {string[]}
 */
function bodyLines(card, ctx) {
	if (card.kind === "provider") {
		const tone = card.status === "error" ? "bad" : "dim";
		return [paint(truncate(card.message ?? "", ctx.innerWidth), tone, ctx.color)];
	}
	const account = card.account;
	if (account.status === "loading") return [paint("loading…", "dim", ctx.color)];
	if (account.status === "error") {
		return [paint(truncate(`error: ${account.error}`, ctx.innerWidth), "bad", ctx.color)];
	}
	const lines = [];
	if (account.windows.length === 0) {
		lines.push(paint("no quota windows", "dim", ctx.color));
	} else {
		const labelWidth = Math.min(
			LABEL_MAX_WIDTH,
			Math.max(1, ...account.windows.map(window => cellWidth(window.label))),
		);
		// One bar width per card so every row's bar and percent column line up.
		const style = ctx.tier === 3 ? "long" : "short";
		const widestTail = Math.max(0, ...account.windows.map(window => {
			const reset = window.resetsAt ? formatReset(window.resetsAt, ctx.now, style, ctx.timeZone) : "";
			return reset ? cellWidth(`resets ${reset}`) : 0;
		}));
		const barWidth = ctx.tier === 1 ? undefined : barWidthFor(ctx.innerWidth, labelWidth, widestTail);
		for (const window of account.windows) lines.push(windowLine(window, { ...ctx, labelWidth, barWidth }));
	}
	if (ctx.showExtras) {
		for (const extra of account.extras) {
			const text = extra.label ? `${extra.label}: ${extra.value}` : extra.value;
			lines.push(paint(truncate(text, ctx.innerWidth), "dim", ctx.color));
		}
	}
	return lines;
}

/**
 * Wrap header + body in a rounded border, exactly `height` lines of `width` cells.
 * @param {string} header
 * @param {string[]} body
 * @param {number} width
 * @param {number} height
 * @returns {string[]}
 */
function frame(header, body, width, height) {
	const w = Math.max(0, Math.floor(width));
	const h = Math.max(0, Math.floor(height));
	if (w === 0 || h === 0) return Array.from({ length: h }, () => "");
	const inner = w - 4;
	const horizontal = "─".repeat(Math.max(0, w - 2));
	const top = truncate(`╭${horizontal}╮`, w);
	const bottom = truncate(`╰${horizontal}╯`, w);
	const content = line => (inner >= 0 ? `│ ${fitLine(line, inner)} │` : truncate(`│${line}│`, w));
	const lines = [top, content(header)];
	for (const line of body) lines.push(content(line));
	while (lines.length < h - 1) lines.push(content(""));
	lines.length = Math.max(1, h - 1);
	lines.push(bottom);
	return lines.slice(0, h);
}

/**
 * Render one card with a rounded border.
 * @param {import("./layout.js").Card} card
 * @param {{ tier: 1 | 2 | 3, width: number, height?: number, showExtras?: boolean,
 *   now?: Date|string|number, timeZone?: string, color?: boolean, showEmail?: boolean }} opts
 * @returns {string[]} exactly `height` (default cardHeight) lines
 */
export function renderCard(card, opts) {
	const shared = resolveOptions(opts);
	const tier = opts.tier === 1 || opts.tier === 2 ? opts.tier : 3;
	const showExtras = Boolean(opts.showExtras);
	const width = Math.max(0, Math.floor(Number(opts.width) || 0));
	const height = opts.height == null ? cardHeight(card, tier, showExtras) : Math.max(0, Math.floor(opts.height));
	const innerWidth = Math.max(0, width - 4);
	const header = headerLine(card, shared);
	const body = bodyLines(card, { ...shared, tier, innerWidth, showExtras });
	return frame(header, body, width, height);
}

/**
 * Short label for the tier-0 table ("Weekly" → "wk"); unknown labels truncate to 4.
 * @param {string} label
 * @returns {string}
 */
export function tableLabel(label) {
	const key = String(label ?? "").trim().toLowerCase();
	return TABLE_ABBREVIATIONS.get(key) ?? truncate(label, 4);
}

/**
 * Tier-0 fallback table: header, rule, one line per card. Exactly
 * layout.totalHeight lines; an empty snapshot yields one message line.
 * @param {import("./layout.js").Layout} layout
 * @param {object} [opts]
 * @returns {string[]}
 */
export function renderTable(layout, opts = {}) {
	const shared = resolveOptions(opts);
	const cols = Math.max(0, Math.floor(layout.cols));
	if (cols === 0) return [];
	if (layout.cards.length === 0) return [fitLine("No quota data", cols)];

	const narrow = cols < 40;
	const providerWidth = Math.min(
		narrow ? 6 : 11,
		Math.max(...layout.cards.map(card => cellWidth(card.providerName)), 1),
	);
	const accountWidth = Math.min(
		narrow ? 8 : 14,
		Math.max(...layout.cards.map(card => cellWidth(card.account?.label ?? "—")), 1),
	);
	const cell = (text, width) => padEnd(truncate(text, width), width);

	const rows = layout.cards.map(card => {
		let summary;
		let colored;
		if (card.kind === "provider") {
			summary = card.message ?? "";
			colored = paint(summary, card.status === "error" ? "bad" : "dim", shared.color);
		} else if (card.account.status === "error") {
			summary = `error: ${card.account.error}`;
			colored = paint(summary, "bad", shared.color);
		} else if (card.account.status === "loading") {
			summary = "loading…";
			colored = paint(summary, "dim", shared.color);
		} else if (card.account.windows.length === 0) {
			summary = "no quota windows";
			colored = paint(summary, "dim", shared.color);
		} else {
			const plainParts = [];
			const coloredParts = [];
			for (const window of card.account.windows) {
				const pct = formatPercent(window.percentRemaining);
				plainParts.push(`${tableLabel(window.label)} ${pct}`);
				coloredParts.push(`${tableLabel(window.label)} ${paint(pct, percentTone(window.percentRemaining), shared.color)}`);
			}
			summary = plainParts.join(" · ");
			colored = coloredParts.join(" · ");
		}
		const prefix = `${cell(card.providerName, providerWidth)}  ${cell(card.account?.label ?? "—", accountWidth)}  `;
		const plain = `${prefix}${summary}`;
		return cellWidth(plain) <= cols ? `${prefix}${colored}` : truncate(plain, cols);
	});

	const providerHeader = providerWidth >= 8 ? "provider" : "prov";
	const accountHeader = accountWidth >= 7 ? "account" : "acct";
	const header = truncate(`${cell(providerHeader, providerWidth)}  ${cell(accountHeader, accountWidth)}  quota`, cols);
	const widest = Math.max(cellWidth(header), ...rows.map(cellWidth));
	const rule = "─".repeat(Math.min(cols, widest));
	const lines = [header, rule, ...rows];
	if (lines.length !== TABLE_HEADER_HEIGHT + layout.cards.length) {
		lines.length = TABLE_HEADER_HEIGHT + layout.cards.length;
	}
	return lines.map(line => line ?? "");
}

/**
 * Render a computed layout to exactly `layout.totalHeight` lines, each at most
 * `layout.cols` cells wide. Cards in a row are joined with CARD_GAP spaces and
 * rows are separated by ROW_GAP blank lines.
 * @param {import("./layout.js").Layout} layout
 * @param {object} [opts]
 * @returns {string[]}
 */
export function renderLayout(layout, opts = {}) {
	if (!layout || layout.cols <= 0) return [];
	if (layout.tier === 0) return renderTable(layout, opts);

	const byRow = new Map();
	for (const placed of layout.placed) {
		if (!byRow.has(placed.row)) byRow.set(placed.row, []);
		byRow.get(placed.row).push(placed);
	}
	const lines = [];
	const gap = " ".repeat(CARD_GAP);
	for (const [rowIndex, rowCards] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
		if (rowIndex > 0) for (let i = 0; i < ROW_GAP; i++) lines.push("");
		const rowHeight = rowCards[0].rowHeight;
		const rendered = rowCards
			.sort((a, b) => a.col - b.col)
			.map(placed => {
				const cardLines = renderCard(placed.card, {
					...opts,
					tier: layout.tier,
					width: placed.width,
					height: placed.height,
					showExtras: layout.showExtras,
				});
				while (cardLines.length < rowHeight) cardLines.push(" ".repeat(placed.width));
				return cardLines;
			});
		for (let i = 0; i < rowHeight; i++) {
			lines.push(rendered.map(cardLines => cardLines[i]).join(gap).replace(/\s+$/, ""));
		}
	}
	return lines;
}

/**
 * "↑3 ↓5"-style indicator for a scrolled viewport, or "" when everything fits.
 * @param {import("./layout.js").Viewport} viewport
 * @returns {string}
 */
export function scrollIndicator(viewport) {
	if (!viewport) return "";
	const bits = [];
	if (viewport.hiddenAbove > 0) bits.push(`↑${viewport.hiddenAbove}`);
	if (viewport.hiddenBelow > 0) bits.push(`↓${viewport.hiddenBelow}`);
	return bits.join(" ");
}

/**
 * Render only the visible rows of a layout (for the interactive app). The app
 * owns any status/indicator line; `indicator` is provided for convenience.
 * @param {import("./layout.js").Layout} layout
 * @param {object} [opts]
 * @returns {{ lines: string[], viewport: import("./layout.js").Viewport, indicator: string }}
 */
export function renderView(layout, opts = {}) {
	const all = renderLayout(layout, opts);
	const viewport = layout.viewport;
	const lines = Number.isFinite(layout.rows)
		? all.slice(viewport.offset, viewport.offset + viewport.visibleRows)
		: all;
	return { lines, viewport, indicator: scrollIndicator(viewport) };
}

/**
 * One-shot static render: computes the layout (tier fallback uses `rows` when
 * given) and returns every line as an array (plan §3.4: `string[]`). Nothing is
 * scrolled away; callers join with "\n" for printing.
 * @param {unknown} snapshot - schemaVersion 2 snapshot
 * @param {{ cols?: number, rows?: number, now?: Date|string|number, timeZone?: string,
 *   color?: boolean, showEmail?: boolean }} [opts]
 * @returns {string[]}
 */
export function renderStatic(snapshot, opts = {}) {
	const layout = computeLayout(snapshot, { cols: opts.cols, rows: opts.rows });
	return renderLayout(layout, opts);
}

/**
 * Compact, grep-friendly output: a header line per account and one metric per
 * line ("  label: 64% left, resets 15:15 Thu (1.2M / 5M tokens)"). Not
 * width-bound; no borders. Returns lines (`string[]`) like renderStatic.
 * @param {unknown} snapshot
 * @param {{ now?: Date|string|number, timeZone?: string, color?: boolean, showEmail?: boolean }} [opts]
 * @returns {string[]}
 */
export function renderCompact(snapshot, opts = {}) {
	const shared = resolveOptions(opts);
	const layout = computeLayout(snapshot, { cols: Number.MAX_SAFE_INTEGER });
	if (layout.cards.length === 0) return ["No quota data"];
	const lines = [];
	for (const card of layout.cards) {
		lines.push(headerLine(card, shared));
		if (card.kind === "provider") {
			lines.push(`  ${paint(card.message ?? "", card.status === "error" ? "bad" : "dim", shared.color)}`);
			continue;
		}
		const account = card.account;
		if (account.status === "loading") {
			lines.push(`  ${paint("loading…", "dim", shared.color)}`);
		} else if (account.status === "error") {
			lines.push(`  ${paint(`error: ${account.error}`, "bad", shared.color)}`);
		} else if (account.windows.length === 0) {
			lines.push(`  ${paint("no quota windows", "dim", shared.color)}`);
		} else {
			for (const window of account.windows) {
				const pct = paint(formatPercent(window.percentRemaining), percentTone(window.percentRemaining), shared.color);
				const reset = window.resetsAt ? formatReset(window.resetsAt, shared.now, "long", shared.timeZone) : "";
				const detail = window.detail ? ` (${window.detail})` : "";
				lines.push(`  ${window.label}: ${pct} left${reset ? `, resets ${reset}` : ""}${detail}`);
			}
		}
		for (const extra of account.extras) {
			lines.push(`  ${extra.label ? `${extra.label}: ` : ""}${extra.value}`);
		}
	}
	return lines;
}
