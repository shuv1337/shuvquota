import { describe, expect, test } from "bun:test";
import { parseArgs, runCli } from "../lib/cli.js";

describe("v2 command parsing", () => {
	test("defaults to one-shot quota and accepts provider shorthand", () => {
		expect(parseArgs([])).toMatchObject({ command: "quota", provider: null });
		expect(parseArgs(["codex", "work", "--json"])).toMatchObject({
			command: "quota", provider: "codex", args: ["work"], options: { json: true },
		});
	});
	test.each(["watch", "tui", "-w"])("recognizes live alias %s", alias => {
		expect(parseArgs([alias]).command).toBe("watch");
	});
	test("retains removed words in account-label positions", () => {
		expect(parseArgs(["codex", "remove", "factory"]).args).toEqual(["factory"]);
		expect(parseArgs(["quota", "synthetic"]).args).toEqual(["synthetic"]);
	});
	test("keeps the label supplied to the watch flag", () => {
		expect(parseArgs(["codex", "-w", "work"])).toMatchObject({
			command: "watch", provider: "codex", args: ["work"],
		});
		expect(parseArgs(["-w", "factory"]).args).toEqual(["factory"]);
		expect(parseArgs(["codex", "-w", "synthetic"]).args).toEqual(["synthetic"]);
	});
	test.each(["switch", "sync", "set-plan", "factory", "synthetic", "opencode-go", "proxx"])(
		"rejects removed command %s with v1 exit code", command => {
			for (const args of [[command], ["codex", command]]) {
				try { parseArgs(args); throw new Error("accepted removed command"); }
				catch (error) { expect(error.exitCode).toBe(2); expect(error.message).toContain("npx shuvquota@1"); }
			}
		},
	);
	test.each(["--local", "--native", "--no-factory", "--billing-day", "--oauth", "--manual",
		"--dry-run", "--no-browser", "--base-url", "--token"])("rejects removed flag %s", flag => {
		try { parseArgs([flag]); throw new Error("accepted removed flag"); }
		catch (error) { expect(error.exitCode).toBe(2); }
	});
	test("validates interval rather than silently accepting malformed input", () => {
		for (const value of ["", "14", "NaN", "Infinity", "nope"]) {
			expect(() => parseArgs(["--interval", value])).toThrow();
		}
		expect(parseArgs(["watch", "--interval=15"]).options.interval).toBe(15);
		expect(() => parseArgs(["--interval"])).toThrow();
	});
	test("rejects missing CRUD operands and unknown flags", () => {
		expect(() => parseArgs(["claude", "rename", "work"])).toThrow();
		expect(() => parseArgs(["grok", "reauth"])).toThrow();
		expect(() => parseArgs(["--wat"])).toThrow();
	});
});

describe("v2 command execution", () => {
	const snapshot = { schemaVersion: 2, complete: true, generatedAt: "2026-09-18T20:00:00Z",
		providers: [{ id: "codex", name: "Codex", accounts: [{ label: "work", email: "alice@example.test",
			plan: "Pro", status: "ok", windows: [{ id: "5h", label: "5h", percentRemaining: 64,
				resetsAt: null }] }] }] };
	function fixture() {
		let text = ""; let errors = ""; let calls = 0;
		return { deps: { providers: [{ id: "codex", name: "Codex" }],
			output: { columns: 80, isTTY: false, write(value) { text += value; } },
			errorOutput: { write(value) { errors += value; } },
			async loadSnapshot() { calls++; return snapshot; } },
			text: () => text, errors: () => errors, calls: () => calls };
	}
	test("JSON and static output share the v2 window contract and redact by default", async () => {
		const json = fixture(); await runCli(["--json"], json.deps);
		expect(JSON.parse(json.text()).schemaVersion).toBe(2);
		expect(JSON.parse(json.text()).providers[0].accounts[0].windows[0].percentRemaining).toBe(64);
		expect(json.text()).not.toContain("alice@example.test");
		const terminal = fixture(); await runCli([], terminal.deps);
		expect(terminal.text()).toContain("64%");
		expect(terminal.text()).not.toContain("alice@example.test");
	});
	test("show-email explicitly reveals identity", async () => {
		const f = fixture(); await runCli(["--json", "--show-email"], f.deps);
		expect(f.text()).toContain("alice@example.test");
	});
	test("non-TTY watch falls back once with stderr hint", async () => {
		const f = fixture(); f.deps.runWatch = async () => false;
		await runCli(["watch"], f.deps);
		expect(f.calls()).toBe(1);
		expect(f.errors()).toContain("showing quota once");
		expect(f.text()).toContain("64%");
	});
	test("once bypasses alternate screen even with watch command", async () => {
		const f = fixture(); f.deps.runWatch = async () => { throw new Error("must not start"); };
		await runCli(["watch", "--once"], f.deps);
		expect(f.calls()).toBe(1);
		expect(f.errors()).toBe("");
	});
});
