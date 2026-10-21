/**
 * Full-screen watch shell: top bar with provider tabs, account sidebar,
 * selected-account detail pane, status bar, help modal, and the account
 * management panel. Pure: input is a display snapshot plus view state; output
 * is exactly `rows` lines of exactly `cols` cells. Depends on ./canvas.js,
 * ./layout.js, ./render.js, ./width.js.
 */

import { Canvas } from "./canvas.js";
import { buildCards, normalizeSnapshot } from "./layout.js";
import {
	SPINNER_FRAMES,
	formatExtraValue,
	formatPercent,
	formatReset,
	percentTone,
	redactEmail,
} from "./render.js";
import { cellWidth } from "./width.js";

/** Night Owl truecolor theme, matching shuvcode's `nightowl` palette. */
export const THEME = Object.freeze({
	bg: "#011627",
	panel: "#01111d",
	chrome: "#0b253a",
	selection: "#1d3b53",
	border: "#1d3b53",
	track: "#0e2a40",
	fg: "#d6deeb",
	muted: "#89a4bb",
	faint: "#5f7e97",
	ink: "#011627",
	good: "#c5e478",
	warn: "#ecc48d",
	bad: "#ef5350",
	badBg: "#2d1b1b",
	info: "#82aaff",
	brand: "#ecc48d",
});
const ACCENTS = Object.freeze({
	codex: "#82aaff",
	claude: "#f78c6c",
	grok: "#d6deeb",
	cursor: "#ffffff",
	antigravity: "#7fdbca",
});
/** Provider tabs, in key order 1–6. */
export const TABS = Object.freeze([
	{ id: null, name: "All" },
	{ id: "codex", name: "Codex" },
	{ id: "claude", name: "Claude" },
	{ id: "grok", name: "Grok" },
	{ id: "antigravity", name: "Antigravity" },
	{ id: "cursor", name: "Cursor" },
]);
/** Below this width only the account list is shown, full width. */
export const SIDEBAR_MIN_COLS = 72;
const HELP = [
	["↑ ↓  j k", "select account"],
	["1 – 6", "filter by provider"],
	["u", "show or hide upcoming resets"],
	["m", "manage accounts"],
	["r", "refresh now"],
	["e", "show or mask email"],
	["+ −", "refresh interval ±15s"],
	["?", "close help"],
	["q", "quit"],
];
const CLOCK = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
	second: "2-digit", timeZoneName: "short",
});

/**
 * @param {string | undefined} providerId
 * @returns {string}
 */
function accent(providerId) {
	return ACCENTS[providerId] ?? THEME.info;
}

/**
 * @param {"good" | "warn" | "bad" | "none"} tone
 * @returns {string}
 */
function toneColor(tone) {
	// Healthy quota stays neutral; only warn/bad draw the eye.
	return tone === "none" ? THEME.faint : tone === "good" ? THEME.fg : THEME[tone];
}

/**
 * @param {number} now
 * @returns {string}
 */
function spinner(now) {
	return SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length];
}

/**
 * Compact duration: "45s", "3m", "2m 58s".
 * @param {number} seconds
 * @returns {string}
 */
