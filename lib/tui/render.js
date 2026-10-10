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
 *   renderTable(layout, opts)     → string[] tier-0 dense list (one line per window)
 *   formatReset / formatBar / formatPercent / redactEmail / scrollIndicator
 *
 * opts: { now?: Date|string|number, timeZone?: string, color?: boolean, showEmail?: boolean }
 */

import { cellWidth, padEnd, truncate } from "./width.js";
import {
	CARD_GAP,
	ROW_GAP,
	cardHeight,
	computeLayout,
} from "./layout.js";

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
export const BAR_MIN_WIDTH = 8;
/** Bar bounds in the tier-0 list, where rows compete with name columns. */
export const LIST_BAR_MIN_WIDTH = 6;
export const LIST_BAR_MAX_WIDTH = 30;
export const BAR_MAX_WIDTH = 56;
/** Widest window label shown in a card row before truncation. */
export const LABEL_MAX_WIDTH = 16;
/** Labels shrink to this width before a card gives up its bars. */
export const LABEL_MIN_WIDTH = 6;
/** Remaining-percent thresholds for colour tone (plan §3.3: ≤20 red, ≤60 yellow, else green). */
export const TONE_THRESHOLDS = Object.freeze({ bad: 20, warn: 60 });
/** Braille spinner frames for loading states. */
export const SPINNER_FRAMES = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

