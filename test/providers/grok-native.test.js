import { beforeEach, afterEach, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGrokAccountsFromNativeCli } from "../../lib/grok-accounts.js";
import { createGrokProvider } from "../../lib/providers/grok.js";
import { addManagedAccount, getManagedStorePath } from "../../lib/credential-store.js";
import { loadSnapshot } from "../../lib/quota.js";

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "shuvquota-grok-native-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

test("native Build OIDC records become read-only candidates without exposing or changing credentials", () => {
	const path = join(home, "auth.json");
	const raw = JSON.stringify({ issuerClient: { auth_mode: "oidc", oidc_issuer: "https://auth.x.ai",
		key: "native-access", refresh_token: "native-refresh", user_id: "same-user",
		email: "user@example.test", expires_at: "2099-01-01T00:00:00Z" },
		api: { auth_mode: "api_key", key: "api-key" } });
	writeFileSync(path, raw);
	const accounts = loadGrokAccountsFromNativeCli(path);
	expect(accounts).toHaveLength(1);
	expect(accounts[0]).toMatchObject({ label: "grok-build", accountId: "same-user", accessToken: "native-access" });
	expect(accounts[0].expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z"));
	expect(readFileSync(path, "utf8")).toBe(raw);
});

test("managed session permission denial falls back only to a usable session of the same account", async () => {
	addManagedAccount("grok", { label: "supergrok", accountId: "same-user", access: "managed-access", refresh: "managed-refresh", expires: Date.now() + 3600000 }, { home });
	const path = getManagedStorePath("grok", { home });
	const before = readFileSync(path, "utf8");
	const requests = [];
	const provider = createGrokProvider({ home, external: () => [
		{ label: "other-user", kind: "harness", accountId: "other-user", access: "other-access", expires: Date.now() + 3600000 },
		{ label: "expired", kind: "harness", accountId: "same-user", access: "expired-access", expires: 1 },
		{ label: "grok-build", kind: "harness", accountId: "same-user", access: "native-access", refresh: "native-refresh", expires: Date.now() + 3600000 },
	], fetchFn: async (url, options) => {
		requests.push(options.headers.Authorization);
		if (options.headers.Authorization === "Bearer managed-access") return Response.json({ error: "User does not have Grok Code CLI permission" }, { status: 403 });
		expect(options.headers.Authorization).toBe("Bearer native-access");
		return Response.json({ config: { creditUsagePercent: 25, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2099-01-01T00:00:00Z" } } });
	}, refresh: () => { throw new Error("must not refresh any credential"); } });
	const snapshot = await loadSnapshot({ providers: [provider], labelFilter: "supergrok" });
	const account = snapshot.providers[0].accounts[0];
	expect(account.status).toBe("ok");
	expect(account.windows[0].percentRemaining).toBe(75);
	expect(account.extras).toContainEqual({ id: "source", label: "Source", value: "Read-only fallback" });
	expect(requests).toEqual(["Bearer managed-access", "Bearer native-access"]);
	expect(readFileSync(path, "utf8")).toBe(before);
	expect((await provider.discoverSources()).some(source => source.label === "grok-build" && !source.writable)).toBe(true);
});
