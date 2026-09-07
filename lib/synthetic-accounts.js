/**
 * Synthetic API key discovery from environment variables and shuvcode's integration database.
 * Depends on: lib/constants.js
 */

import { existsSync } from "node:fs";
import { SYNTHETIC_INTEGRATION_DB_PATH } from "./constants.js";

/**
 * Normalize a Synthetic credential into an account record.
 * @param {unknown} raw
 * @param {{ label?: string, source?: string, credentialId?: string }} [metadata]
 * @returns {object | null}
 */
export function normalizeSyntheticAccount(raw, metadata = {}) {
	let value = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			value = { key: raw };
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const apiKey = value.apiKey ?? value.api_key ?? value.key ?? value.token;
	if (typeof apiKey !== "string" || !apiKey.trim()) return null;
	const label = metadata.label ?? value.label ?? "synthetic";
	return {
		label: typeof label === "string" && label.trim() ? label.trim() : "synthetic",
		apiKey: apiKey.trim(),
		source: metadata.source ?? "env",
		credentialId: metadata.credentialId ?? null,
	};
}

/**
 * Load Synthetic accounts from SYNTHETIC_API_KEY and SYNTHETIC_ACCOUNTS.
 * @returns {object[]}
 */
export function loadSyntheticAccountsFromEnv() {
	const accounts = [];
	if (process.env.SYNTHETIC_API_KEY) {
		const account = normalizeSyntheticAccount(process.env.SYNTHETIC_API_KEY, {
			label: process.env.SYNTHETIC_LABEL || "synthetic",
			source: "env:SYNTHETIC_API_KEY",
		});
		if (account) accounts.push(account);
	}

	if (process.env.SYNTHETIC_ACCOUNTS) {
		try {
			const parsed = JSON.parse(process.env.SYNTHETIC_ACCOUNTS);
			const entries = Array.isArray(parsed) ? parsed : parsed?.accounts ?? [];
			for (const [index, entry] of entries.entries()) {
				const account = normalizeSyntheticAccount(entry, {
					label: entry?.label ?? `synthetic-${index + 1}`,
					source: "env:SYNTHETIC_ACCOUNTS",
				});
				if (account) accounts.push(account);
			}
		} catch {
			console.error("Warning: SYNTHETIC_ACCOUNTS env var is not valid JSON");
		}
	}
	return accounts;
}

/**
 * @param {{ DatabaseSync?: Function }} [options]
 * @returns {Promise<Function | null>}
 */
async function resolveDatabaseSync(options = {}) {
	if (options.DatabaseSync) return options.DatabaseSync;
	try {
		const sqlite = await import("node:sqlite");
		return sqlite.DatabaseSync;
	} catch {
		return null;
	}
}

/**
 * @param {unknown} source
 * @returns {boolean}
 */
export function isSyntheticEnvSource(source) {
	return typeof source === "string" && source.startsWith("env:");
}

/**
 * Resolve the integration-v2 database path used for Synthetic credentials.
 * @param {string} [filePath]
 * @returns {string}
 */
export function resolveSyntheticIntegrationDbPath(filePath) {
	return filePath
		?? process.env.SYNTHETIC_INTEGRATION_DB_PATH
		?? SYNTHETIC_INTEGRATION_DB_PATH;
}

/**
 * Load Synthetic credentials from shuvcode's integration-v2 SQLite database.
 * Node versions without node:sqlite return an empty list so the Node 18 CLI remains usable.
 * @param {string} [filePath]
 * @param {{ DatabaseSync?: Function }} [options]
 * @returns {Promise<object[]>}
 */
export async function loadSyntheticAccountsFromIntegrationDb(
	filePath = resolveSyntheticIntegrationDbPath(),
	options = {},
) {
	if (!filePath || !existsSync(filePath)) return [];
	const DatabaseSync = await resolveDatabaseSync(options);
	if (!DatabaseSync) return [];

	let database;
	try {
		database = new DatabaseSync(filePath, { readOnly: true });
		const rows = database.prepare(`
			SELECT id, label, value
			FROM credential
			WHERE integration_id = ?
			ORDER BY active DESC NULLS LAST, time_updated DESC
		`).all("synthetic");
		return rows.flatMap(row => {
			const account = normalizeSyntheticAccount(row.value, {
				label: row.label || "synthetic",
				source: filePath,
				credentialId: row.id,
			});
			return account ? [account] : [];
		});
	} catch {
		return [];
	} finally {
		try {
			database?.close();
		} catch {
			// Ignore close failures on an optional credential source.
		}
	}
}

/**
 * Delete one Synthetic credential from the integration-v2 SQLite database.
 * The DELETE is constrained to integration_id = 'synthetic' so other providers are untouched.
 * @param {string} credentialId
 * @param {{ dbPath?: string, DatabaseSync?: Function }} [options]
 * @returns {Promise<{ ok: boolean, deleted?: number, path?: string, error?: string }>}
 */
export async function removeSyntheticAccountFromIntegrationDb(credentialId, options = {}) {
	if (typeof credentialId !== "string" || !credentialId.trim()) {
		return { ok: false, error: "Missing credential id" };
	}
	const filePath = resolveSyntheticIntegrationDbPath(options.dbPath);
	if (!filePath || !existsSync(filePath)) {
		return { ok: false, error: "Integration database not found" };
	}
	const DatabaseSync = await resolveDatabaseSync(options);
	if (!DatabaseSync) {
		return { ok: false, error: "SQLite is not available in this Node.js build" };
	}

	let database;
	try {
		database = new DatabaseSync(filePath, { timeout: 5000 });
		const result = database.prepare(`
			DELETE FROM credential
			WHERE id = ? AND integration_id = 'synthetic'
		`).run(credentialId.trim());
		const deleted = Number(result?.changes ?? 0);
		if (!deleted) {
			return { ok: false, error: "Synthetic credential not found in the integration database", path: filePath };
		}
		return { ok: true, deleted, path: filePath };
	} catch (error) {
		return { ok: false, error: error?.message ?? String(error), path: filePath };
	} finally {
		try {
			database?.close();
		} catch {
			// Ignore close failures after a delete attempt.
		}
	}
}

/**
 * Load and deduplicate all Synthetic accounts. Environment entries take precedence.
 * @param {{ includeEnv?: boolean, dbPath?: string, DatabaseSync?: Function }} [options]
 * @returns {Promise<object[]>}
 */
export async function loadAllSyntheticAccounts(options = {}) {
	const accounts = options.includeEnv === false ? [] : loadSyntheticAccountsFromEnv();
	accounts.push(...await loadSyntheticAccountsFromIntegrationDb(
		resolveSyntheticIntegrationDbPath(options.dbPath),
		{ DatabaseSync: options.DatabaseSync },
	));
	const byKey = new Map();
	for (const account of accounts) {
		if (!byKey.has(account.apiKey)) byKey.set(account.apiKey, account);
	}
	return [...byKey.values()];
}

/**
 * Locations searched for Synthetic credentials.
 * @returns {string[]}
 */
export function getSyntheticSearchLocations() {
	return [
		"SYNTHETIC_API_KEY env var",
		"SYNTHETIC_ACCOUNTS env var",
		resolveSyntheticIntegrationDbPath(),
	];
}
