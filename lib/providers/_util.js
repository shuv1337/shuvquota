/**
 * Shared internals for lib/providers/*.js adapters.
 * Depends on: lib/credential-store.js, lib/token-match.js, lib/jwt.js
 *
 * `defineProvider(spec, deps)` turns a small per-provider spec into the full
 * adapter contract (discoverAccounts / discoverSources / fetch / normalize /
 * login). `deps` is the test injection seam: `home` (managed store root),
 * `external` (replaces every env/harness loader), `refresh`, `fetchUsage`,
 * `fetchProxx`, `loginProvider`, `fetchFn`, `env`, `now`. Production uses the
 * spec defaults, which reuse the existing per-provider loader modules.
 *
 * Write discipline: the only persistence path is `fanOutManagedAccountTokens`
 * on this provider's own managed store, and only for independently-enrolled
 * rows. Env/harness/legacy credentials are never refreshed or written.
 * `login()` is pure — it returns the raw store row; the CLI persists it.
 */

import { createHash } from "node:crypto";
import { decodeJWT } from "../jwt.js";
import {
	listManagedAccounts,
	findManagedAccount,
	fanOutManagedAccountTokens,
	withManagedAccountLock,
	getManagedStorePath,
	isIndependentlyEnrolled,
} from "../credential-store.js";
import { normalizeEntryTokens, updateEntryTokens } from "../token-match.js";

