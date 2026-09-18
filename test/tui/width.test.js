/**
 * Cell-width helpers: ANSI/control stripping, CJK, combining marks, ZWJ emoji,
 * bounded truncation. Imports lib/tui/width.js directly (plan §3.3).
 */

import { describe, test, expect } from "bun:test";
import {
	stripAnsi,
	sanitize,
	codePointWidth,
	graphemes,
	graphemeWidth,
	cellWidth,
	truncate,
	padEnd,
	fit,
} from "../../lib/tui/width.js";

describe("stripAnsi", () => {
	test("removes CSI colour and cursor sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
		expect(stripAnsi("\x1b[2J\x1b[H\x1b[?25lx\x1b[?25h")).toBe("x");
	});

	test("removes OSC sequences with BEL and ST terminators", () => {
		expect(stripAnsi("\x1b]0;title\x07body")).toBe("body");
		expect(stripAnsi("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
	});

	test("tolerates non-string input", () => {
		expect(stripAnsi(null)).toBe("");
		expect(stripAnsi(undefined)).toBe("");
		expect(stripAnsi(42)).toBe("42");
	});
});

describe("sanitize", () => {
	test("strips C0/C1 controls, tabs, and newlines", () => {
		expect(sanitize("a\tb\nc\rd\x00e\x7ff\x85g")).toBe("abcdefg");
	});

	test("strips ANSI sequences embedded in dynamic values", () => {
		expect(sanitize("label\x1b[31m\x1b[2J")).toBe("label");
	});

	test("strips bidi overrides and zero-width characters that reorder or hide text", () => {
		expect(sanitize("abc\u202eDEF\u202c")).toBe("abcDEF");
		expect(sanitize("a\u200bb\u200cc\ufeffd")).toBe("abcd");
		expect(sanitize("x\u2066y\u2069z")).toBe("xyz");
	});

	test("keeps ZWJ and variation selectors so emoji sequences survive", () => {
		expect(sanitize("👩‍💻")).toBe("👩‍💻");
		expect(sanitize("☠️")).toBe("☠️");
	});

	test("drops lone surrogates but keeps valid pairs", () => {
		expect(sanitize("a\ud800b")).toBe("ab");
		expect(sanitize("a\udc00b")).toBe("ab");
		expect(sanitize("😀")).toBe("😀");
	});
});

describe("codePointWidth", () => {
	test("ASCII is 1", () => {
		expect(codePointWidth("a".codePointAt(0))).toBe(1);
		expect(codePointWidth(" ".codePointAt(0))).toBe(1);
	});

	test("controls, combining marks, and format characters are 0", () => {
		expect(codePointWidth(0x07)).toBe(0);
		expect(codePointWidth(0x7f)).toBe(0);
		expect(codePointWidth(0x0301)).toBe(0);
		expect(codePointWidth(0x200d)).toBe(0);
		expect(codePointWidth(0xfe0f)).toBe(0);
	});

	test("CJK, Hangul, fullwidth forms, and emoji presentation are 2", () => {
		expect(codePointWidth("日".codePointAt(0))).toBe(2);
		expect(codePointWidth("한".codePointAt(0))).toBe(2);
		expect(codePointWidth("Ａ".codePointAt(0))).toBe(2);
		expect(codePointWidth("😀".codePointAt(0))).toBe(2);
		expect(codePointWidth("𠀀".codePointAt(0))).toBe(2);
	});

	test("invalid input is 0", () => {
		expect(codePointWidth(-1)).toBe(0);
		expect(codePointWidth(NaN)).toBe(0);
		expect(codePointWidth(1.5)).toBe(0);
	});
});

describe("graphemes / graphemeWidth", () => {
	test("ZWJ emoji sequence is a single cluster of width 2", () => {
		const clusters = graphemes("👩‍💻");
		expect(clusters).toEqual(["👩‍💻"]);
		expect(graphemeWidth(clusters[0])).toBe(2);
	});

	test("flag (regional indicator pair) is one cluster of width 2", () => {
		expect(graphemes("🇯🇵")).toHaveLength(1);
		expect(graphemeWidth("🇯🇵")).toBe(2);
	});

	test("text-default pictograph with VS16 becomes width 2; without it stays 1", () => {
		expect(graphemeWidth("☠️")).toBe(2);
		expect(graphemeWidth("☠")).toBe(1);
	});

	test("keycap sequence is width 2", () => {
		expect(graphemeWidth("1️⃣")).toBe(2);
	});

	test("base letter plus combining mark is width 1", () => {
		expect(graphemes("e\u0301")).toEqual(["e\u0301"]);
		expect(graphemeWidth("e\u0301")).toBe(1);
	});

	test("empty input yields no clusters", () => {
		expect(graphemes("")).toEqual([]);
		expect(graphemes(null)).toEqual([]);
	});
});

describe("cellWidth", () => {
	test("plain ASCII counts characters", () => {
		expect(cellWidth("hello")).toBe(5);
		expect(cellWidth("")).toBe(0);
	});

	test("ignores ANSI sequences", () => {
		expect(cellWidth("\x1b[32m64%\x1b[0m")).toBe(3);
	});

	test("CJK is double-width", () => {
		expect(cellWidth("日本語")).toBe(6);
		expect(cellWidth("日本語ラベル")).toBe(12);
	});

	test("combining marks add nothing", () => {
		expect(cellWidth("cafe\u0301")).toBe(4);
		expect(cellWidth("n\u0303")).toBe(1);
	});

	test("ZWJ emoji and text mix", () => {
		expect(cellWidth("main 👩‍💻")).toBe(7);
		expect(cellWidth("a🙂b")).toBe(4);
	});

	test("box-drawing and block glyphs are single-cell", () => {
		expect(cellWidth("╭─╮│╰╯")).toBe(6);
		expect(cellWidth("█░")).toBe(2);
		expect(cellWidth("…·↑↓")).toBe(4);
	});
});

describe("truncate", () => {
	test("returns input unchanged when it fits", () => {
		expect(truncate("abc", 3)).toBe("abc");
		expect(truncate("abc", 10)).toBe("abc");
	});

	test("shortens with an ellipsis and never exceeds the bound", () => {
		expect(truncate("abcdef", 4)).toBe("abc…");
		expect(cellWidth(truncate("abcdef", 4))).toBe(4);
	});

	test("drops a wide character that would straddle the bound", () => {
		const out = truncate("日本語テキスト", 7);
		expect(out).toBe("日本語…");
		expect(cellWidth(out)).toBeLessThanOrEqual(7);
		expect(cellWidth(truncate("日本語テキスト", 6))).toBeLessThanOrEqual(6);
	});

	test("never splits a ZWJ emoji sequence", () => {
		const out = truncate("main 👩‍💻 extra", 7);
		expect(out).toBe("main …");
		expect(cellWidth(out)).toBeLessThanOrEqual(7);
		expect(truncate("main 👩‍💻", 7)).toBe("main 👩‍💻");
	});

	test("width 0 and 1 are handled without throwing", () => {
		expect(truncate("abc", 0)).toBe("");
		expect(truncate("abc", 1)).toBe("…");
		expect(truncate("a", 1)).toBe("a");
		expect(truncate("", 0)).toBe("");
	});

	test("strips ANSI before measuring", () => {
		expect(truncate("\x1b[31mabcdef\x1b[0m", 4)).toBe("abc…");
	});

	test("non-finite width means no truncation", () => {
		expect(truncate("abcdef", Infinity)).toBe("abcdef");
		expect(truncate("abcdef", NaN)).toBe("abcdef");
	});

	test("custom ellipsis", () => {
		expect(truncate("abcdef", 5, "..")).toBe("abc..");
		expect(truncate("abcdef", 5, "")).toBe("abcde");
	});
});

describe("padEnd / fit", () => {
	test("padEnd pads by cells, not code units", () => {
		expect(padEnd("日", 4)).toBe("日  ");
		expect(padEnd("👩‍💻", 3)).toBe("👩‍💻 ");
		expect(padEnd("abc", 2)).toBe("abc");
	});

	test("fit yields exactly the requested width", () => {
		for (const text of ["", "a", "日本語ラベル", "main 👩‍💻", "x\x1b[31my\tz"]) {
			for (const width of [0, 1, 2, 5, 12, 20]) {
				expect(cellWidth(fit(text, width))).toBe(width);
			}
		}
	});

	test("fit sanitizes control characters", () => {
		expect(fit("a\nb\x1b[2J", 3)).toBe("ab ");
	});
});
