import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCodexReset } from "../lib/codex-resets.js";
import { addManagedAccount, getManagedStorePath } from "../lib/credential-store.js";
import { parseArgs, runCli } from "../lib/cli.js";

const row = { label: "work", raw: { enrollment: "independent", access: "fixture-access", accountId: "fixture-account", expires: 9999999999999 } };
const store = { listManagedAccounts: () => [row] };
const opts = { store, requestId: "attempt-1" };

describe("Codex reset consumption", () => {
	test.each(["reset", "nothing_to_reset", "no_credit", "already_redeemed"])("projects %s without raw fields", async code => {
		let calls = 0;
		const result = await useCodexReset("work", { ...opts, fetchFn: async (url, init) => {
			calls++;
			expect(url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
			expect(init.method).toBe("POST");
			expect(init.headers.Authorization).toBe("Bearer fixture-access");
			expect(init.headers["chatgpt-account-id"]).toBe("fixture-account");
			expect(JSON.parse(init.body)).toEqual({ redeem_request_id: "attempt-1" });
			return Response.json({ code, windows_reset: code === "reset" ? 2 : 0, secret: "private" });
		} });
		expect(result).toEqual({ code, windowsReset: code === "reset" ? 2 : 0, requestId: "attempt-1" });
		expect(calls).toBe(1);
	});
	test("forwards the selected credit and stable retry ID", async () => {
		const bodies = [];
		const fetchFn = async (_, init) => {
			bodies.push(JSON.parse(init.body));
			return Response.json({ code: "already_redeemed", windows_reset: 0 });
		};
		await useCodexReset("work", { ...opts, creditId: "credit-1", fetchFn });
		await useCodexReset("work", { ...opts, creditId: "credit-1", fetchFn });
		expect(bodies).toEqual(Array(2).fill({ redeem_request_id: "attempt-1", credit_id: "credit-1" }));
	});
	test("rejects missing, external, duplicate, expired and unidentified accounts before HTTP", async () => {
		for (const rows of [[], [{ ...row, label: "other" }], [{ ...row, raw: { ...row.raw, enrollment: undefined } }],
			[row, row], [{ ...row, raw: { ...row.raw, expires: 1 } }],
			[{ ...row, raw: { ...row.raw, accountId: null } }], [{ ...row, raw: { ...row.raw, access: null } }]]) {
			let calls = 0;
			await expect(useCodexReset("work", { ...opts, store: { listManagedAccounts: () => rows },
				fetchFn: async () => { calls++; throw new Error("must not fetch"); } })).rejects.toThrow();
			expect(calls).toBe(0);
		}
	});
	test("uncertain HTTP, network and malformed responses never retry or leak payloads", async () => {
		for (const fetchFn of [async () => new Response("secret", { status: 500 }),
			async () => { throw new Error("fixture-access"); }, async () => new Response("invalid JSON"),
			async () => Response.json({ code: "surprise", windows_reset: 1 }),
			async () => Response.json({ code: "reset", windows_reset: -1 })]) {
			let calls = 0;
			try {
				await useCodexReset("work", { ...opts, fetchFn: (...args) => { calls++; return fetchFn(...args); } });
				throw new Error("unexpected success");
			} catch (error) {
				expect(error.message).toContain("uncertain");
				expect(error.message).toContain("--request-id attempt-1");
				expect(error.message).not.toContain("fixture-access");
			}
			expect(calls).toBe(1);
		}
	});
	test("aborts a timed-out request", async () => {
		await expect(useCodexReset("work", { ...opts, timeoutMs: 1,
			fetchFn: (_, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
		})).rejects.toThrow("uncertain");
	});
	test("leaves the owned credential file unchanged", async () => {
		const home = mkdtempSync(join(tmpdir(), "codex-reset-test-"));
		try {
			addManagedAccount("codex", { label: "work", ...row.raw }, { home });
			const path = getManagedStorePath("codex", { home });
			const before = readFileSync(path, "utf8");
			await useCodexReset("work", { home, requestId: "attempt-1",
				fetchFn: async () => Response.json({ code: "reset", windows_reset: 2 }) });
			expect(readFileSync(path, "utf8")).toBe(before);
		} finally { rmSync(home, { recursive: true, force: true }); }
	});
});

describe("reset CLI", () => {
	test("requires an explicit Codex label and scopes reset flags", () => {
		expect(parseArgs(["codex", "reset", "work", "--credit-id=c1", "--request-id", "r1"]))
			.toMatchObject({ command: "reset", args: ["work"], options: { creditId: "c1", requestId: "r1" } });
		for (const args of [["codex", "reset"], ["claude", "reset", "work"], ["reset", "work"],
			["codex", "reset", "work", "-w"], ["quota", "--credit-id=c1"],
			["codex", "reset", "work", "--request-id="], ["codex", "reset", "work", "--credit-id"],
			["codex", "reset", "work", "--request-id=bad\nvalue"]]) {
			expect(() => parseArgs(args)).toThrow();
		}
	});
	test("routes exactly once, prints a request ID before spending, and does not scan quota", async () => {
		let output = ""; let errors = ""; let calls = 0;
		await runCli(["codex", "reset", "work", "--json", "--credit-id=c1", "--request-id=r1"], {
			providers: [{ id: "codex" }], output: { write: text => { output += text; } },
			errorOutput: { write: text => { errors += text; } },
			loadSnapshot: () => { throw new Error("must not scan"); },
			useCodexReset: async (label, options) => {
				calls++;
				expect(errors).toContain("r1");
				expect(label).toBe("work");
				expect(options).toEqual({ creditId: "c1", requestId: "r1" });
				return { code: "no_credit", windowsReset: 0, requestId: "r1" };
			},
		});
		expect(calls).toBe(1);
		expect(JSON.parse(output)).toEqual({ provider: "codex", code: "no_credit", windowsReset: 0, requestId: "r1" });
	});
});
