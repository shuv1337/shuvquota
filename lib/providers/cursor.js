/** Read-only T3 API keys and cursorprox sessions. External refresh tokens are never used. */
import { readFileSync, readdirSync } from "node:fs";
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
		if (instance?.driver !== "cursor" || instance.enabled === false) continue;
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
			identityKey: createHash("sha256").update(apiKey).digest("hex") });
	}
	return sources;
}

function tokenClaims(access) {
	try { return JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8")); }
	catch { return {}; }
}

function subjectOf(access) {
	const sub = tokenClaims(access).sub;
	return typeof sub === "string" && sub.trim() ? sub : null;
}

function readProxyAccounts(authDir) {
	if (!authDir) return [];
	let files;
	try { files = readdirSync(authDir).filter(file => file.endsWith(".json")).sort(); }
	catch { return []; }
	return files.flatMap(file => {
		const location = join(authDir, file);
		let row;
		try { row = JSON.parse(readFileSync(location, "utf8")); } catch { return []; }
		if (row?.type !== "cursor" || row.disabled || typeof row.access_token !== "string" || !row.access_token) return [];
		const accountId = subjectOf(row.access_token);
		const email = typeof row.email === "string" ? row.email : null;
		return [{ provider: "cursor", label: row.label || (email ? `Cursor ${email.split("@")[0]}` : file.slice(0, -5)),
			email, accountId, access: row.access_token, proxySession: true,
			kind: "harness", location, writable: false,
			identityKey: createHash("sha256").update(accountId ?? location).digest("hex") }];
	});
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
	for (const [id, label, field] of [
		["total", "Total usage", "totalPercentUsed"],
		["auto", "Auto", "autoPercentUsed"],
		["api", "API", "apiPercentUsed"],
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
	const readAccounts = () => [
		...readCursorAccounts(deps.stateDir ?? process.env.SHUVQUOTA_T3_STATE_DIR),
		...readProxyAccounts(deps.authDir ?? process.env.SHUVQUOTA_CURSORPROX_AUTH_DIR),
	];
	const discoverSources = () => readAccounts().map(account => ({
		provider: "cursor", label: account.label, kind: account.kind,
		location: account.location, identityKey: account.identityKey, writable: false,
	}));
	return {
		id: "cursor", name: "Cursor", discoverSources,
		async discoverAccounts() {
			const physical = readAccounts();
			const keys = new Set();
			const accounts = physical.filter(account => {
				if (!account.apiKey) return true;
				if (keys.has(account.apiKey)) return false;
				keys.add(account.apiKey);
				return true;
			});
			// Resolve API-key subjects only when cross-source identity merging is needed.
			if (accounts.some(account => account.proxySession)) {
				const keyed = accounts.filter(account => account.apiKey);
				for (let i = 0; i < keyed.length; i += 4) {
					await Promise.all(keyed.slice(i, i + 4).map(async account => {
						try {
							account.access = await exchangeKey(account.apiKey, fetchFn);
							account.accountId = subjectOf(account.access);
						} catch { account.discoveryError = "Cursor authentication unavailable; check T3 Code API key"; }
					}));
				}
			}
			const byIdentity = new Map();
			for (const account of accounts) {
				const identity = account.accountId ? `subject:${account.accountId}` : `source:${account.identityKey}`;
				const prior = byIdentity.get(identity);
				if (!prior) byIdentity.set(identity, account);
				else if (!prior.email && account.email) prior.email = account.email;
			}
			return [...byIdentity.values()];
		},
		async fetch(account) {
			if (account.discoveryError) throw new Error(account.discoveryError);
			if (!account.access) return fetchCursorUsage(account.apiKey, fetchFn);
			const exp = tokenClaims(account.access).exp;
			if (account.proxySession && typeof exp === "number" && exp * 1000 <= (deps.now?.() ?? Date.now())) {
				throw new Error("Cursor session expired; reauthenticate in cursorprox");
			}
			return fetchSessionUsage(account.access, fetchFn);
		},
		normalize: normalizeGenericAccount,
		async login() { throw new Error("Configure read-only Cursor accounts through T3 Code or cursorprox"); },
	};
}

export const cursor = createCursorProvider();
