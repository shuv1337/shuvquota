/**
 * Antigravity (Google AI Pro) provider adapter.
 * Depends on: lib/antigravity-accounts.js, lib/antigravity-tokens.js,
 * lib/antigravity-usage.js, lib/token-match.js, lib/providers/_util.js
 *
 * Google does not rotate the refresh token, so an owned refresh only moves
 * access/expires. shuvcode/OpenCode SQLite credentials, the V1 accounts file,
 * and env blobs are read-only and never rotated.
 */

import { ANTIGRAVITY_V1_ACCOUNTS_PATH } from "../constants.js";
import {
	normalizeAntigravityAccount as parseAntigravityRow,
	loadAntigravityAccountsFromEnv,
	loadAntigravityAccountsFromV1File,
	loadAntigravityAccountsFromIntegrationDb,
	getAntigravityIntegrationDbPaths,
} from "../antigravity-accounts.js";
import { refreshAntigravityToken, isAntigravityTokenExpiring } from "../antigravity-tokens.js";
import { fetchAntigravityUsage } from "../antigravity-usage.js";
import { ANTIGRAVITY_TOKEN_FIELDS } from "../token-match.js";
import { normalizeAntigravityAccount } from "../snapshot.js";
import { defineProvider, tokenFingerprint } from "./_util.js";

/** @param {object} row - Row from antigravity-accounts.js loaders. @param {string} kind */
function fromRow(row, kind) {
	return {
		label: row.label, kind, source: row.source, access: row.access ?? null,
		refresh: row.refresh ?? null, expires: row.expires ?? null, projectId: row.projectId ?? null,
		email: row.email ?? null, paidTier: row.paidTier ?? null,
	};
}

/** Every env/harness Antigravity credential, one row per physical location. */
async function loadExternal() {
	const out = loadAntigravityAccountsFromEnv().map(row => fromRow(row, "env"));
	const v1Path = process.env.ANTIGRAVITY_V1_ACCOUNTS_PATH || ANTIGRAVITY_V1_ACCOUNTS_PATH;
	out.push(...loadAntigravityAccountsFromV1File(v1Path).map(row => fromRow(row, "harness")));
	for (const dbPath of getAntigravityIntegrationDbPaths()) {
		out.push(...(await loadAntigravityAccountsFromIntegrationDb(dbPath)).map(row => fromRow(row, "harness")));
	}
	return out;
}

/** @param {object} [deps] - Test injection seam; see _util.js `defineProvider`. */
export function createAntigravityProvider(deps = {}) {
	return defineProvider({
		id: "antigravity",
		name: "Antigravity",
		fieldMap: ANTIGRAVITY_TOKEN_FIELDS,
		normalizeSnapshot: normalizeAntigravityAccount,
		identityOf: account => account.email ?? account.refresh ?? account.access ?? null,
		identityKeyOf: account => account.email ?? account.projectId ?? tokenFingerprint(account.refresh ?? account.access),
		fromManaged: (base, raw) => {
			const parsed = parseAntigravityRow(raw, { label: base.label, source: base.source }) ?? {};
			return {
				...base,
				refresh: parsed.refresh ?? base.refresh,
				expires: parsed.expires ?? base.expires,
				projectId: parsed.projectId ?? null,
				email: parsed.email ?? null,
				paidTier: parsed.paidTier ?? null,
			};
		},
		external: loadExternal,
		isExpiring: tokens => isAntigravityTokenExpiring(tokens.access, tokens.expires),
		refresh: async (tokens, deps) => {
			const result = await refreshAntigravityToken(tokens.refresh, { fetchFn: deps.fetchFn });
			if (result.error) throw new Error(result.error);
			return { access: result.access, refresh: result.refresh ?? tokens.refresh, expires: result.expires };
		},
		fetchUsage: async (account, deps) => {
			const result = await fetchAntigravityUsage({ access: account.access, projectId: account.projectId }, { fetchFn: deps.fetchFn });
			return result.success ? { usage: result.usage } : { error: result.error ?? "Antigravity quota unavailable" };
		},
		loginEntry: (entry, credential) => (
			typeof credential.projectId === "string" && credential.projectId ? { ...entry, projectId: credential.projectId } : entry
		),
	}, deps);
}

export const antigravity = createAntigravityProvider();
