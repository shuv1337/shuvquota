/** Explicit Codex reset redemption; never called by quota discovery or refresh. */
import { randomUUID } from "node:crypto";
import * as defaultStore from "./credential-store.js";
import { normalizeEntryTokens, OPENAI_TOKEN_FIELDS } from "./token-match.js";
import { extractAccountId } from "./jwt.js";
import { isHardExpired } from "./providers/_util.js";
import { RESET_CREDITS_URL } from "./constants.js";

const OUTCOMES = new Set(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]);

/** Validate opaque operation/credit identifiers without allowing terminal controls. */
export function validateResetId(value) {
	if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) {
		throw new Error("Reset identifiers must be non-empty, at most 256 characters, without whitespace or controls.");
	}
	return value;
}

/**
 * Spend one banked reset on an exact owned label. No retries or credential writes.
 * A supplied requestId must be reused when retrying an uncertain result.
 */
export async function useCodexReset(label, {
	creditId, requestId = randomUUID(), store = defaultStore, home,
	fetchFn = globalThis.fetch, timeoutMs = 15000, now = Date.now(),
} = {}) {
	validateResetId(requestId);
	if (creditId !== undefined) validateResetId(creditId);
	if (typeof label !== "string" || !label.trim()) throw new Error("Provide an exact managed account label.");
	const rows = store.listManagedAccounts("codex", home ? { home } : {})
		.filter(row => row.label === label && row.raw.enrollment === "independent");
	if (rows.length !== 1) {
		throw new Error("Reset requires exactly one independently enrolled Codex account with this label. Use cq codex add <label>.");
	}
	const tokens = normalizeEntryTokens(rows[0].raw, OPENAI_TOKEN_FIELDS);
	const accountId = tokens.accountId ?? extractAccountId(tokens.access);
	if (!tokens.access || isHardExpired(tokens.access, tokens.expires, now)) {
		throw new Error("Codex access token is missing or expired. Refresh via cq codex quota <label>, or use cq codex reauth <label>, then retry.");
	}
	if (!accountId) throw new Error("Codex account ID is missing. Use cq codex reauth <label>.");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchFn(`${RESET_CREDITS_URL}/consume`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tokens.access}`,
				"chatgpt-account-id": accountId,
				"Content-Type": "application/json",
				accept: "application/json",
				"User-Agent": "codex-cli",
			},
			body: JSON.stringify({ redeem_request_id: requestId, ...(creditId === undefined ? {} : { credit_id: creditId }) }),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = await response.json();
		if (!OUTCOMES.has(body?.code) || !Number.isInteger(body.windows_reset) || body.windows_reset < 0) {
			throw new Error("Unexpected response");
		}
		return { code: body.code, windowsReset: body.windows_reset, requestId };
	} catch {
		// Neither raw server bodies nor transport errors are safe display strings.
		throw new Error(`Reset result is uncertain. Check quota before retrying; reuse --request-id ${requestId} with the same account and credit. Do not generate a new ID for this attempt.`);
	} finally {
		clearTimeout(timer);
	}
}
