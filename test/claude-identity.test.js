import { expect, test } from "bun:test";
import { createClaudeUserAgent } from "../lib/claude-identity.js";

for (const [output, expected] of [
	["2.1.319 (Claude Code)", "2.1.319"],
	["2.1.320 (Claude Code)\n", "2.1.320"],
	["2.2.0 (Claude Code)", "2.2.0"],
	["3.0.0 (Claude Code)", "3.0.0"],
	["2.1.9 (Claude Code)", "2.1.319"],
	["1.99.999 (Claude Code)", "2.1.319"],
	["unexpected", "2.1.319"],
	["99.0.0 not Claude", "2.1.319"],
]) {
	test(`CLI identity: ${output.trim()}`, async () => {
		let calls = 0;
		const read = createClaudeUserAgent(async () => { calls++; return output; });
		const values = await Promise.all([read(), read(), read()]);
		expect(values).toEqual(Array(3).fill(`claude-cli/${expected} (external, cli) shuvquota`));
		await read();
		expect(calls).toBe(1);
	});
}

test("missing or timed-out CLI falls back once, without retrying", async () => {
	let calls = 0;
	const read = createClaudeUserAgent(async () => { calls++; throw new Error("timeout or ENOENT"); });
	expect(await read()).toBe("claude-cli/2.1.319 (external, cli) shuvquota");
	await read();
	expect(calls).toBe(1);
});