const BAR_FILL = "━";
const BAR_HALF = "╸";
const BAR_EMPTY = "─";
const PERCENT_WIDTH = 4; // " 64%" / "100%" / " --%"
const COLUMN_GAP = "  ";
const RESET = "\x1b[0m";
/** SGR prefixes by style name. Tones use the 16-colour palette so terminal themes apply. */
const SGR = Object.freeze({
	good: "\x1b[32m",
	warn: "\x1b[33m",
	bad: "\x1b[31m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	strong: "\x1b[1m",
	inverse: "\x1b[7m",
	"good-bold": "\x1b[1;32m",
	"warn-bold": "\x1b[1;33m",
	"bad-bold": "\x1b[1;31m",
});
/** Provider accents (256-colour) for card borders and titles. */
const ACCENTS = Object.freeze({
	codex: 111,
	claude: 173,
	grok: 250,
	cursor: 255,
	antigravity: 141,
});
const DEFAULT_ACCENT = 246;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LONG_RESET_DATE_AFTER_MS = 6 * DAY_MS;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

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
 * @param {string} timeZone
 * @returns {{ time: Intl.DateTimeFormat, date: Intl.DateTimeFormat }}
 */
function safeFormatters(timeZone) {
	try {
		return formattersFor(timeZone);
	} catch {
		return formattersFor(DEFAULT_TIME_ZONE);
	}
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
 *  - long:     "15:15 Thu" (same week) / "12:00 Sep 25" (6+ days out) / "now"
 *  - short:    "45m" / "3h" / "2d" / "now"
 *  - relative: "45m" / "3h 12m" / "2d 7h" / "now" (two units, countdown style)
 *  - clock:    "Thu 15:15" (same week) / "Sep 25" (6+ days out) / "now"
 * Returns "" for missing or unparseable input.
 * @param {unknown} resetsAt
 * @param {Date | string | number} now
 * @param {"long" | "short" | "relative" | "clock"} [style="long"]
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
		if (diff < HOUR_MS) return `${Math.ceil(diff / 60_000)}m`;
		if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
		return `${Math.floor(diff / DAY_MS)}d`;
	}
	if (style === "relative") {
		const minutes = Math.floor(diff / 60_000);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
		const days = Math.floor(hours / 24);
		return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
	}
	const zone = safeFormatters(timeZone);
	if (diff >= LONG_RESET_DATE_AFTER_MS) {
		const p = parts(zone.date, reset);
		return style === "clock" ? `${p.month} ${p.day}` : `${p.hour}:${p.minute} ${p.month} ${p.day}`;
	}
	const p = parts(zone.time, reset);
	return style === "clock" ? `${p.weekday} ${p.hour}:${p.minute}` : `${p.hour}:${p.minute} ${p.weekday}`;
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
 * Split a bar into its filled and empty parts at half-cell resolution.
 * @param {number | null | undefined} percent
 * @param {number} width
 * @returns {{ fill: string, track: string }}
 */
function barParts(percent, width) {
	const cells = Math.max(0, Math.floor(Number(width) || 0));
	if (cells === 0) return { fill: "", track: "" };
	const value = percent == null || !Number.isFinite(percent) ? 0 : Math.min(100, Math.max(0, percent));
	const halves = Math.min(cells * 2, Math.max(0, Math.round((cells * 2 * value) / 100)));
	const full = Math.floor(halves / 2);
	const fill = BAR_FILL.repeat(full) + (halves % 2 ? BAR_HALF : "");
	return { fill, track: BAR_EMPTY.repeat(cells - full - (halves % 2)) };
}

/**
 * Fixed-width remaining bar at half-cell resolution: "━━━━╸───". Unknown = empty
 * track. Uses only single-cell box glyphs so geometry is exact.
 * @param {number | null | undefined} percent
 * @param {number} width
 * @returns {string}
 */
export function formatBar(percent, width) {
	const { fill, track } = barParts(percent, width);
	return fill + track;
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
 * SGR prefix for a style name, provider accent ("accent:codex"), or "" for none.
 * @param {string | undefined} style
 * @returns {string}
 */
function sgrFor(style) {
	if (!style || style === "none") return "";
	if (style.startsWith("accent:") || style.startsWith("border:") || style.startsWith("title:")) {
		const [kind, id] = style.split(":");
		const code = ACCENTS[id] ?? DEFAULT_ACCENT;
		if (kind === "title") return `\x1b[1;38;5;${code}m`;
		if (kind === "border") return `\x1b[2;38;5;${code}m`;
		return `\x1b[38;5;${code}m`;
	}
	return SGR[style] ?? "";
}

/**
 * @param {string} text
 * @param {string} tone - style name (see sgrFor)
 * @param {boolean} color
 * @returns {string}
 */
function paint(text, tone, color) {
	if (!color || !text) return text;
	const code = sgrFor(tone);
	return code ? `${code}${text}${RESET}` : text;
}

/**
 * A styled run of text. Lines are built from segments so they can be
 * width-fitted before colour is applied (colour never affects geometry).
 * @typedef {{ text: string, style?: string }} Segment
 */

/**
 * @param {string} text
 * @param {string} [style]
 * @returns {Segment}
 */
export function seg(text, style) {
	return { text: String(text ?? ""), style };
}

/**
 * Join segments into one line of at most `width` cells, truncating the
 * overflowing segment with "…" and dropping the rest. Colour survives truncation.
 * @param {Segment[]} segments
 * @param {number} width
 * @param {boolean} color
 * @returns {string}
 */
export function composeLine(segments, width, color) {
	const limit = Math.max(0, Math.floor(width));
	const total = segments.reduce((sum, s) => sum + cellWidth(s.text), 0);
	let out = "";
	if (total <= limit) {
		for (const s of segments) out += paint(s.text, s.style, color);
		return out;
	}
	let used = 0;
	for (const s of segments) {
		const w = cellWidth(s.text);
		if (used + w < limit) {
			out += paint(s.text, s.style, color);
			used += w;
			continue;
		}
		out += paint(truncate(s.text, limit - used), s.style, color);
		break;
	}
	return out;
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
 * Plan text worth showing next to the label; hidden when it only repeats the label.
 * @param {import("./layout.js").LayoutAccount} account
 * @returns {string}
 */
function distinctPlan(account) {
	if (!account.plan) return "";
	const label = account.label.toLowerCase().replace(/\s+/g, "");
	const plan = account.plan.toLowerCase().replace(/\s+/g, "");
	return label.includes(plan) ? "" : account.plan;
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
	const gap = COLUMN_GAP.length;
	const fixed = labelWidth + gap + gap + PERCENT_WIDTH;
	const wanted = innerWidth - fixed - (tailWidth > 0 ? gap + tailWidth : 0);
	return Math.max(BAR_MIN_WIDTH, Math.min(BAR_MAX_WIDTH, wanted));
}

/**
 * Column geometry shared by every window row in one card, so bars, percents,
 * and countdowns line up. Drops the clock column, then narrows labels, then
 * drops bars (tier 1) as width runs out.
 * @param {import("./layout.js").LayoutWindow[]} windows
 * @param {{ tier: 1 | 2 | 3, innerWidth: number, now: Date, timeZone: string }} ctx
 * @returns {{ labelWidth: number, barWidth: number, relWidth: number, clockWidth: number }}
 */
export function windowColumns(windows, ctx) {
	const gap = COLUMN_GAP.length;
	const widestLabel = Math.max(1, ...windows.map(w => cellWidth(w.label)));
	const relWidth = Math.max(0, ...windows.map(w => cellWidth(formatReset(w.resetsAt, ctx.now, "relative", ctx.timeZone))));
	const clockWidth = Math.max(0, ...windows.map(w => cellWidth(formatReset(w.resetsAt, ctx.now, "clock", ctx.timeZone))));
	const relCost = relWidth ? gap + relWidth : 0;
	const clockCost = clockWidth ? gap + clockWidth : 0;
	let labelWidth = Math.min(LABEL_MAX_WIDTH, widestLabel);
	const room = (label, clock) => ctx.innerWidth - label - gap - gap - PERCENT_WIDTH - relCost - (clock ? clockCost : 0);
	if (ctx.tier === 1) {
		return { labelWidth: Math.min(labelWidth, Math.max(1, room(0, false) + gap)), barWidth: 0, relWidth, clockWidth: 0 };
	}
	if (ctx.tier === 3 && clockWidth && room(labelWidth, true) >= BAR_MIN_WIDTH) {
		return { labelWidth, barWidth: Math.min(BAR_MAX_WIDTH, room(labelWidth, true)), relWidth, clockWidth };
	}
	if (room(labelWidth, false) < BAR_MIN_WIDTH) {
		labelWidth = Math.max(Math.min(LABEL_MIN_WIDTH, labelWidth), ctx.innerWidth - gap - gap - PERCENT_WIDTH - relCost - BAR_MIN_WIDTH);
	}
	const barWidth = room(labelWidth, false);
	if (barWidth < BAR_MIN_WIDTH) {
		return { labelWidth: Math.min(labelWidth, Math.max(1, room(0, false) + gap)), barWidth: 0, relWidth, clockWidth: 0 };
	}
	return { labelWidth, barWidth: Math.min(BAR_MAX_WIDTH, barWidth), relWidth, clockWidth: 0 };
}

/**
 * One quota window row for a card body.
 *  full:    "Weekly    ━━━━━━━━╸──────────   54%  2d 7h  Fri 09:07"
 *  no clock "Weekly    ━━━━━━━━╸──────────   54%  2d 7h"
 *  no bar:  "Weekly   54%  2d 7h"
 * The percent is never displaced; the countdown is truncated before it.
 * @param {import("./layout.js").LayoutWindow} window
 * @param {{ tier: 1 | 2 | 3, innerWidth: number, labelWidth?: number, barWidth?: number,
 *   relWidth?: number, clockWidth?: number, now: Date, timeZone: string, color: boolean }} ctx
 * @returns {string}
 */
export function windowLine(window, ctx) {
	const columns = Number.isInteger(ctx.labelWidth) && Number.isInteger(ctx.barWidth)
		? ctx
		: windowColumns([window], ctx);
	const labelWidth = Math.max(1, columns.labelWidth);
	const tone = percentTone(window.percentRemaining);
	const low = tone === "bad";
	const segments = [seg(padEnd(truncate(window.label, labelWidth), labelWidth), low ? "bad" : undefined)];
	if (columns.barWidth > 0) {
		const { fill, track } = barParts(window.percentRemaining, columns.barWidth);
		segments.push(seg(COLUMN_GAP), seg(fill, tone === "none" ? "dim" : tone), seg(track, "dim"));
	}
	const pct = padLeft(formatPercent(window.percentRemaining), PERCENT_WIDTH);
	segments.push(seg(COLUMN_GAP), seg(pct, tone === "none" ? "dim" : `${tone}-bold`));
	const rel = formatReset(window.resetsAt, ctx.now, "relative", ctx.timeZone);
	if (columns.relWidth > 0) segments.push(seg(COLUMN_GAP), seg(padLeft(rel, columns.relWidth)));
	if (columns.clockWidth > 0) {
		const clock = formatReset(window.resetsAt, ctx.now, "clock", ctx.timeZone);
		if (clock) segments.push(seg(COLUMN_GAP), seg(clock, "dim"));
	}
	while (segments.length && !segments[segments.length - 1].text.trim()) segments.pop();
	return composeLine(segments, ctx.innerWidth, ctx.color);
}

/**
 * Display value for an extra: ISO instants become "Oct 22", others pass through.
 * @param {string} value
 * @param {Date} now - reserved for relative formats; dates use Pacific time
 * @param {string} [timeZone=DEFAULT_TIME_ZONE]
 * @returns {string}
 */
export function formatExtraValue(value, now, timeZone = DEFAULT_TIME_ZONE) {
	const text = String(value ?? "").trim();
	if (!ISO_INSTANT_RE.test(text)) return text;
	const date = toDate(text);
	if (!date) return text;
	const p = parts(safeFormatters(timeZone).date, date);
	return `${p.month} ${p.day}`;
}

/**
 * Human-friendly text for one extra: ISO instants become dates, known labels
 * get short phrasing ("1 banked reset", "expires Oct 22", "read-only").
 * @param {{ label: string, value: string }} extra
 * @param {{ now: Date, timeZone: string }} ctx
 * @returns {string}
 */
export function formatExtra(extra, ctx) {
	const label = extra.label.trim();
	const value = formatExtraValue(extra.value, ctx.now, ctx.timeZone);
	const key = label.toLowerCase();
	if (key === "source") return value.toLowerCase();
	if (key === "banked resets") return `${value} banked reset${value === "1" ? "" : "s"}`;
	if (key === "next banked expiry") return `expires ${value}`;
	if (!label) return value;
	return `${key} ${value}`;
}

/**
 * Body lines (no border) for a card.
 * @param {import("./layout.js").Card} card
 * @param {{ tier: 1 | 2 | 3, innerWidth: number, now: Date, timeZone: string, color: boolean,
 *   columns?: ReturnType<typeof windowColumns> }} ctx
 * @returns {string[]}
 */
function bodyLines(card, ctx) {
	const line = (text, style) => composeLine([seg(text, style)], ctx.innerWidth, ctx.color);
	if (card.kind === "provider") {
		return card.status === "error"
			? [composeLine([seg("✕ ", "bad"), seg(card.message?.replace(/^error:\s*/, "") ?? "", "bad")], ctx.innerWidth, ctx.color)]
			: [line(card.message ?? "", "dim")];
	}
	const account = card.account;
	if (account.status === "loading") {
		const spin = SPINNER_FRAMES[Math.floor(ctx.now.getTime() / 100) % SPINNER_FRAMES.length];
		return [line(`${spin} loading…`, "dim")];
	}
	if (account.status === "error") {
		return [composeLine([seg("✕ ", "bad"), seg(account.error ?? "", "bad")], ctx.innerWidth, ctx.color)];
	}
	if (account.windows.length === 0) return [line("no quota windows", "dim")];
	const columns = ctx.columns ?? windowColumns(account.windows, ctx);
	return account.windows.map(window => windowLine(window, { ...ctx, ...columns }));
}

/**
 * Top border with the title inset: "╭─ Codex  work · Plus ──── s***@x.org ─╮".
 * Drops email, then plan, then truncates the label as width runs out.
 * @param {import("./layout.js").Card} card
 * @param {number} width
 * @param {{ showEmail: boolean, color: boolean }} opts
 * @returns {string}
 */
function topBorder(card, width, opts) {
	const border = `border:${card.providerId}`;
	const plain = () => composeLine([seg(`╭${"─".repeat(Math.max(0, width - 2))}╮`, border)], width, opts.color);
	if (width < 8) return plain();
	const account = card.account;
	const plan = account ? distinctPlan(account) : "";
	const email = account?.email ? (opts.showEmail ? account.email : redactEmail(account.email)) : "";
	const build = (withPlan, withEmail) => {
		const left = [seg("╭─ ", border), seg(card.providerName, `title:${card.providerId}`)];
		if (account?.label) left.push(seg("  "), seg(account.label, "bold"));
		if (withPlan && plan) left.push(seg(" · ", "dim"), seg(plan, "dim"));
		left.push(seg(" "));
		const right = withEmail && email ? [seg(" "), seg(email, "dim"), seg(" ─╮", border)] : [seg("─╮", border)];
		return { left, right };
	};
	const measure = list => list.reduce((sum, s) => sum + cellWidth(s.text), 0);
	for (const [withPlan, withEmail] of [[true, true], [true, false], [false, false]]) {
		const { left, right } = build(withPlan, withEmail);
		const fill = width - measure(left) - measure(right);
		if (fill >= 1) return composeLine([...left, seg("─".repeat(fill), border), ...right], width, opts.color);
	}
	// Nothing fits whole: truncate the title and keep the closing corner.
	const { left } = build(false, false);
	const title = composeLine(left, width - 2, opts.color);
	const fill = Math.max(0, width - 2 - cellWidth(title));
	return `${title}${paint(`${"─".repeat(fill)}─╮`, border, opts.color)}`;
}

/**
 * Bottom border, optionally carrying an extras summary: "╰─ ⟲ 1 banked · read-only ──╯".
 * @param {import("./layout.js").Card} card
 * @param {number} width
 * @param {{ showExtras: boolean, color: boolean, now: Date, timeZone: string }} opts
 * @returns {string}
 */
function bottomBorder(card, width, opts) {
	const border = `border:${card.providerId}`;
	const extras = opts.showExtras && card.account?.status === "ok" ? card.account.extras : [];
	const summary = extras.map(extra => formatExtra(extra, opts)).filter(Boolean).join(" · ");
	if (!summary || width < 12) {
		return composeLine([seg(`╰${"─".repeat(Math.max(0, width - 2))}╯`, border)], width, opts.color);
	}
	const text = truncate(summary, width - 7);
	const fill = Math.max(1, width - 5 - cellWidth(text));
	return composeLine([seg("╰─ ", border), seg(text, "dim"), seg(` ${"─".repeat(fill)}╯`, border)], width, opts.color);
}

/**
 * Render one card with a rounded, provider-tinted border. The title lives in
 * the top border and extras in the bottom border, so chrome costs two lines.
 * @param {import("./layout.js").Card} card
 * @param {{ tier: 1 | 2 | 3, width: number, height?: number, showExtras?: boolean,
 *   now?: Date|string|number, timeZone?: string, color?: boolean, showEmail?: boolean,
 *   columns?: ReturnType<typeof windowColumns> }} opts - `columns` shares row geometry across cards
 * @returns {string[]} exactly `height` (default cardHeight) lines
 */
export function renderCard(card, opts) {
	const shared = resolveOptions(opts);
	const tier = opts.tier === 1 || opts.tier === 2 ? opts.tier : 3;
	const showExtras = Boolean(opts.showExtras);
	const width = Math.max(0, Math.floor(Number(opts.width) || 0));
	const height = opts.height == null ? cardHeight(card, tier, showExtras) : Math.max(0, Math.floor(opts.height));
	if (width === 0 || height === 0) return Array.from({ length: height }, () => "");
	const innerWidth = Math.max(0, width - 4);
	const body = bodyLines(card, { ...shared, tier, innerWidth, columns: opts.columns });
	const side = paint("│", `border:${card.providerId}`, shared.color);
	const content = line => (width >= 4 ? `${side} ${fitLine(line, innerWidth)} ${side}` : truncate(`│${line}│`, width));
	const lines = [topBorder(card, width, shared)];
	for (const line of body) lines.push(content(line));
	while (lines.length < height - 1) lines.push(content(""));
	lines.length = Math.max(1, height - 1);
	lines.push(bottomBorder(card, width, { ...shared, showExtras }));
	return lines.slice(0, height);
}

/**
 * Short label for the narrowest tier-0 list ("Weekly" → "wk"); unknown labels truncate to 4.
 * @param {string} label
 * @returns {string}
 */
export function tableLabel(label) {
	const key = String(label ?? "").trim().toLowerCase();
	return TABLE_ABBREVIATIONS.get(key) ?? truncate(label, 4);
}

/**
 * Column widths for the tier-0 list. Shrinks window, account, then provider
 * columns (in steps) until a bar fits; drops the bar when nothing is left.
 * @param {import("./layout.js").Card[]} cards
 * @param {number} cols
 * @param {{ now: Date, timeZone: string }} ctx
 * @returns {{ provider: number, account: number, label: number, bar: number, rel: number }}
 */
function listColumns(cards, cols, ctx) {
	const windows = cards.flatMap(card => (card.account?.status === "ok" ? card.account.windows : []));
	const widest = (values, max) => Math.min(max, Math.max(1, ...values.map(value => cellWidth(value))));
	const w = {
		provider: widest(cards.map(card => card.providerName), 11),
		account: widest(cards.map(card => card.account?.label ?? ""), 14),
		label: widest(windows.map(window => window.label), 14),
		rel: Math.max(0, ...windows.map(window => cellWidth(formatReset(window.resetsAt, ctx.now, "relative", ctx.timeZone)))),
		bar: 0,
	};
	const gap = COLUMN_GAP.length;
	const room = () => cols - (1 + w.provider + gap + w.account + gap + w.label + gap + PERCENT_WIDTH
		+ (w.rel ? gap + w.rel : 0)) - gap;
	const steps = [
		() => { w.label = Math.min(w.label, 8); },
		() => { w.account = Math.min(w.account, 8); },
		() => { w.provider = Math.min(w.provider, 6); },
		() => { w.label = Math.min(w.label, 4); },
		() => { w.account = Math.min(w.account, 5); },
		() => { w.provider = Math.min(w.provider, 3); },
	];
	for (const step of steps) {
		if (room() >= LIST_BAR_MIN_WIDTH) break;
		step();
	}
	w.bar = room() >= LIST_BAR_MIN_WIDTH ? Math.min(LIST_BAR_MAX_WIDTH, room()) : 0;
	// A countdown cut to "4…" says nothing; drop the column instead.
	if (!w.bar && room() + gap < 0) w.rel = 0;
	return w;
}

/**
 * Tier-0 dense list: one aligned line per quota window, grouped by provider and
 * account (names print once per group). Exactly layout.totalHeight lines; an
 * empty snapshot yields one message line.
 * @param {import("./layout.js").Layout} layout
 * @param {object} [opts]
 * @returns {string[]}
 */
export function renderTable(layout, opts = {}) {
	const shared = resolveOptions(opts);
	const cols = Math.max(0, Math.floor(layout.cols));
	if (cols === 0) return [];
	if (layout.cards.length === 0) return [fitLine("No quota data", cols)];
	const w = listColumns(layout.cards, cols, shared);
	const cell = (text, width) => padEnd(truncate(text, width), width);
	const lines = [];
	let previousProvider = null;
	for (const card of layout.cards) {
		const firstOfProvider = card.providerId !== previousProvider;
		previousProvider = card.providerId;
		const lead = first => [
			seg(" "),
			seg(cell(first && firstOfProvider ? card.providerName : "", w.provider), `title:${card.providerId}`),
			seg(COLUMN_GAP),
			seg(cell(first ? card.account?.label ?? "" : "", w.account), "bold"),
			seg(COLUMN_GAP),
		];
		const message = (text, style) => lines.push(composeLine([...lead(true), seg(text, style)], cols, shared.color));
		if (card.kind === "provider") {
			const error = card.status === "error";
			message(error ? `✕ ${card.message?.replace(/^error:\s*/, "") ?? ""}` : card.message ?? "", error ? "bad" : "dim");
			continue;
		}
		const account = card.account;
		if (account.status === "loading") {
			message(`${SPINNER_FRAMES[Math.floor(shared.now.getTime() / 100) % SPINNER_FRAMES.length]} loading…`, "dim");
			continue;
		}
		if (account.status === "error") {
			message(`✕ ${account.error ?? ""}`, "bad");
			continue;
		}
		if (account.windows.length === 0) {
			message("no quota windows", "dim");
			continue;
		}
		account.windows.forEach((window, index) => {
			const tone = percentTone(window.percentRemaining);
			const label = w.label <= 4 ? tableLabel(window.label) : window.label;
			const segments = [...lead(index === 0), seg(cell(label, w.label), tone === "bad" ? "bad" : undefined)];
			if (w.bar > 0) {
				const { fill, track } = barParts(window.percentRemaining, w.bar);
				segments.push(seg(COLUMN_GAP), seg(fill, tone === "none" ? "dim" : tone), seg(track, "dim"));
			}
			segments.push(seg(COLUMN_GAP), seg(padLeft(formatPercent(window.percentRemaining), PERCENT_WIDTH),
				tone === "none" ? "dim" : `${tone}-bold`));
			const rel = formatReset(window.resetsAt, shared.now, "relative", shared.timeZone);
			if (rel && w.rel) segments.push(seg(COLUMN_GAP), seg(padLeft(rel, w.rel)));
			lines.push(composeLine(segments, cols, shared.color));
		});
	}
	return lines;
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
	// Every grid card has the same width, so one column geometry aligns bars,
	// percents, and countdowns across the whole screen.
	const shared = resolveOptions(opts);
	const windows = layout.cards.flatMap(card => (card.account?.status === "ok" ? card.account.windows : []));
	const columns = windows.length
		? windowColumns(windows, { ...shared, tier: layout.tier, innerWidth: Math.max(0, layout.cardWidth - 4) })
		: undefined;
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
					columns,
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
