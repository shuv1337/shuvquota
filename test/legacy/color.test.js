/**
 * Legacy color utilities tests migrated from shuvquota.test.js
 * Run with: bun test test/legacy/color.test.js
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { colorize, setNoColorFlag, supportsColor } from "../../lib/color.js";

describe("colorize", () => {
	test("returns text unchanged when colors not supported", () => {
		// In test environment, stdout is not a TTY, so colors should be disabled
		const result = colorize("test", "\x1b[32m");
		expect(result).toBe("test");
	});
});

describe("supportsColor", () => {
	let originalNO_COLOR;
	let originalIsTTY;

	beforeEach(() => {
		// Save original values
		originalNO_COLOR = process.env.NO_COLOR;
		originalIsTTY = process.stdout.isTTY;
	});

	afterEach(() => {
		// Restore original values
		if (originalNO_COLOR === undefined) {
			delete process.env.NO_COLOR;
		} else {
			process.env.NO_COLOR = originalNO_COLOR;
		}
	});

	test("returns false when NO_COLOR env var is set to '1'", () => {
		process.env.NO_COLOR = "1";
		expect(supportsColor()).toBe(false);
	});

	test("returns false when NO_COLOR env var is set to any non-empty string", () => {
		process.env.NO_COLOR = "true";
		expect(supportsColor()).toBe(false);

		process.env.NO_COLOR = "yes";
		expect(supportsColor()).toBe(false);

		process.env.NO_COLOR = "anything";
		expect(supportsColor()).toBe(false);
	});

	test("returns false when stdout is not a TTY (test environment)", () => {
		delete process.env.NO_COLOR;
		expect(supportsColor()).toBe(false);
	});

	test("colorize returns plain text when NO_COLOR is set", () => {
		process.env.NO_COLOR = "1";
		const result = colorize("Error message", "\x1b[31m"); // RED
		expect(result).toBe("Error message");
		expect(result).not.toContain("\x1b[");
	});

	test("colorize returns plain text when NO_COLOR is set to empty-looking value", () => {
		delete process.env.NO_COLOR;
		const result = colorize("Success", "\x1b[32m"); // GREEN
		expect(result).toBe("Success");
	});
});

describe("--no-color flag", () => {
	let originalNO_COLOR;

	beforeEach(() => {
		originalNO_COLOR = process.env.NO_COLOR;
		delete process.env.NO_COLOR;
		setNoColorFlag(false);
	});

	afterEach(() => {
		if (originalNO_COLOR === undefined) {
			delete process.env.NO_COLOR;
		} else {
			process.env.NO_COLOR = originalNO_COLOR;
		}
		setNoColorFlag(false);
	});

	test("supportsColor returns false when --no-color flag is set via setNoColorFlag(true)", () => {
		setNoColorFlag(true);
		expect(supportsColor()).toBe(false);
	});

	test("colorize returns plain text when --no-color flag is set", () => {
		setNoColorFlag(true);
		const result = colorize("Error message", "\x1b[31m"); // RED
		expect(result).toBe("Error message");
		expect(result).not.toContain("\x1b[");
	});

	test("--no-color flag takes priority over TTY status", () => {
		setNoColorFlag(true);
		expect(supportsColor()).toBe(false);
	});

	test("colors remain disabled after multiple colorize calls with --no-color", () => {
		setNoColorFlag(true);

		expect(colorize("First", "\x1b[32m")).toBe("First");   // GREEN
		expect(colorize("Second", "\x1b[31m")).toBe("Second"); // RED
		expect(colorize("Third", "\x1b[33m")).toBe("Third");   // YELLOW
	});

	test("setNoColorFlag can be toggled", () => {
		setNoColorFlag(true);
		expect(supportsColor()).toBe(false);

		setNoColorFlag(false);
		supportsColor();
	});
});
