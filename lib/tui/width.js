/**
 * Terminal cell-width helpers for the TUI (plan §3.3 / Phase 4).
 * Zero dependencies, no terminal access. Handles ANSI stripping, control removal,
 * CJK wide characters, combining marks, ZWJ / variation-selector emoji sequences,
 * and `…` truncation that never exceeds the requested width.
 */

/** CSI, OSC, and single-character Fe escape sequences. */
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
/** C0 controls (including tab, LF, CR), DEL, and C1 controls. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * Invisible format characters that can reorder or hide text. ZWJ (U+200D),
 * variation selectors, and emoji tag characters are deliberately kept because
 * emoji sequences depend on them.
 */
const FORMAT_RE = /[\u00ad\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
/** Unpaired UTF-16 surrogate halves (matched on code units, so no `u` flag). */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const COMBINING_RE = /^\p{M}$/u;
const FORMAT_CP_RE = /^\p{Cf}$/u;
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u;
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

/** East Asian Wide / Fullwidth ranges (subset of wcwidth tables). */
const WIDE_RANGES = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f],
	[0x1f900, 0x1f9ff],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
	? new Intl.Segmenter("en", { granularity: "grapheme" })
	: null;

/**
 * Remove ANSI escape sequences.
 * @param {unknown} text
 * @returns {string}
 */
export function stripAnsi(text) {
	return String(text ?? "").replace(ANSI_RE, "");
}

/**
 * Make an untrusted dynamic value safe to embed in a single terminal line:
 * strips ANSI sequences, C0/C1 controls (including newlines and tabs), bidi and
 * other invisible format controls, and unpaired surrogates.
 * @param {unknown} text
 * @returns {string}
 */
export function sanitize(text) {
	return stripAnsi(text)
		.replace(LONE_SURROGATE_RE, "")
		.replace(CONTROL_RE, "")
		.replace(FORMAT_RE, "");
}

/**
 * @param {number} cp
 * @returns {boolean}
 */
function isWide(cp) {
	for (const [start, end] of WIDE_RANGES) {
		if (cp < start) return false;
		if (cp <= end) return true;
	}
	return false;
}

/**
 * Terminal cell width of one code point: 0 (combining/format/control), 1, or 2.
 * @param {number} cp
 * @returns {0 | 1 | 2}
 */
export function codePointWidth(cp) {
	if (!Number.isInteger(cp) || cp <= 0) return 0;
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	const ch = String.fromCodePoint(cp);
	if (COMBINING_RE.test(ch) || FORMAT_CP_RE.test(ch)) return 0;
	if (EMOJI_PRESENTATION_RE.test(ch) || isWide(cp)) return 2;
	return 1;
}

/**
 * Split text into grapheme clusters (falls back to code points without Intl.Segmenter).
 * @param {unknown} text
 * @returns {string[]}
 */
export function graphemes(text) {
	const value = String(text ?? "");
	if (!value) return [];
	if (segmenter) return Array.from(segmenter.segment(value), segment => segment.segment);
	return Array.from(value);
}

/**
 * Cell width of one grapheme cluster. Emoji presentation sequences (VS16) and
 * keycap sequences render as 2 cells; otherwise the widest code point wins so
 * combining marks and ZWJ contribute nothing.
 * @param {string} cluster
 * @returns {number}
 */
export function graphemeWidth(cluster) {
	let width = 0;
	let hasVS16 = false;
	let hasPictographic = false;
	let hasKeycap = false;
	for (const ch of cluster) {
		const cp = ch.codePointAt(0);
		if (cp === 0xfe0f) hasVS16 = true;
		else if (cp === 0x20e3) hasKeycap = true;
		else if (PICTOGRAPHIC_RE.test(ch)) hasPictographic = true;
		width = Math.max(width, codePointWidth(cp));
	}
	if (hasKeycap || (hasVS16 && hasPictographic)) return 2;
	return width;
}

/**
 * Visible terminal cell width of a string (ANSI sequences count as zero).
 * @param {unknown} text
 * @returns {number}
 */
export function cellWidth(text) {
	let total = 0;
	for (const cluster of graphemes(stripAnsi(text))) total += graphemeWidth(cluster);
	return total;
}

/**
 * Truncate to at most `maxWidth` cells, ending with `ellipsis` when shortened.
 * ANSI sequences are stripped first (truncate plain text, colour afterwards).
 * The result never exceeds `maxWidth`; a wide character that does not fit is dropped.
 * @param {unknown} text
 * @param {number} maxWidth
 * @param {string} [ellipsis="…"]
 * @returns {string}
 */
export function truncate(text, maxWidth, ellipsis = "…") {
	const plain = stripAnsi(text);
	const limit = Number.isFinite(maxWidth) ? Math.floor(maxWidth) : Number.POSITIVE_INFINITY;
	if (limit <= 0) return "";
	if (cellWidth(plain) <= limit) return plain;
	const ellipsisWidth = cellWidth(ellipsis);
	if (limit < ellipsisWidth) return "";
	const budget = limit - ellipsisWidth;
	let out = "";
	let used = 0;
	for (const cluster of graphemes(plain)) {
		const width = graphemeWidth(cluster);
		if (used + width > budget) break;
		out += cluster;
		used += width;
	}
	return out + ellipsis;
}

/**
 * Pad on the right to `width` cells (no-op when already at least that wide).
 * @param {unknown} text
 * @param {number} width
 * @param {string} [fill=" "]
 * @returns {string}
 */
export function padEnd(text, width, fill = " ") {
	const value = String(text ?? "");
	const missing = Math.floor(width) - cellWidth(value);
	return missing > 0 ? value + fill.repeat(missing) : value;
}

/**
 * Sanitize, truncate, and pad so the result is exactly `width` cells.
 * @param {unknown} text
 * @param {number} width
 * @returns {string}
 */
export function fit(text, width) {
	return padEnd(truncate(sanitize(text), width), width);
}
