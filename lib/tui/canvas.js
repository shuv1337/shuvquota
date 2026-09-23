/**
 * Cell canvas for the watch shell. Draw calls write styled cells into a fixed
 * grid; `toLines()` serializes rows to strings with minimal SGR changes.
 * Geometry never depends on colour: with colour off every row is plain text of
 * exactly `cols` cells. Depends only on ./width.js.
 */

import { graphemeWidth, graphemes, sanitize } from "./width.js";

/**
 * @typedef {{ fg?: string, bg?: string, bold?: boolean, dim?: boolean, italic?: boolean }} Style
 * Colours are "#rrggbb" strings.
 * @typedef {{ ch: string, style: Style, wide?: boolean, cont?: boolean }} Cell
 */

/**
 * @param {string} hex
 * @returns {string} "r;g;b"
 */
function rgb(hex) {
	const n = Number.parseInt(hex.slice(1), 16);
	return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

/**
 * Full SGR sequence for a style (always starts from a reset).
 * @param {Style} style
 * @returns {string}
 */
function sgr(style) {
	const codes = ["0"];
	if (style.bold) codes.push("1");
	if (style.dim) codes.push("2");
	if (style.italic) codes.push("3");
	if (style.fg) codes.push(`38;2;${rgb(style.fg)}`);
	if (style.bg) codes.push(`48;2;${rgb(style.bg)}`);
	return `\x1b[${codes.join(";")}m`;
}

export class Canvas {
	/**
	 * @param {number} cols
	 * @param {number} rows
	 * @param {Style} [base] - style of untouched cells (usually the screen background)
	 */
	constructor(cols, rows, base = {}) {
		this.cols = Math.max(0, Math.floor(cols));
		this.rows = Math.max(0, Math.floor(rows));
		this.base = base;
		/** @type {Cell[][]} */
		this.cells = Array.from({ length: this.rows }, () =>
			Array.from({ length: this.cols }, () => ({ ch: " ", style: base })));
	}

	/**
	 * Clear a rectangle to spaces in `style` (typically a background fill).
	 * @param {number} x
	 * @param {number} y
	 * @param {number} w
	 * @param {number} h
	 * @param {Style} style
	 */
	fill(x, y, w, h, style) {
		for (let row = Math.max(0, y); row < Math.min(this.rows, y + h); row++) {
			for (let col = Math.max(0, x); col < Math.min(this.cols, x + w); col++) {
				this.split(row, col);
				this.cells[row][col] = { ch: " ", style };
			}
		}
	}

	/**
	 * Before a cell is overwritten, blank the other half of any wide glyph it
	 * belongs to so no row ever gains or loses a cell.
	 * @param {number} y
	 * @param {number} x
	 */
	split(y, x) {
		const row = this.cells[y];
		if (row[x].wide && x + 1 < this.cols) row[x + 1] = { ch: " ", style: row[x + 1].style };
		if (row[x].cont && x > 0) row[x - 1] = { ch: " ", style: row[x - 1].style };
	}

	/**
	 * Background colour currently under a cell (used to inherit panel fills).
	 * @param {number} x
	 * @param {number} y
	 * @returns {string | undefined}
	 */
	bgAt(x, y) {
		return this.cells[y]?.[x]?.style.bg ?? this.base.bg;
	}

	/**
	 * Write text at (x, y), clipped to `max` cells (default: to the canvas edge).
	 * Text that does not fit ends with "…". Cells without an explicit `bg`
	 * inherit the background already painted there. Returns the next x.
	 * @param {number} x
	 * @param {number} y
	 * @param {unknown} text
	 * @param {Style} [style]
	 * @param {number} [max]
	 * @returns {number}
	 */
	text(x, y, text, style = {}, max = Infinity) {
		if (y < 0 || y >= this.rows || x >= this.cols) return x;
		const limit = Math.min(Number.isFinite(max) ? Math.max(0, Math.floor(max)) : Infinity, this.cols - x);
		const clusters = graphemes(sanitize(text));
		const total = clusters.reduce((sum, cluster) => sum + graphemeWidth(cluster), 0);
		const budget = total > limit ? limit - 1 : limit;
		let col = x;
		for (const cluster of clusters) {
			const width = graphemeWidth(cluster);
			if (width === 0) continue;
			if (col + width - x > budget) break;
			this.put(col, y, cluster, width, style);
			col += width;
		}
		if (total > limit && limit >= 1) {
			this.put(col, y, "…", 1, style);
			col += 1;
		}
		return col;
	}

	/**
	 * @param {number} x
	 * @param {number} y
	 * @param {string} ch
	 * @param {number} width
	 * @param {Style} style
	 */
	put(x, y, ch, width, style) {
		if (y < 0 || y >= this.rows || x < 0 || x + width > this.cols) return;
		const row = this.cells[y];
		const resolved = style.bg ? style : { ...style, bg: this.bgAt(x, y) };
		for (let col = x; col < x + width; col++) this.split(y, col);
		row[x] = { ch, style: resolved, wide: width === 2 };
		if (width === 2) row[x + 1] = { ch: "", style: resolved, cont: true };
	}

	/**
	 * Serialize rows. Each coloured row ends with a reset.
	 * @param {boolean} color
	 * @returns {string[]}
	 */
	toLines(color) {
		return this.cells.map(row => {
			let out = "";
			let current = null;
			for (const cell of row) {
				if (cell.cont) continue;
				if (color) {
					const code = sgr(cell.style);
					if (code !== current) {
						out += code;
						current = code;
					}
				}
				out += cell.ch;
			}
			return color && out ? `${out}\x1b[0m` : out;
		});
	}
}
