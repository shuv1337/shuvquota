/**
 * Provider registry. Fixed order matches lib/snapshot.js PROVIDER_ORDER.
 * Depends on: lib/providers/{codex,claude,grok,antigravity}.js
 */

import { codex } from "./codex.js";
import { claude } from "./claude.js";
import { grok } from "./grok.js";
import { antigravity } from "./antigravity.js";

import { cursor } from "./cursor.js";

export const allProviders = Object.freeze([codex, claude, grok, antigravity, cursor]);
const disabled = new Set((process.env.SHUVQUOTA_DISABLED_PROVIDERS ?? "").split(",").map(id => id.trim()));
export const providers = Object.freeze(allProviders.filter(provider => !disabled.has(provider.id)));

/**
 * @param {string} id
 * @returns {object | null}
 */
export function getProvider(id) {
	if (typeof id !== "string") return null;
	const key = id.trim().toLowerCase();
	return allProviders.find(provider => provider.id === key) ?? null;
}

export { codex, claude, grok, antigravity, cursor };