export function duration(seconds) {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`;
}

/**
 * Lowest remaining percent across an account's windows (null when unknown).
 * @param {import("./layout.js").Card} card
 * @returns {number | null}
 */
function lowestPercent(card) {
	const values = (card.account?.windows ?? [])
		.map(window => window.percentRemaining)
		.filter(value => value != null);
	return values.length ? Math.min(...values) : null;
}

/**
 * Percent that decides an account's list tone. Cursor seats are rotated on
 * API usage (third-party models), so its API window wins when present.
 * @param {import("./layout.js").Card} card
 * @returns {number | null}
 */
function headlinePercent(card) {
	if (card.providerId === "cursor") {
		const api = (card.account?.windows ?? []).find(window => window.id === "api");
		if (api && api.percentRemaining != null) return api.percentRemaining;
	}
	return lowestPercent(card);
}

/**
 * Cards visible under the provider filter, in display order.
 * @param {unknown} snapshot - display snapshot
 * @param {string | null} providerFilter
 * @returns {import("./layout.js").Card[]}
 */
export function visibleCards(snapshot, providerFilter) {
	return buildCards(normalizeSnapshot(snapshot))
		.filter(card => !providerFilter || card.providerId === providerFilter);
}

/**
 * Resolve the selected card, falling back to the same provider, then the first card.
 * @param {import("./layout.js").Card[]} cards
 * @param {string | null} key
 * @returns {number} index, or -1 when there are no cards
 */
export function selectedIndex(cards, key) {
	if (!cards.length) return -1;
	const index = cards.findIndex(card => card.key === key);
	if (index !== -1) return index;
	// A vanished account (or a loading placeholder) keeps the selection on its provider.
	const provider = typeof key === "string" ? key.slice(0, key.indexOf(":")) : null;
	return Math.max(0, cards.findIndex(card => card.providerId === provider));
}

/**
 * Thin bar: a heavy line in a neutral tone over a dim track, half-cell precise.
 * The bar turns red only when quota is nearly gone; the percent carries warnings. Plain mode keeps "━"/"─" glyphs.
 */
function drawBar(canvas, x, y, width, percent, color) {
	if (width <= 0) return;
	const value = percent == null ? 0 : Math.min(100, Math.max(0, percent));
	const halves = Math.round((width * 2 * value) / 100);
	const full = Math.floor(halves / 2);
	const tone = percentTone(percent);
	const fill = tone === "bad" ? THEME.bad : THEME.fg;
	for (let i = 0; i < width; i++) {
		if (i < full) canvas.put(x + i, y, "━", 1, { fg: fill });
		else if (i === full && halves % 2) canvas.put(x + i, y, "╸", 1, { fg: fill });
		else canvas.put(x + i, y, color ? "━" : "─", 1, { fg: THEME.track });
	}
}

/**
 * Right-align `text` so it ends at column `right` (exclusive).
 * @returns {number} start column
 */
function textRight(canvas, right, y, text, style) {
	const x = right - cellWidth(text);
	canvas.text(x, y, text, style);
	return x;
}

/** Rising gauge bars, dim to brand, that stand in for a logo. */
const WORDMARK_BARS = Object.freeze([
	["▂", "#5f6a5e"], ["▄", "#8a8062"], ["▆", "#bba275"], ["█", THEME.brand],
]);

/**
 * "▂▄▆█ shuvquota": a filling quota gauge beside a two-weight name.
 * @returns {number} column after the wordmark
 */
function drawWordmark(canvas, x) {
	for (const [ch, fg] of WORDMARK_BARS) x = canvas.text(x, 0, ch, { fg, bg: THEME.chrome });
	x = canvas.text(x + 1, 0, "shuv", { fg: THEME.fg, bg: THEME.chrome, bold: true });
	return canvas.text(x, 0, "quota", { fg: THEME.brand, bg: THEME.chrome, bold: true });
}

function drawTopBar(canvas, view, now) {
	const { cols } = canvas;
	canvas.fill(0, 0, cols, 1, { bg: THEME.chrome });
	let x = drawWordmark(canvas, 1);
	x = canvas.text(x + 1, 0, "│", { fg: THEME.border, bg: THEME.chrome }) + 1;
	const status = view.loading
		? { text: `${spinner(now)} refreshing `, fg: THEME.info }
		: view.error ? { text: "▲ stale ", fg: THEME.warn } : null;
	const statusWidth = status ? cellWidth(status.text) + 1 : 0;
	const tabs = TABS.map(tab => ({ ...tab, text: ` ${tab.name} ` }));
	const tabsWidth = tabs.reduce((sum, tab) => sum + cellWidth(tab.text) + 1, 0);
	const active = TABS.find(tab => tab.id === view.providerFilter) ?? TABS[0];
	const shown = x + tabsWidth + statusWidth <= cols ? tabs : [{ ...active, text: ` ${active.name} ` }];
	for (const tab of shown) {
		const isActive = tab.id === view.providerFilter;
		x = canvas.text(x, 0, tab.text, isActive
			? { fg: THEME.fg, bg: THEME.selection, bold: true }
			: { fg: THEME.muted, bg: THEME.chrome });
		x += 1;
	}
	if (status && x + statusWidth <= cols) textRight(canvas, cols, 0, status.text, { fg: status.fg, bg: THEME.chrome });
}

function drawStatusBar(canvas, view, cards, now) {
	const { cols } = canvas;
	const y = canvas.rows - 1;
	canvas.fill(0, y, cols, 1, { bg: THEME.chrome });
	const pill = view.loading ? { text: ` ${spinner(now)} SYNC `, fg: THEME.info }
		: view.error ? { text: " ▲ STALE ", fg: THEME.warn }
			: { text: " ● LIVE ", fg: THEME.good };
	const help = " ? help ";
	const helpX = cols - cellWidth(help);
	let x = canvas.text(0, y, pill.text, { fg: pill.fg, bg: THEME.chrome, bold: true });
	const accounts = cards.filter(card => card.kind === "account");
	const low = accounts.filter(card => card.account.status === "ok"
		&& card.account.windows.some(window => percentTone(window.percentRemaining) === "bad")).length;
	const errors = cards.filter(card => card.status === "error").length;
	const segments = [];
	if (view.error) segments.push({ text: view.error, fg: THEME.warn });
	else if (view.lastUpdatedAt) segments.push({ text: `updated ${CLOCK.format(new Date(view.lastUpdatedAt))}`, fg: THEME.fg });
	if (!view.loading && view.nextRefreshAt !== null) {
		segments.push({ text: `next ${duration(Math.max(0, Math.ceil((view.nextRefreshAt - now) / 1000)))}`, fg: THEME.muted });
	}
	segments.push({ text: `${accounts.length} account${accounts.length === 1 ? "" : "s"}`, fg: THEME.muted });
	if (low) segments.push({ text: `${low} low`, fg: THEME.bad });
	if (errors) segments.push({ text: `${errors} error${errors === 1 ? "" : "s"}`, fg: THEME.bad });
	segments.push({ text: `every ${duration(view.interval)}`, fg: THEME.faint });
	for (const segment of segments) {
		const text = `${x > cellWidth(pill.text) ? " │ " : "  "}${segment.text}`;
		if (x + cellWidth(text) > helpX - 1) break;
		const sep = x > cellWidth(pill.text) ? " │ " : "  ";
		x = canvas.text(x, y, sep, { fg: THEME.border, bg: THEME.chrome });
		x = canvas.text(x, y, segment.text, { fg: segment.fg, bg: THEME.chrome });
	}
	if (helpX > x) canvas.text(canvas.text(helpX, y, " ?", { fg: THEME.fg, bg: THEME.chrome, bold: true }), y, " help ", { fg: THEME.muted, bg: THEME.chrome });
}

/**
 * Sidebar rows (group headers, accounts, spacers) for scrolling.
 * @param {import("./layout.js").Card[]} cards
 */
function sidebarRows(cards) {
	const rows = [];
	let provider = null;
	cards.forEach((card, index) => {
		if (card.providerId !== provider) {
			if (provider !== null) rows.push({ kind: "pad", card: cards[index - 1] }, { kind: "gap" });
			rows.push({ kind: "group", card });
			provider = card.providerId;
		}
		rows.push({ kind: "item", card, index });
	});
	if (cards.length) rows.push({ kind: "pad", card: cards[cards.length - 1] });
	return rows;
}

/**
 * Percentages summarizing an account in the list. Claude shows total weekly
 * plus model-specific weekly limits (e.g. Fable); Cursor shows API usage;
 * others show the lowest window.
 * @param {import("./layout.js").Card} card
 * @returns {Array<{ label: string, percent: number | null }>}
 */
export function summaryPercents(card) {
	const windows = card.account?.windows ?? [];
	if (card.providerId === "claude") {
		const total = windows.find(window => window.id === "weekly");
		const scoped = windows
			.filter(window => window.id.endsWith("-weekly") && window.percentRemaining != null)
			.slice(0, 2)
			.map(window => ({ label: window.label.replace(/\s*weekly$/i, "").toLowerCase(), percent: window.percentRemaining }));
		if (total || scoped.length) {
			return [...(total ? [{ label: "", percent: total.percentRemaining }] : []), ...scoped];
		}
	}
	return [{ label: "", percent: headlinePercent(card) }];
}

/**
 * Account list. Beside the detail pane it is a selectable sidebar; on narrow
 * terminals it is a full-width read-only `overview`, or a `stacked` selectable
 * list ending at `bottom` with the detail pane beneath it.
 * @param {{ mode?: "sidebar" | "overview" | "stacked", bottom?: number }} [options]
 */
function drawSidebar(canvas, view, cards, selected, width, now, { mode = "sidebar", bottom = canvas.rows - 1 } = {}) {
	const top = 1;
	const full = mode !== "sidebar";
	canvas.fill(0, top, width, bottom - top, { bg: full ? THEME.bg : THEME.panel });
	if (!full) for (let y = top; y < bottom; y++) canvas.put(width, y, "│", 1, { fg: THEME.border, bg: THEME.panel });
	canvas.text(2, top + 1, "ACCOUNTS", { fg: THEME.muted, bold: true });
	textRight(canvas, width - 3, top + 1, String(cards.filter(card => card.kind === "account").length), { fg: THEME.faint });
	const listTop = top + 3;
	const blockWidth = Math.max(0, width - 2);
	const hints = mode === "sidebar" && bottom - listTop >= 8;
	const listBottom = hints ? bottom - 2 : bottom;
	const rows = sidebarRows(cards);
	const visible = Math.max(0, listBottom - listTop);
	const selectedRow = rows.findIndex(row => row.kind === "item" && row.index === selected);
	const offset = Math.max(0, Math.min(rows.length - visible, selectedRow - Math.floor(visible / 2)));
	rows.slice(offset, offset + visible).forEach((row, i) => {
		const y = listTop + i;
		const card = row.card;
		if (row.kind === "gap") return;
		// Each provider is a raised block with an accent bar, like shuvcode's tool blocks.
		const isSelected = row.kind === "item" && mode !== "overview" && row.index === selected;
		const bg = isSelected ? THEME.selection : THEME.chrome;
		canvas.fill(1, y, blockWidth, 1, { bg });
		canvas.put(1, y, "▎", 1, { fg: accent(card.providerId), bg });
		if (row.kind === "pad") return;
		if (row.kind === "group") {
			canvas.text(3, y, card.providerName.toUpperCase(), { fg: THEME.fg, bg, bold: true }, blockWidth - 4);
			return;
		}
		const status = card.status;
		const tone = percentTone(headlinePercent(card));
		const glyph = status === "loading" ? { ch: spinner(now), fg: THEME.info }
			: status === "error" ? { ch: "✕", fg: THEME.bad }
				: card.kind === "provider" ? { ch: "○", fg: THEME.faint }
					: { ch: "●", fg: tone === "good" ? THEME.faint : toneColor(tone) };
		canvas.put(3, y, glyph.ch, 1, { fg: glyph.fg, bg });
		const label = card.account?.label || (status === "loading" ? "loading…"
			: card.status === "error" ? "unavailable" : "no accounts");
		let right = blockWidth - 1;
		if (card.kind === "account" && status === "ok") {
			// The headline percent keeps the right-aligned column; labelled
			// scoped limits (e.g. "fable 12%") sit to its left.
			const [head, ...scoped] = summaryPercents(card);
			right = textRight(canvas, right, y, formatPercent(head.percent).padStart(4), { fg: toneColor(percentTone(head.percent)), bg, bold: isSelected }) - 2;
			for (const entry of scoped) {
				right = textRight(canvas, right, y, formatPercent(entry.percent), { fg: toneColor(percentTone(entry.percent)), bg });
				right = textRight(canvas, right - 1, y, entry.label, { fg: THEME.faint, bg }) - 2;
			}
		}
		canvas.text(5, y, label, { fg: isSelected ? THEME.fg : THEME.muted, bg, bold: isSelected }, Math.max(0, right - 5 - 1));
	});
	if (hints) {
		canvas.text(2, bottom - 1, "↑↓", { fg: THEME.info, bold: true });
		canvas.text(5, bottom - 1, "select", { fg: THEME.faint });
		canvas.text(13, bottom - 1, "u", { fg: THEME.info, bold: true }, width - 14);
		canvas.text(15, bottom - 1, view.showUpNext ? "hide resets" : "resets", { fg: THEME.faint }, width - 16);
	}
}

/**
 * Pick lines per window so every window fits the pane: 4 (spacious), 3, 2, or 1.
 * @param {number} count
 * @param {number} height
 * @returns {1 | 2 | 3 | 4}
 */
function windowRows(count, height) {
	for (const rows of [4, 3, 2]) if (count * rows <= height) return rows;
	return 1;
}

/** Rows needed before the optional "Up next" section is drawn. */
const UP_NEXT_MIN_ROWS = 6;

/**
 * Upcoming resets across the visible accounts, soonest first.
 * @param {import("./layout.js").Card[]} cards
 * @param {number} now
 */
function upcomingResets(cards, now) {
	const items = [];
	for (const card of cards) {
		if (card.account?.status !== "ok") continue;
		for (const window of card.account.windows) {
			const at = Date.parse(window.resetsAt ?? "");
			if (Number.isFinite(at) && at > now) items.push({ card, window, at });
		}
	}
	return items.sort((a, b) => a.at - b.at);
}

function drawUpNext(canvas, cards, selectedCard, cx, cw, top, bottom, now) {
	canvas.text(cx, top, "UP NEXT", { fg: THEME.faint, bold: true });
	const items = upcomingResets(cards, now);
	const date = new Date(now);
	const whoWidth = Math.min(28, Math.max(0, ...items.map(item =>
		cellWidth(`${item.card.providerName} ${item.card.account.label}`))));
	items.slice(0, Math.max(0, bottom - top - 2)).forEach((item, i) => {
		const y = top + 2 + i;
		const mine = item.card === selectedCard;
		const tone = percentTone(item.window.percentRemaining);
		canvas.text(cx, y, mine ? "▸" : " ", { fg: accent(item.card.providerId), bold: true });
		canvas.text(cx + 2, y, formatReset(item.window.resetsAt, date, "relative").padStart(6), { fg: THEME.info, bold: true });
		let x = cx + 11;
		const end = x + whoWidth;
		x = canvas.text(x, y, item.card.providerName, { fg: accent(item.card.providerId) }, end - x);
		canvas.text(x + 1, y, item.card.account.label, { fg: mine ? THEME.fg : THEME.muted, bold: mine }, end - x - 1);
		const pctX = cx + cw - 4;
		canvas.text(end + 3, y, item.window.label, { fg: THEME.fg }, pctX - end - 5);
		canvas.text(pctX, y, formatPercent(item.window.percentRemaining).padStart(4), { fg: toneColor(tone) });
	});
}

/**
 * Watch-mode keys that resolve an empty or auth-failed card, if any apply.
 * Owned accounts named in the error are reauthenticated; otherwise the panel opens.
 * @param {import("./layout.js").Card} card
 * @returns {{ lead: string, command: string } | null}
 */
export function actionHint(card) {
	if (card.providerId === "cursor") return null;
	if (card.status === "empty") return { lead: "Add one with", command: "m  a" };
	const error = card.account?.error ?? "";
	if (card.kind === "account" && card.status === "error" && /auth|401|403|expired|enroll|token|login/i.test(error)) {
		return /reauth/.test(error)
			? { lead: "Sign in again with", command: "m  r" }
			: { lead: "Manage sign-ins with", command: "m" };
	}
	return null;
}

/**
 * Small-caps section heading.
 */
function heading(canvas, x, y, text) {
	canvas.text(x, y, text, { fg: THEME.faint, bold: true });
}

function drawDetail(canvas, view, cards, selected, x0, now, top = 1) {
	const bottom = canvas.rows - 1;
	const width = canvas.cols - x0;
	canvas.fill(x0, top, width, bottom - top, { bg: THEME.bg });
	const pad = width >= 40 ? 3 : 1;
	const cx = x0 + pad;
	const cw = width - pad * 2;
	if (cw <= 0) return;
	const card = cards[selected];
	if (!card) {
		const message = view.loading ? `${spinner(now)} scanning accounts…` : "No accounts";
		canvas.text(x0 + Math.max(0, Math.floor((width - cellWidth(message)) / 2)), top + Math.floor((bottom - top) / 2), message, { fg: THEME.muted });
		return;
	}
	const account = card.account;
	const date = new Date(now);
	let y = top + 1;
	// Header: provider and account; plan in small caps beneath; email right.
	let x = canvas.text(cx, y, card.providerName, { fg: accent(card.providerId), bold: true }, cw);
	if (account?.label) x = canvas.text(x + 2, y, account.label, { fg: THEME.fg, bold: true }, cx + cw - x - 2);
	const position = view.sidebar || view.stacked ? "" : `‹ ${selected + 1}/${cards.length} ›`;
	const email = account?.email ? (view.showEmail ? account.email : redactEmail(account.email)) : "";
	const right = [email, position].filter(Boolean).join("  ");
	if (right && x + cellWidth(right) + 2 <= cx + cw) textRight(canvas, cx + cw, y, right, { fg: THEME.muted });
	const plan = account?.plan && !account.label.toLowerCase().replace(/\s+/g, "")
		.includes(account.plan.toLowerCase().replace(/\s+/g, "")) ? account.plan : "";
	if (plan) {
		canvas.text(cx, y + 1, plan.toUpperCase(), { fg: THEME.faint, bold: true }, cw);
		y += 1;
	}
	y += 2;
	for (let i = 0; i < cw; i++) canvas.put(cx + i, y, "─", 1, { fg: THEME.selection });
	y += 2;

	if (card.kind === "provider" || account.status !== "ok" || account.windows.length === 0) {
		const error = card.status === "error";
		const text = card.kind === "provider" ? card.message?.replace(/^error:\s*/, "") ?? ""
			: account.status === "loading" ? `${spinner(now)} loading quota…`
				: account.status === "error" ? account.error ?? "unknown error" : "no quota windows";
		if (error) {
			canvas.fill(cx, y, cw, 3, { bg: THEME.badBg });
			for (let row = 0; row < 3; row++) canvas.put(cx, y + row, "▌", 1, { fg: THEME.bad, bg: THEME.badBg });
			canvas.text(cx + 3, y + 1, `✕  ${text}`, { fg: THEME.bad, bold: true }, cw - 4);
		} else {
			canvas.text(cx, y, text, { fg: THEME.muted }, cw);
		}
		const hint = actionHint(card);
		if (hint) {
			const hy = y + (error ? 4 : 2);
			const hx = canvas.text(cx, hy, hint.lead, { fg: THEME.muted }, cw);
			canvas.text(hx + 1, hy, ` ${hint.command} `, { fg: THEME.fg, bg: THEME.chrome, bold: true }, cx + cw - hx - 1);
		}
		return;
	}

	const extras = account.extras;
	const detailsRows = extras.length ? extras.length + 4 : 0;
	heading(canvas, cx, y, "LIMITS");
	y += 2;
	const available = bottom - y;
	const perWindow = windowRows(account.windows.length, available - detailsRows);
	for (const window of account.windows) {
		if (y >= bottom) break;
		const tone = percentTone(window.percentRemaining);
		const low = tone === "warn" || tone === "bad";
		const pct = formatPercent(window.percentRemaining);
		const rel = formatReset(window.resetsAt, date, "relative");
		const clock = formatReset(window.resetsAt, date, "clock");
		const labelStyle = { fg: tone === "bad" ? THEME.bad : THEME.fg };
		const pctStyle = { fg: low ? THEME[tone] : THEME.fg, bold: low };
		if (perWindow === 1) {
			const labelWidth = Math.min(16, Math.max(...account.windows.map(w => cellWidth(w.label))));
			const tail = rel ? `  ${rel.padStart(6)}` : "";
			canvas.text(cx, y, window.label, labelStyle, labelWidth);
			const pctX = cx + cw - cellWidth(tail) - 4;
			canvas.text(pctX, y, pct.padStart(4), pctStyle);
			if (tail) canvas.text(pctX + 4, y, tail, { fg: THEME.muted });
			drawBar(canvas, cx + labelWidth + 2, y, pctX - 2 - (cx + labelWidth + 2), window.percentRemaining, view.color);
			y += 1;
			continue;
		}
		canvas.text(cx, y, window.label, labelStyle, cw - 8);
		const pctX = textRight(canvas, cx + cw, y, pct, pctStyle);
		if (perWindow === 2 && rel) {
			const resetText = `Resets in ${rel}`;
			if (cx + cellWidth(window.label) + 4 + cellWidth(resetText) < pctX) textRight(canvas, pctX - 3, y, resetText, { fg: THEME.faint });
		}
		drawBar(canvas, cx, y + 1, cw, window.percentRemaining, view.color);
		if (perWindow >= 3) {
			const rx = canvas.text(cx, y + 2, rel ? `Resets in ${rel}` : "No reset scheduled", { fg: THEME.muted }, cw);
			if (clock) canvas.text(rx, y + 2, `  ·  ${clock}`, { fg: THEME.faint }, cx + cw - rx);
			if (window.detail) textRight(canvas, cx + cw, y + 2, window.detail, { fg: THEME.faint });
		}
		y += perWindow;
	}
	if (detailsRows && bottom - y >= detailsRows) {
		y += perWindow === 4 ? 1 : 2;
		heading(canvas, cx, y, "DETAILS");
		y += 2;
		for (const extra of extras) {
			canvas.text(cx, y, extra.label || "—", { fg: THEME.muted }, Math.floor(cw / 2));
			textRight(canvas, cx + cw, y, formatExtraValue(extra.value, date), { fg: THEME.fg });
			y += 1;
		}
	}
	if (view.showUpNext && bottom - y >= UP_NEXT_MIN_ROWS) drawUpNext(canvas, cards, card, cx, cw, y + 1, bottom, now);
}

/**
 * Centered rounded modal frame on the chrome background; returns its origin.
 */
function drawBox(canvas, w, h, title) {
	const x = Math.floor((canvas.cols - w) / 2);
	const y = Math.max(1, Math.floor((canvas.rows - h) / 2));
	const border = { fg: THEME.info, bg: THEME.chrome };
	canvas.fill(x, y, w, h, { bg: THEME.chrome });
	canvas.text(x, y, `╭${"─".repeat(w - 2)}╮`, border);
	canvas.text(x, y + h - 1, `╰${"─".repeat(w - 2)}╯`, border);
	for (let row = y + 1; row < y + h - 1; row++) {
		canvas.put(x, row, "│", 1, border);
		canvas.put(x + w - 1, row, "│", 1, border);
	}
	canvas.text(x + 2, y, ` ${title} `, { fg: THEME.fg, bg: THEME.chrome, bold: true }, w - 4);
	return { x, y };
}

function drawHelp(canvas) {
	const keyWidth = Math.max(...HELP.map(([key]) => cellWidth(key)));
	const inner = Math.max(...HELP.map(([, what]) => cellWidth(what))) + keyWidth + 4;
	const w = Math.min(canvas.cols - 2, inner + 6);
	const h = Math.min(canvas.rows - 2, HELP.length + 4);
	if (w < 16 || h < 5) return;
	const { x, y } = drawBox(canvas, w, h, "Keys");
	HELP.slice(0, h - 4).forEach(([key, what], i) => {
		canvas.text(x + 3, y + 2 + i, key, { fg: THEME.info, bold: true });
		canvas.text(x + 3 + keyWidth + 3, y + 2 + i, what, { fg: THEME.fg }, w - keyWidth - 9);
	});
}

const MANAGE_TITLES = { list: "Accounts", form: { add: "Add account", rename: "Rename account" },
	confirm: "Remove account", auth: { add: "Sign in", reauth: "Reauthenticate" } };
const MANAGE_MAX_WIDTH = 76;
const URL_MAX_LINES = 6;

/**
 * One panel line: left-aligned parts, an optional right-aligned part, and an
 * optional full-width background (the list cursor).
 * @typedef {{ parts: Array<[string, object]>, right?: [string, object], bg?: string, cursor?: boolean }} PanelLine
 */

/** @returns {PanelLine} */
const line = (...parts) => ({ parts });
const BLANK = line();

/** Text field contents ending in a cursor, keeping the tail visible. */
function fieldLine(prefix, value, width, focused = true) {
	const room = Math.max(1, width - cellWidth(prefix) - 1);
	let shown = value;
	if (cellWidth(shown) > room) {
		const chars = [...shown];
		while (chars.length && cellWidth(chars.join("")) > room - 1) chars.shift();
		shown = `…${chars.join("")}`;
	}
	return line([prefix, { fg: THEME.muted }], [shown, { fg: THEME.fg, bold: true }],
		...(focused ? [["▌", { fg: THEME.info }]] : []));
}

function manageListLines(manage, showEmail) {
	const lines = [];
	let cursorLine = 0;
	manage.providers.forEach((provider, i) => {
		if (i) lines.push(BLANK);
		lines.push(line([provider.name.toUpperCase(), { fg: accent(provider.id), bold: true }]));
		const rows = manage.rows.filter(row => row.provider === provider.id);
		if (!rows.length) lines.push(line(["  no accounts", { fg: THEME.faint }]));
		for (const row of rows) {
			const selected = manage.rows[manage.cursor] === row;
			if (selected) cursorLine = lines.length;
			const email = row.email ? (showEmail ? row.email : redactEmail(row.email)) : "";
			lines.push({ parts: [[selected ? "› " : "  ", { fg: THEME.info, bold: true }],
				[row.label, { fg: THEME.fg, bold: selected }]],
			right: email ? [email, { fg: THEME.muted }] : undefined,
			bg: selected ? THEME.selection : undefined });
		}
	});
	if (!manage.providers.length) lines.push(line(["No provider here stores its own accounts.", { fg: THEME.muted }]));
	return { lines, cursorLine };
}

function manageBody(manage, width, showEmail, now) {
	if (manage.view === "list") return manageListLines(manage, showEmail);
	const lines = [];
	if (manage.view === "form") {
		const form = manage.form;
		if (form.kind === "add") {
			const provider = manage.providers[form.providerIndex];
			const many = manage.providers.length > 1;
			lines.push(line(["Provider   ", { fg: THEME.muted }], [many ? "‹ " : "", { fg: THEME.info }],
				[provider?.name ?? "", { fg: accent(provider?.id), bold: true }], [many ? " ›" : "", { fg: THEME.info }]));
			lines.push(fieldLine("Label      ", form.input, width));
			lines.push(BLANK);
			lines.push(line(["Your browser opens to sign in to this account.", { fg: THEME.faint }]));
		} else {
			const name = manage.providers.find(item => item.id === form.row.provider)?.name ?? form.row.provider;
			lines.push(line([name, { fg: accent(form.row.provider), bold: true }], ["  ", {}], [form.row.label, { fg: THEME.fg }]));
			lines.push(BLANK);
			lines.push(fieldLine("New label  ", form.input, width));
		}
		if (form.error) lines.push(BLANK, line([`✕ ${form.error}`, { fg: THEME.bad }]));
		return { lines, cursorLine: 0 };
	}
	if (manage.view === "confirm") {
		const { row } = manage.confirm;
		const name = manage.providers.find(item => item.id === row.provider)?.name ?? row.provider;
		lines.push(line(["Remove ", { fg: THEME.fg }], [name, { fg: accent(row.provider), bold: true }],
			["  ", {}], [row.label, { fg: THEME.fg, bold: true }], ["?", { fg: THEME.fg }]));
		lines.push(BLANK);
		lines.push(line(["shuvquota deletes its stored sign-in for this account.", { fg: THEME.muted }]));
		lines.push(line(["Sessions in other apps are not affected.", { fg: THEME.muted }]));
		return { lines, cursorLine: 0 };
	}
	const auth = manage.auth;
	lines.push(line([auth.providerName, { fg: accent(auth.provider), bold: true }], ["  ", {}], [auth.label, { fg: THEME.fg, bold: true }]));
	lines.push(BLANK);
	if (auth.status === "error") {
		lines.push(line([`✕ ${auth.error}`, { fg: THEME.bad, bold: true }]));
		return { lines, cursorLine: 0 };
	}
	const status = auth.status === "exchanging" ? "Finishing sign-in…"
		: auth.prompt !== null ? "Waiting for the code from your browser"
			: auth.url ? auth.message ?? "Waiting for the browser…" : "Starting sign-in…";
	lines.push(line([`${auth.prompt !== null ? "●" : spinner(now)} `, { fg: THEME.info }], [status, { fg: THEME.fg }]));
	if (auth.url) {
		lines.push(BLANK);
		lines.push(line(["If the browser did not open, visit:", { fg: THEME.faint }]));
		const chars = [...auth.url];
		const chunks = [];
		for (let i = 0; i < chars.length; i += width) chunks.push(chars.slice(i, i + width).join(""));
		const shown = chunks.slice(0, URL_MAX_LINES);
		if (chunks.length > URL_MAX_LINES) shown[URL_MAX_LINES - 1] = `${[...shown[URL_MAX_LINES - 1]].slice(0, width - 1).join("")}…`;
		for (const chunk of shown) lines.push(line([chunk, { fg: THEME.info }]));
		if (auth.note) lines.push(line([`✓ ${auth.note}`, { fg: THEME.good }]));
	}
	if (auth.prompt !== null) {
		lines.push(BLANK);
		lines.push(line([auth.prompt, { fg: THEME.fg }]));
		lines.push(fieldLine("› ", auth.input, width));
	}
	return { lines, cursorLine: 0 };
}

function manageKeys(manage) {
	if (manage.view === "list") {
		return manage.rows.length
			? [["a", "add"], ["r", "reauth"], ["n", "rename"], ["d", "remove"], ["esc", "close"]]
			: [["a", "add"], ["esc", "close"]];
	}
	if (manage.view === "form") {
		return manage.form.kind === "add"
			? [["enter", "sign in"], ...(manage.providers.length > 1 ? [["←→", "provider"]] : []), ["esc", "back"]]
			: [["enter", "save"], ["esc", "back"]];
	}
	if (manage.view === "confirm") return [["y", "remove"], ["n", "keep"]];
	if (manage.auth.status === "error") return [["enter", "back"]];
	return [...(manage.auth.prompt !== null ? [["enter", "submit"]] : []),
		...(manage.auth.url ? [["^Y", "copy URL"], ["^O", "open browser"]] : []), ["esc", "cancel"]];
}

/**
 * Account-management panel over the shell. Too-small terminals get a one-line
 * request to enlarge instead of a clipped form.
 */
function drawManage(canvas, view, now) {
	const manage = view.manage;
	const w = Math.min(canvas.cols - 2, MANAGE_MAX_WIDTH);
	const maxH = canvas.rows - 2;
	if (w < 30 || maxH < 7) {
		const y = Math.floor(canvas.rows / 2);
		canvas.fill(0, y, canvas.cols, 1, { bg: THEME.chrome });
		canvas.text(1, y, "Enlarge the terminal to manage accounts", { fg: THEME.warn, bg: THEME.chrome }, canvas.cols - 2);
		return;
	}
	const inner = w - 6;
	const { lines, cursorLine } = manageBody(manage, inner, view.showEmail, now);
	if (manage.view === "list" && manage.notice) {
		lines.push(BLANK, line([manage.notice.text, { fg: manage.notice.tone === "good" ? THEME.good : THEME.bad }]));
	}
	// Border, top pad, body, pad, keys, border.
	const h = Math.min(maxH, lines.length + 5);
	const room = h - 5;
	const offset = Math.max(0, Math.min(cursorLine - Math.floor(room / 2), lines.length - room));
	const title = manage.view === "form" ? MANAGE_TITLES.form[manage.form.kind]
		: manage.view === "auth" ? MANAGE_TITLES.auth[manage.auth.kind] : MANAGE_TITLES[manage.view];
	const { x, y } = drawBox(canvas, w, h, title);
	const cx = x + 3;
	lines.slice(offset, offset + room).forEach((item, i) => {
		const row = y + 2 + i;
		if (item.bg) canvas.fill(x + 1, row, w - 2, 1, { bg: item.bg });
		const rightWidth = item.right ? cellWidth(item.right[0]) + 2 : 0;
		const limit = cx + inner - (rightWidth && rightWidth < inner / 2 ? rightWidth : 0);
		let at = cx;
		for (const [text, style] of item.parts) at = canvas.text(at, row, text, style, limit - at);
		if (item.right && at + rightWidth <= cx + inner) textRight(canvas, cx + inner, row, item.right[0], item.right[1]);
	});
	if (offset > 0) canvas.text(x + w - 3, y + 1, "↑", { fg: THEME.faint });
	if (offset + room < lines.length) canvas.text(x + w - 3, y + h - 3, "↓", { fg: THEME.faint });
	let kx = cx;
	for (const [key, what] of manageKeys(manage)) {
		const width = cellWidth(key) + cellWidth(what) + 3;
		if (kx + width > cx + inner + 1) break;
		kx = canvas.text(kx, y + h - 2, key, { fg: THEME.info, bold: true });
		kx = canvas.text(kx + 1, y + h - 2, what, { fg: THEME.muted }) + 2;
	}
}

/** Rows the stacked detail pane needs before narrow views switch to it. */
const STACKED_DETAIL_MIN_ROWS = 10;

/**
 * Narrow terminals stack the list above the selected account's detail once the
 * view is focused on one provider or one account and there is room for both.
 */
function stacked(view, cards, rows) {
	const accounts = cards.filter(card => card.kind === "account").length;
	return (view.providerFilter !== null || accounts === 1) && rows - 2 - 4 >= STACKED_DETAIL_MIN_ROWS;
}

/**
 * Render the whole watch screen.
 * @param {{ snapshot: unknown, providerFilter: string | null, selected: string | null,
 *   showEmail: boolean, showHelp: boolean, loading: boolean, error: string | null,
 *   lastUpdatedAt: string | null, nextRefreshAt: number | null, interval: number }} view
 * @param {{ cols: number, rows: number }} size
 * @param {{ now: number, color: boolean }} opts
 * @returns {{ lines: string[], cards: import("./layout.js").Card[], selected: number }}
 */
export function renderShell(view, { cols, rows }, { now, color }) {
	const canvas = new Canvas(cols, rows, color ? { fg: THEME.fg, bg: THEME.bg } : {});
	const cards = visibleCards(view.snapshot, view.providerFilter);
	const selected = selectedIndex(cards, view.selected);
	if (rows <= 0 || cols <= 0) return { lines: [], cards, selected };
	const sidebar = cols >= SIDEBAR_MIN_COLS && rows >= 6;
	const ctx = { ...view, sidebar, color };
	drawTopBar(canvas, ctx, now);
	if (rows >= 2) drawStatusBar(canvas, ctx, cards, now);
	if (rows >= 3) {
		if (sidebar) {
			const width = Math.max(28, Math.min(40, Math.round(cols * 0.3)));
			drawSidebar(canvas, ctx, cards, selected, width, now);
			drawDetail(canvas, ctx, cards, selected, width + 1, now);
		} else if (stacked(ctx, cards, rows)) {
			// Header (3) + list rows; the detail pane takes what remains.
			const listBottom = Math.min(1 + 3 + sidebarRows(cards).length, rows - 1 - STACKED_DETAIL_MIN_ROWS);
			drawSidebar(canvas, ctx, cards, selected, cols, now, { mode: "stacked", bottom: listBottom });
			drawDetail(canvas, { ...ctx, stacked: true }, cards, selected, 0, now, listBottom);
		} else {
			drawSidebar(canvas, ctx, cards, selected, cols, now, { mode: "overview" });
		}
		if (view.manage) drawManage(canvas, view, now);
		else if (view.showHelp) drawHelp(canvas);
	}
	return { lines: canvas.toLines(color), cards, selected };
}
