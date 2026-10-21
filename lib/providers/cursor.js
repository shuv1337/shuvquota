/** Read-only Cursor API keys from T3 Code (shuv2code) provider instances. Nothing is refreshed or written. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { normalizeGenericAccount } from "../snapshot.js";

/** Discover only explicitly configured T3 state, without changing its credentials. */
function readCursorAccounts(stateDir) {
	if (!stateDir) return [];
	let settings;
	try { settings = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")); }
	catch { return []; }
	const sources = [];
	for (const [id, instance] of Object.entries(settings.providerInstances ?? {})) {
		if (instance?.driver !== "cursor") continue;
		const variable = instance.environment?.find(item => item.name === "CURSOR_API_KEY");
		if (!variable) continue;
		let apiKey = variable.value;
		if (variable.sensitive && variable.valueRedacted) {
			const encode = value => Buffer.from(value).toString("base64url");
			try {
				apiKey = readFileSync(join(stateDir, "secrets", `provider-env-${encode(id)}-${encode(variable.name)}.bin`), "utf8");
			} catch { continue; }
		}
		if (typeof apiKey !== "string" || !apiKey.trim()) continue;
		apiKey = apiKey.trim();
		sources.push({ provider: "cursor", label: instance.displayName || id, apiKey,
			kind: "harness", location: join(stateDir, "settings.json"), writable: false,
			// Disabled instances still hold a valid key; enabled ones win duplicates.
			enabled: instance.enabled !== false,
			identityKey: createHash("sha256").update(apiKey).digest("hex") });
	}
	return sources;
}

async function exchangeKey(apiKey, fetchFn) {
	const session = await request("auth/exchange_user_api_key", apiKey, fetchFn);
	if (typeof session.accessToken !== "string" || !session.accessToken) {
		throw new Error("Cursor authentication returned no session token");
	}
	return session.accessToken;
}

async function request(path, token, fetchFn) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15000);
	try {
		const response = await fetchFn(`https://api2.cursor.sh/${path}`, {
			method: "POST", headers: { authorization: `Bearer ${token}`,
				"content-type": "application/json", "connect-protocol-version": "1" },
			body: "{}", signal: controller.signal,
		});
		if (!response.ok) throw new Error([401, 403].includes(response.status)
			? "Cursor authentication required; reauthenticate in the source application"
			: `Cursor quota service returned HTTP ${response.status}`);
		return await response.json();
	} finally { clearTimeout(timer); }
}

/** Exchange a stable API key for a fresh session, never refresh a harness session. */
export async function fetchCursorUsage(apiKey, fetchFn = fetch) {
	return fetchSessionUsage(await exchangeKey(apiKey, fetchFn), fetchFn);
}

async function fetchSessionUsage(access, fetchFn) {
	const usage = await request("aiserver.v1.DashboardService/GetCurrentPeriodUsage", access, fetchFn);
	const reset = Number(usage.billingCycleEnd);
	const resetsAt = Number.isFinite(reset) && reset > 0
		? new Date(reset < 1e12 ? reset * 1000 : reset).toISOString() : usage.billingCycleEnd;
	const windows = [];
	// API (third-party models such as Opus) is listed first: it runs out first.
	for (const [id, label, field] of [
		["api", "API", "apiPercentUsed"],
		["total", "Total usage", "totalPercentUsed"],
		["auto", "Auto", "autoPercentUsed"],
	]) {
		const value = usage.planUsage?.[field];
		if (typeof value === "number" && Number.isFinite(value)) {
			windows.push({ id, label, percentUsed: value, resetsAt });
		}
	}
	return { usage: { windows } };
}

/** Build the read-only Cursor adapter with isolated discovery and HTTP test seams. */
export function createCursorProvider(deps = {}) {
	const fetchFn = deps.fetchFn ?? fetch;
	const readAccounts = () => readCursorAccounts(deps.stateDir ?? process.env.SHUVQUOTA_T3_STATE_DIR);
	const discoverSources = () => readAccounts().map(account => ({
		provider: "cursor", label: account.label, kind: account.kind,
		location: account.location, identityKey: account.identityKey, writable: false,
	}));
	return {
		id: "cursor", name: "Cursor", discoverSources,
		async discoverAccounts() {
			// Every instance with a key is an account; a key shared by several is fetched once.
			const keys = new Set();
			return readAccounts().sort((a, b) => Number(b.enabled) - Number(a.enabled)).filter(account => {
				if (keys.has(account.apiKey)) return false;
				keys.add(account.apiKey);
				return true;
			});
		},
		async fetch(account) {
			return fetchCursorUsage(account.apiKey, fetchFn);
		},
		normalize: normalizeGenericAccount,
		async login() { throw new Error("Configure read-only Cursor accounts in T3 Code"); },
	};
}

export const cursor = createCursorProvider();
