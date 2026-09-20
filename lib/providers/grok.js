/**
 * Grok (xAI SuperGrok OAuth) provider adapter.
 * Depends on: lib/grok-accounts.js, lib/grok-tokens.js, lib/grok-usage.js,
 * lib/token-match.js, lib/providers/_util.js
 *
 * xAI rotates the refresh token on every exchange, so an owned refresh is
 * fanned out to every independently-enrolled managed row holding the same
 * pre-rotation token. pi/shuvpi/shuvhelm, OpenCode, Hermes, and env
 * credentials are read-only and never rotated.
 */

import { GROK_PI_AUTH_PATHS, GROK_HERMES_AUTH_PATH } from "../constants.js";
import {
	loadGrokAccountsFromEnv,
	loadGrokAccountsFromNativeCli,
	loadGrokAccountsFromPiAuth,
	loadGrokAccountsFromOpencodeAuth,
	loadGrokAccountsFromHermesAuth,
	loadGrokPlanOverride,
	extractGrokProfile,
	resolveGrokExpiresAt,
} from "../grok-accounts.js";
import { refreshGrokToken, isGrokTokenExpiring } from "../grok-tokens.js";
import { fetchGrokUsage } from "../grok-usage.js";
import { getOpencodeAuthPath } from "../paths.js";
import { XAI_TOKEN_FIELDS } from "../token-match.js";
import { normalizeGrokAccount } from "../snapshot.js";
import { defineProvider, isHardExpired } from "./_util.js";

/** @param {object} candidate - Row from grok-accounts.js loaders. @param {string} kind */
function fromCandidate(candidate, kind) {
	return {
		label: candidate.label, kind, source: candidate.source,
		access: candidate.accessToken ?? null, refresh: candidate.refreshToken ?? null,
		expires: candidate.expiresAt ?? null, accountId: candidate.accountId ?? null,
		email: candidate.email ?? null, tier: candidate.tier ?? null, teamId: candidate.teamId ?? null,
		tokenEndpoint: candidate.tokenEndpoint ?? null,
	};
}

/** Every env/harness Grok credential, one row per physical location. */
function loadExternal() {
	const out = [
		...loadGrokAccountsFromNativeCli().map(candidate => fromCandidate(candidate, "harness")),
		...loadGrokAccountsFromEnv().map(candidate => fromCandidate(candidate, "env")),
	];
	for (const path of GROK_PI_AUTH_PATHS) {
		out.push(...loadGrokAccountsFromPiAuth(path).map(candidate => fromCandidate(candidate, "harness")));
	}
	out.push(...loadGrokAccountsFromOpencodeAuth(getOpencodeAuthPath()).map(candidate => fromCandidate(candidate, "harness")));
	out.push(...loadGrokAccountsFromHermesAuth(GROK_HERMES_AUTH_PATH).map(candidate => fromCandidate(candidate, "harness")));
	return out;
}

/** @param {object} [deps] - Test injection seam; see _util.js `defineProvider`. */
export function createGrokProvider(deps = {}) {
	return defineProvider({
		id: "grok",
		name: "Grok",
		fieldMap: XAI_TOKEN_FIELDS,
		normalizeSnapshot: (account, result, now, options) => {
			const snapshot = normalizeGrokAccount(account, result, now, options);
			if (result?.readOnlyFallback) snapshot.extras.push({ id: "source", label: "Source", value: "Read-only fallback" });
			return snapshot;
		},
		identityOf: account => account.accountId ?? null,
		fromManaged: (base, raw, tokens) => {
			const profile = extractGrokProfile(base.access);
			return {
				...base,
				expires: resolveGrokExpiresAt(tokens.expires, base.access),
				accountId: tokens.accountId ?? profile.accountId,
				email: raw.email ?? profile.email,
				tier: profile.tier,
				teamId: profile.teamId,
				tokenEndpoint: raw.tokenEndpoint ?? raw.token_endpoint ?? null,
				planOverride: raw.planOverride ?? (deps.external ? null : loadGrokPlanOverride()),
			};
		},
		external: loadExternal,
		isExpiring: tokens => isGrokTokenExpiring(tokens.access, resolveGrokExpiresAt(tokens.expires, tokens.access)),
		refresh: async (tokens, deps, account) => {
			const result = await refreshGrokToken(tokens.refresh, { tokenEndpoint: account.tokenEndpoint, fetchFn: deps.fetchFn });
			if (result.error) throw new Error(result.error);
			return {
				access: result.access_token,
				refresh: result.refresh_token,
				expires: Date.now() + result.expires_in * 1000,
			};
		},
		fetchUsage: async (account, deps) => {
			const result = await fetchGrokUsage({ accessToken: account.access }, { fetchFn: deps.fetchFn });
			if (result.status === 403 && result.error === "This Grok session lacks Code CLI access" && account.accountId) {
				const candidates = await (deps.external ?? loadExternal)();
				const seen = new Set([account.access]);
				for (const candidate of candidates) {
					if (candidate.accountId !== account.accountId || !candidate.access || seen.has(candidate.access)
						|| isHardExpired(candidate.access, candidate.expires, deps.now?.() ?? Date.now())) continue;
					seen.add(candidate.access);
					const fallback = await fetchGrokUsage({ accessToken: candidate.access }, { fetchFn: deps.fetchFn });
					if (fallback.success) return { usage: fallback.usage, readOnlyFallback: true };
				}
			}
			return result.success ? { usage: result.usage } : { error: result.error ?? "Grok quota unavailable" };
		},
		loginEntry: (entry, credential) => {
			const accountId = credential.accountId ?? extractGrokProfile(entry.access).accountId;
			return accountId ? { ...entry, accountId } : entry;
		},
	}, deps);
}

export const grok = createGrokProvider();
