import { expect, test } from "bun:test";
import { fetchClaudeOAuthUsage } from "../lib/claude-usage.js";
import { fetchGrokUsage } from "../lib/grok-usage.js";
import { normalizeGrokAccount, toPublicSnapshot, safePublicError } from "../lib/snapshot.js";

test("Claude backs off on Retry-After zero and retries only after cooldown", async () => {
	let clock = 1000;
	let calls = 0;
	const options = { now: () => clock, fetchFn: async () => {
		calls++;
		return calls === 1 ? new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } })
			: Response.json({ five_hour: { utilization: 25 } });
	} };
	const first = await fetchClaudeOAuthUsage("fixture-rate-limit-zero", options);
	expect(first.status).toBe(429);
	expect(safePublicError(first.error)).toBe("Rate limited; retry in 300 seconds");
	clock += 60000;
	expect((await fetchClaudeOAuthUsage("fixture-rate-limit-zero", options)).error).toContain("240 seconds");
	expect(calls).toBe(1);
	clock += 240000;
	expect((await fetchClaudeOAuthUsage("fixture-rate-limit-zero", options)).success).toBe(true);
	expect(calls).toBe(2);
});

test("Claude honors a longer Retry-After without blocking another credential", async () => {
	const now = () => 1000;
	const result = await fetchClaudeOAuthUsage("fixture-long-cooldown", { now,
		fetchFn: async () => new Response(null, { status: 429, headers: { "Retry-After": "900" } }) });
	expect(result.retryAt).toBe(901000);
	expect((await fetchClaudeOAuthUsage("fixture-other-account", { now,
		fetchFn: async () => Response.json({}) })).success).toBe(true);
});

test("Grok permission denial survives the public projection as an actionable error", async () => {
	const result = await fetchGrokUsage({ accessToken: "fixture-grok-token" }, {
		fetchFn: async () => Response.json({ error: "User does not have Grok Code CLI permission" }, { status: 403 }),
	});
	expect(result.error).toBe("This Grok session lacks Code CLI access");
	const account = normalizeGrokAccount({ label: "work" }, { error: result.error });
	const publicSnapshot = toPublicSnapshot({ providers: [{ id: "grok", accounts: [account] }] });
	expect(publicSnapshot.providers[0].accounts[0].error).toBe(result.error);
});

test("unrecognized Grok authorization response remains private", async () => {
	const result = await fetchGrokUsage({ accessToken: "fixture-grok-token" }, {
		fetchFn: async () => Response.json({ error: "private information" }, { status: 403 }),
	});
	expect(result.error).toBe("Grok sign-in required");
});
