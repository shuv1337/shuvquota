/**
 * Owned account management shared by the CLI and the watch TUI.
 * Depends on: lib/credential-store.js (injectable as `store`).
 *
 * Only providers with a shuvquota-managed store accept writes. Harness, env,
 * and Cursor sources are read-only. `login` comes from the provider adapter;
 * this module persists its result and never refreshes anything itself.
 */

import * as defaultStore from "./credential-store.js";

/** User-facing account failure (bad label, duplicate, missing, read-only). */
export class AccountError extends Error {}

const CONTROL_RE = /[\x00-\x1f\x7f]/;

/**
 * Whether a provider has an owned, writable store.
 * @param {string} providerId
 * @returns {boolean}
 */
export function isManageable(providerId) {
	return Object.hasOwn(defaultStore.MANAGED_STORE_FILENAMES, providerId);
}

/**
 * Validate a label for storage; returns it unchanged.
 * @param {unknown} label
 * @param {string} [what]
 * @returns {string}
 */
export function validateLabel(label, what = "account label") {
	if (typeof label !== "string" || !label.trim() || CONTROL_RE.test(label)) {
		throw new AccountError(`Provide a non-empty ${what} without control characters.`);
	}
	return label;
}

/** @param {{ id: string, name?: string }} provider */
function requireManageable(provider) {
	if (provider.id === "cursor") {
		throw new AccountError("Cursor accounts are read-only sources; manage credentials and names in T3 Code.");
	}
	if (!isManageable(provider.id)) throw new AccountError(`${provider.name ?? provider.id} accounts are read-only.`);
}

/**
 * Owned accounts for the manageable providers, in provider then store order.
 * @param {Array<{ id: string, name?: string }>} providers
 * @param {{ store?: typeof defaultStore }} [options]
 * @returns {Array<{ provider: string, providerName: string, label: string, email: string | null }>}
 */
export function listAccounts(providers, { store = defaultStore } = {}) {
	return providers.filter(provider => isManageable(provider.id)).flatMap(provider =>
		store.listManagedAccounts(provider.id).map(row => ({
			provider: provider.id, providerName: provider.name ?? provider.id, label: row.label,
			email: typeof row.raw.email === "string" && row.raw.email ? row.raw.email : null,
		})));
}

/**
 * Enroll a new account: refuse duplicates before opening a browser, then log in and persist.
 * @param {{ id: string, name?: string, login: (ctx: object) => Promise<object> }} provider
 * @param {string} label
 * @param {{ store?: typeof defaultStore, loginContext?: object }} [options]
 * @returns {Promise<{ provider: string, label: string }>}
 */
export async function addAccount(provider, label, { store = defaultStore, loginContext = {} } = {}) {
	requireManageable(provider);
	validateLabel(label);
	if (store.findManagedAccount(provider.id, label)) throw new AccountError(`Account '${label}' already exists. Use reauth.`);
	const credential = await provider.login({ ...loginContext, label });
	store.addManagedAccount(provider.id, { ...credential, label });
	return { provider: provider.id, label };
}

/**
 * Replace an owned account's credential with a fresh login.
 * @param {{ id: string, name?: string, login: (ctx: object) => Promise<object> }} provider
 * @param {string} label
 * @param {{ store?: typeof defaultStore, loginContext?: object }} [options]
 * @returns {Promise<{ provider: string, label: string }>}
 */
export async function reauthAccount(provider, label, { store = defaultStore, loginContext = {} } = {}) {
	requireManageable(provider);
	validateLabel(label);
	if (!store.findManagedAccount(provider.id, label)) throw new AccountError(`Account '${label}' not found.`);
	const credential = await provider.login({ ...loginContext, label });
	store.replaceManagedAccount(provider.id, label, credential);
	return { provider: provider.id, label };
}

/**
 * @param {{ id: string, name?: string }} provider
 * @param {string} from
 * @param {string} to
 * @param {{ store?: typeof defaultStore }} [options]
 * @returns {{ provider: string, label: string }}
 */
export function renameAccount(provider, from, to, { store = defaultStore } = {}) {
	requireManageable(provider);
	validateLabel(from);
	validateLabel(to, "new label");
	if (from === to) return { provider: provider.id, label: to };
	try {
		store.renameManagedAccount(provider.id, from, to);
	} catch (error) {
		throw new AccountError(error.message.replace(/ for \w+$/, "."));
	}
	return { provider: provider.id, label: to };
}

/**
 * @param {{ id: string, name?: string }} provider
 * @param {string} label
 * @param {{ store?: typeof defaultStore }} [options]
 * @returns {{ provider: string, label: string }}
 */
export function removeAccount(provider, label, { store = defaultStore } = {}) {
	requireManageable(provider);
	validateLabel(label);
	if (!store.removeManagedAccount(provider.id, label).removed) throw new AccountError(`Account '${label}' not found.`);
	return { provider: provider.id, label };
}
