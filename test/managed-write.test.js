import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMultiAccountContainer, writeMultiAccountContainer } from "../lib/container.js";
import { writeFileAtomic } from "../lib/fs.js";

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "shuvquota-write-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test("managed writes drop activeLabel, preserve metadata, and set owner-only mode", () => {
	const path = join(home, "accounts.json");
	writeFileSync(path, JSON.stringify({ activeLabel: "work", note: "keep", accounts: [] }));
	writeMultiAccountContainer(path, readMultiAccountContainer(path), [{ label: "work" }]);
	const result = JSON.parse(readFileSync(path, "utf8"));
	expect(result).not.toHaveProperty("activeLabel");
	expect(result.note).toBe("keep");
	expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("managed symlink cannot redirect writes into an external store", () => {
	const external = join(home, "harness.json");
	const path = join(home, "accounts.json");
	writeFileSync(external, '{"accounts":[]}'); symlinkSync(external, path);
	expect(() => writeMultiAccountContainer(path, readMultiAccountContainer(path), [])).toThrow("symbolic");
	expect(readFileSync(external, "utf8")).toBe('{"accounts":[]}');
});

test("malformed stores fail closed rather than being overwritten", () => {
	const path = join(home, "accounts.json"); writeFileSync(path, "{broken");
	expect(() => writeMultiAccountContainer(path, readMultiAccountContainer(path), [])).toThrow("malformed");
	expect(readFileSync(path, "utf8")).toBe("{broken");
});

test("failed atomic writes preserve the original and leave no temporary file", () => {
	const path = join(home, "accounts.json"); writeFileSync(path, "original");
	expect(() => writeFileAtomic(path, Symbol("invalid data"))).toThrow();
	expect(readFileSync(path, "utf8")).toBe("original");
	expect(readdirSync(home)).toEqual(["accounts.json"]);
});
