/**
 * Codex (OpenAI) provider adapter.
 * Depends on: lib/codex-accounts.js, lib/codex-tokens.js, lib/codex-usage.js,
 * lib/jwt.js, lib/proxx-usage.js, lib/token-match.js, lib/providers/_util.js
 *
 * Only independently-enrolled managed rows are refreshed, via the pure
 * `refreshToken()` exchange; env, legacy-file, Codex CLI, and OpenCode
 * credentials are read-only. proxx remote records merge on a verified
 * accountId only; remote failure leaves local results untouched.
 */

import { existsSync, readFileSync } from "node:fs";
import { MULTI_ACCOUNT_PATHS, PROXX_DEFAULT_BASE_URL } from "../constants.js";
import { loadAccountsFromEnv, loadAccountsFromFile, loadAccountFromCodexCli } from "../codex-accounts.js";
import { refreshToken, isOpenAiOauthTokenExpiring } from "../codex-tokens.js";
import { fetchUsage as fetchCodexUsage } from "../codex-usage.js";
import { extractAccountId, extractProfile } from "../jwt.js";
import { getOpencodeAuthPath } from "../paths.js";
import { fetchProxxOpenAiQuota, formatProxxQuotaResponse } from "../proxx-usage.js";
import { getManagedStorePath } from "../credential-store.js";
import { OPENAI_TOKEN_FIELDS } from "../token-match.js";
import { normalizeCodexAccount } from "../snapshot.js";
import { defineProvider, numberValue } from "./_util.js";

/** @param {object} raw @param {string} kind @param {string} source */
function external(raw, kind, source) {
	const access = raw.access ?? null;
	return {
		label: raw.label, kind, source, access, refresh: raw.refresh ?? null,
		expires: numberValue(raw.expires), accountId: raw.accountId ?? extractAccountId(access),
		email: extractProfile(access).email,
	};
}

/** Every env/harness Codex credential, one row per physical location. */
function loadExternal(opts) {
	const managedPath = getManagedStorePath("codex", opts);
	const out = loadAccountsFromEnv().map(raw => external(raw, "env", "env:CODEX_ACCOUNTS"));
	for (const path of MULTI_ACCOUNT_PATHS) {
		if (path === managedPath) continue;
		out.push(...loadAccountsFromFile(path).map(raw => external(raw, "harness", path)));
	}
	out.push(...loadAccountFromCodexCli().map(raw => external(raw, "harness", raw.source)));
	const opencodePath = getOpencodeAuthPath();
	if (existsSync(opencodePath)) {
		try {
			const openai = JSON.parse(readFileSync(opencodePath, "utf-8"))?.openai;
			if (openai?.access) out.push(external({ ...openai, label: "opencode" }, "harness", opencodePath));
		} catch { /* unreadable harness file: nothing to list */ }
	}
	return out;
}

/**
 * Merge proxx remote accounts. A remote record matching a local accountId
 * attaches its usage as a fallback (local label wins); unmatched records
 * become read-only remote cards. Missing ids never collapse records.
 */
async function mergeProxx(local, ctx, deps) {
	const env = deps.env ?? process.env;
	const authToken = env.PROXX_AUTH_TOKEN;
	if (!authToken) return local;
	const baseUrl = env.PROXX_BASE_URL ?? env.PROXX_URL;
	const remote = await (deps.fetchProxx ?? fetchProxxOpenAiQuota)({ baseUrl, authToken, fetchFn: deps.fetchFn });
	if (!remote?.success) return local;
	const merged = local.map(account => ({ ...account }));
	for (const item of formatProxxQuotaResponse(remote.data)) {
		const accountId = typeof item.usage?.accountId === "string" ? item.usage.accountId : null;
		const match = accountId ? merged.find(account => account.accountId === accountId) : null;
		if (match) {
			match.remoteUsage = item.usage;
			continue;
		}
		merged.push({
			provider: "codex", label: item.label, kind: "remote", managed: false, readOnly: true,
			enrollment: "remote", source: baseUrl ?? PROXX_DEFAULT_BASE_URL, accountId, access: null, refresh: null,
			expires: null, email: null, remoteUsage: item.usage,
		});
	}
	return merged;
}

/** @param {object} [deps] - Test injection seam; see _util.js `defineProvider`. */
export function createCodexProvider(deps = {}) {
	return defineProvider({
		id: "codex",
		name: "Codex",
		fieldMap: OPENAI_TOKEN_FIELDS,
		normalizeSnapshot: normalizeCodexAccount,
		identityOf: account => account.accountId ?? null,
		fromManaged: (base, raw, tokens) => ({
			...base,
			accountId: tokens.accountId ?? extractAccountId(base.access),
			email: raw.email ?? extractProfile(base.access).email,
			planType: extractProfile(base.access).planType,
		}),
		external: loadExternal,
		remote: mergeProxx,
		isExpiring: tokens => isOpenAiOauthTokenExpiring(numberValue(tokens.expires)),
		refresh: async tokens => {
			const refreshed = await refreshToken(tokens.refresh);
			if (!refreshed) return null;
			const accountId = extractAccountId(refreshed.access);
			return { ...refreshed, ...(accountId ? { accountId } : {}) };
		},
		fetchUsage: async account => {
			const usage = await fetchCodexUsage({ access: account.access, accountId: account.accountId });
			return usage?.error ? { error: usage.error } : { usage };
		},
		loginEntry: (entry, credential) => {
			const accountId = credential.accountId ?? extractAccountId(entry.access);
			return accountId ? { ...entry, accountId } : entry;
		},
	}, deps);
}

export const codex = createCodexProvider();