/** @param {unknown} value @returns {number | null} */
export function numberValue(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/** @param {unknown} error @returns {string} */
export function errorText(error) {
	const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return text.replace(/\s+/g, " ").trim() || "Unknown error";
}

/** Short, non-reversible identity key for a token so `cq sources` never lists secrets. */
export function tokenFingerprint(token) {
	if (typeof token !== "string" || !token) return null;
	return `sha256:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

/** Managed-store options from a call ctx plus factory deps. */
export function storeOptions(ctx = {}, deps = {}) {
	const home = ctx?.home ?? deps.home;
	return home ? { home } : {};
}

/**
 * Hard expiry for credentials this process cannot rotate. Uses the JWT `exp`
 * claim when the access token carries one (loaders sometimes stamp a fake
 * `expires` placeholder), otherwise the stored expiry. Never the refresh buffer.
 * @param {unknown} access
 * @param {unknown} expires
 * @param {number} [now]
 */
export function isHardExpired(access, expires, now = Date.now()) {
	const exp = typeof access === "string" ? decodeJWT(access)?.exp : null;
	if (typeof exp === "number" && Number.isFinite(exp)) return exp * 1000 <= now;
	const at = numberValue(expires);
	return at !== null && at > 0 && at <= now;
}

/** Managed rows with canonical tokens resolved through the provider field map. */
export function readManaged(providerId, fieldMap, opts = {}) {
	const location = getManagedStorePath(providerId, opts);
	return listManagedAccounts(providerId, opts).map(row => ({
		...row, location, tokens: normalizeEntryTokens(row.raw, fieldMap),
	}));
}

/** Base account record for a managed row (legacy rows are read-only). */
export function managedAccountBase(providerId, row) {
	return {
		provider: providerId, label: row.label, kind: "managed", managed: true,
		readOnly: row.readOnly, enrollment: row.enrollment, source: row.location,
		access: row.tokens.access ?? null, refresh: row.tokens.refresh ?? null,
		expires: numberValue(row.tokens.expires),
	};
}

/**
 * Managed rows always win identity collisions; external candidates are then
 * deduplicated among themselves. Candidates without an identity are kept.
 * @template T
 * @param {T[]} physical
 * @param {(account: T) => string | null | undefined} identityOf
 */
export function mergeManagedWins(physical, identityOf) {
	const managed = physical.filter(account => account.managed);
	const seen = new Set(managed.map(identityOf).filter(Boolean));
	const out = [...managed];
	for (const account of physical) {
		if (account.managed) continue;
		const identity = identityOf(account);
		if (identity && seen.has(identity)) continue;
		if (identity) seen.add(identity);
		out.push(account);
	}
	return out;
}

/**
 * Refresh tokens this row must never rotate: legacy rows in the same managed
 * store plus every env/harness credential the provider can see.
 */
async function sharedRefreshTokens(providerId, label, handlers, opts) {
	const shared = new Set();
	for (const row of listManagedAccounts(providerId, opts)) {
		if (row.label === label || !row.readOnly) continue;
		const refresh = normalizeEntryTokens(row.raw, handlers.fieldMap).refresh;
		if (refresh) shared.add(refresh);
	}
	for (const token of (await handlers.externalRefreshTokens?.()) ?? []) if (token) shared.add(token);
	return shared;
}

/**
 * Refresh an independently-enrolled managed row at most once, inside the
 * per-credential lock, rereading the row first so a concurrent scan that
 * already rotated the shared refresh token is adopted instead of repeated.
 * Refuses to rotate a refresh token that any external or legacy session
 * still holds. Persists via fan-out to every owned row sharing the token.
 * @returns {Promise<{ ok: boolean, tokens?: Record<string, unknown>, entry?: object, refreshed?: boolean, error?: string }>}
 */
export function ensureFreshManaged(providerId, label, handlers, opts = {}) {
	return withManagedAccountLock(providerId, label, async () => {
		const found = findManagedAccount(providerId, label, opts);
		if (!found) return { ok: false, error: `Managed ${providerId} account '${label}' not found` };
		if (!isIndependentlyEnrolled(found.entry)) {
			return { ok: false, error: `${providerId} account '${label}' is not independently enrolled — run: cq ${providerId} reauth ${label}` };
		}
		const current = normalizeEntryTokens(found.entry, handlers.fieldMap);
		if (!handlers.isExpiring(current)) return { ok: true, tokens: current, entry: found.entry, refreshed: false };
		if (!current.refresh) return { ok: false, error: `${providerId} session expired and has no refresh token — run: cq ${providerId} reauth ${label}` };
		const shared = await sharedRefreshTokens(providerId, label, handlers, opts);
		if (shared.has(current.refresh)) {
			return { ok: false, error: `${providerId} refresh token is shared with an external or legacy session; refusing to rotate it — run: cq ${providerId} reauth ${label}` };
		}
		let refreshed;
		try {
			refreshed = await handlers.refresh(current);
		} catch (error) {
			return { ok: false, error: errorText(error) };
		}
		if (!refreshed?.access) return { ok: false, error: `${providerId} token refresh failed — run: cq ${providerId} reauth ${label}` };
		fanOutManagedAccountTokens(
			providerId, refreshed,
			{ previousRefresh: current.refresh, previousAccess: current.access },
			opts,
		);
		const latest = findManagedAccount(providerId, label, opts) ?? found;
		return { ok: true, tokens: normalizeEntryTokens(latest.entry, handlers.fieldMap), entry: latest.entry, refreshed: true };
	}, opts);
}

/**
 * Resolve a usable access token. External/legacy credentials are checked for
 * hard expiry only and never refreshed; owned rows go through the lock.
 */
export async function resolveCredential(providerId, name, account, handlers, opts, now = Date.now()) {
	if (!account.managed || account.readOnly) {
		if (!account.access) return { error: `${name} credential has no access token — run: cq ${providerId} add` };
		if (isHardExpired(account.access, account.expires, now)) return { error: `${name} session expired — run: cq ${providerId} add` };
		return { access: account.access, expires: account.expires };
	}
	const fresh = await ensureFreshManaged(providerId, account.label, handlers, opts);
	if (!fresh.ok) return { error: fresh.error };
	if (!fresh.tokens.access) return { error: `${name} credential has no access token — run: cq ${providerId} reauth ${account.label}` };
	return { access: fresh.tokens.access, expires: numberValue(fresh.tokens.expires), entry: fresh.entry };
}

/**
 * `loginProvider(providerId, ctx)` from lib/provider-oauth.js, accepted only as
 * an independent enrollment with an access token. Never persists.
 */
export async function runProviderOauthLogin(providerId, ctx = {}) {
	const mod = await import("../provider-oauth.js");
	if (typeof mod.loginProvider !== "function") return null;
	const result = await mod.loginProvider(providerId, ctx);
	if (!result || typeof result !== "object") return null;
	if (result.enrollment !== "independent") return null;
	if (typeof result.accessToken !== "string" || !result.accessToken) return null;
	return result;
}

/**
 * Run the OAuth login and shape the result into a raw managed-store row using
 * the provider's field map (Claude rows get oauthToken/… keys, the rest
 * access/refresh/expires). Accepts either accessToken/… or access/… input.
 */
export async function loginManaged(providerId, fieldMap, ctx = {}, deps = {}) {
	const credential = deps.loginProvider
		? await deps.loginProvider(providerId, ctx)
		: await runProviderOauthLogin(providerId, ctx);
	const access = credential?.accessToken ?? credential?.access;
	if (typeof access !== "string" || !access || credential.enrollment !== "independent") {
		throw new Error(`${providerId} login did not return an independent credential.`);
	}
	const entry = {};
	if (typeof ctx.label === "string" && ctx.label) entry.label = ctx.label;
	updateEntryTokens(entry, {
		access,
		refresh: credential.refreshToken ?? credential.refresh ?? null,
		expires: numberValue(credential.expiresAt ?? credential.expires),
	}, fieldMap);
	if (typeof credential.email === "string" && credential.email) entry.email = credential.email;
	return { entry, credential };
}

/** Append the read-only marker for env/harness/legacy/remote credentials. */
export function finishSnapshot(account, snapshot) {
	if (!account?.readOnly) return snapshot;
	const extras = Array.isArray(snapshot?.extras) ? snapshot.extras : [];
	return { ...snapshot, extras: [...extras, { id: "source", label: "Source", value: "Read-only" }] };
}

/**
 * Build a provider adapter from a spec.
 * @param {{
 *   id: string, name: string, fieldMap: Record<string, string[]>,
 *   normalizeSnapshot: Function, identityOf: Function, identityKeyOf?: Function,
 *   fromManaged: (base: object, raw: object, tokens: object) => object,
 *   external: (opts: object, deps: object) => object[] | Promise<object[]>,
 *   isExpiring: (tokens: object) => boolean,
 *   refresh: (tokens: object, deps: object, account: object) => Promise<object | null>,
 *   fetchUsage: (account: object, deps: object) => Promise<object>,
 *   remote?: (local: object[], ctx: object, deps: object) => Promise<object[]>,
 *   loginEntry?: (entry: object, credential: object) => object,
 * }} spec
 * @param {object} [deps]
 */
export function defineProvider(spec, deps = {}) {
	const { id, name } = spec;
	const loadExternal = async opts => {
		const rows = await (deps.external ?? spec.external)(opts, deps);
		return rows.map(row => ({ provider: id, managed: false, readOnly: true, enrollment: row.kind, ...row }));
	};
	const nowMs = ctx => {
		if (ctx?.now instanceof Date) return ctx.now.getTime();
		if (typeof ctx?.now === "number") return ctx.now;
		return deps.now ? deps.now() : Date.now();
	};

	/** Every physical credential, managed rows first, no deduplication. */
	async function physical(ctx) {
		const opts = storeOptions(ctx, deps);
		const managed = readManaged(id, spec.fieldMap, opts)
			.map(row => spec.fromManaged(managedAccountBase(id, row), row.raw, row.tokens));
		return [...managed, ...await loadExternal(opts)];
	}

	async function discoverAccounts(ctx = {}) {
		const local = mergeManagedWins(await physical(ctx), spec.identityOf);
		let accounts = local;
		try {
			accounts = spec.remote ? await spec.remote(local, ctx, deps) : local;
		} catch { /* Optional remote discovery must not hide local accounts. */ }
		const singleAccountProviders = String((deps.env ?? process.env).SHUVQUOTA_SINGLE_ACCOUNT_PROVIDERS ?? "")
			.split(",").map(value => value.trim().toLowerCase());
		if (!singleAccountProviders.includes(id) || accounts.length < 2) return accounts;
		// Only collapse unrelated sessions when the user explicitly confirms this
		// provider has one identity. Source listing and refresh ownership stay physical.
		const rank = account => {
			if (account.managed && !account.readOnly && account.refresh) return 3;
			if (account.access && !isHardExpired(account.access, account.expires, nowMs(ctx))) return 2;
			return account.access ? 1 : 0;
		};
		let best = accounts[0];
		for (const account of accounts.slice(1)) {
			if (rank(account) > rank(best)
				|| (rank(account) === rank(best) && (account.expires ?? 0) > (best.expires ?? 0))) best = account;
		}
		return [{ ...best, email: best.email ?? accounts.find(account => account.email)?.email ?? null }];
	}

	async function discoverSources(ctx = {}) {
		let remote = [];
		try {
			remote = spec.remote ? await spec.remote([], ctx, deps) : [];
		} catch { /* Optional remote discovery must not hide local sources. */ }
		const identityKeyOf = spec.identityKeyOf ?? spec.identityOf;
		return [...await physical(ctx), ...remote].map(account => ({
			provider: id,
			label: account.label,
			kind: account.kind,
			location: account.source,
			identityKey: identityKeyOf(account) ?? null,
			writable: Boolean(account.managed && !account.readOnly),
		}));
	}

	async function fetchAccount(account, ctx = {}) {
		try {
			if (account.kind === "remote") return { usage: account.remoteUsage };
			const opts = storeOptions(ctx, deps);
			const handlers = {
				fieldMap: spec.fieldMap,
				isExpiring: spec.isExpiring,
				refresh: tokens => (deps.refresh ?? spec.refresh)(tokens, deps, account),
				externalRefreshTokens: async () => (await loadExternal(opts)).map(row => row.refresh),
			};
			// A local card matched to a remote (proxx) record keeps the remote usage
			// as a fallback when its own credential cannot be used.
			const fallback = result => (result?.error && account.remoteUsage ? { usage: account.remoteUsage } : result);
			const credential = await resolveCredential(id, name, account, handlers, opts, nowMs(ctx));
			if (credential.error) return fallback({ error: credential.error });
			return fallback(await (deps.fetchUsage ?? spec.fetchUsage)({ ...account, access: credential.access }, deps));
		} catch (error) {
			return account.remoteUsage ? { usage: account.remoteUsage } : { error: errorText(error) };
		}
	}

	function normalize(account, result, now = new Date(), options = {}) {
		return finishSnapshot(account, spec.normalizeSnapshot(account, result, now, options));
	}

	async function login(ctx = {}) {
		const { entry, credential } = await loginManaged(id, spec.fieldMap, ctx, deps);
		return spec.loginEntry ? spec.loginEntry(entry, credential) : entry;
	}

	return { id, name, discoverAccounts, discoverSources, fetch: fetchAccount, normalize, login };
}
