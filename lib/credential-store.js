/**
 * Generic shuvquota-owned managed credential store.
 * Depends on: lib/container.js, lib/token-match.js
 *
 * Owns exactly four canonical, shuvquota-managed containers:
 *   ~/.codex-accounts.json, ~/.claude-accounts.json,
 *   ~/.grok-accounts.json, ~/.antigravity-accounts.json
 *
 * Contract:
 *  - Atomic add / replace (reauth) / rename / remove / list / token update.
 *  - `activeLabel` is always dropped on every write.
 *  - Unknown root fields are preserved; writes are mode 0600.
 *  - Rows written by this module carry `enrollment: "independent"`. Rows
 *    without that marker (pre-v2 imports) are not shuvquota's: every read
 *    ignores them and the next write drops them. Re-adding the account is
 *    the only way back.
 *  - No harness-auth write function is exposed here. Callers (provider
 *    adapters) are responsible for deciding *whether* a row may be refreshed;
 *    this module only guarantees that once asked to write, it writes safely.
 */

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readMultiAccountContainer, writeMultiAccountContainer } from "./container.js";
import {
	normalizeEntryTokens,
	updateEntryTokens,
	OPENAI_TOKEN_FIELDS,
	CLAUDE_TOKEN_FIELDS,
	XAI_TOKEN_FIELDS,
	ANTIGRAVITY_TOKEN_FIELDS,
} from "./token-match.js";

/** Canonical managed-store filenames, keyed by provider id. */
export const MANAGED_STORE_FILENAMES = Object.freeze({
	codex: ".codex-accounts.json",
	claude: ".claude-accounts.json",
	grok: ".grok-accounts.json",
	antigravity: ".antigravity-accounts.json",
});

/** Canonical token field maps reused for compare-and-swap + read/update. */
const TOKEN_FIELD_MAPS = Object.freeze({
	codex: OPENAI_TOKEN_FIELDS,
	claude: CLAUDE_TOKEN_FIELDS,
	grok: XAI_TOKEN_FIELDS,
	antigravity: ANTIGRAVITY_TOKEN_FIELDS,
});

export const ENROLLMENT_INDEPENDENT = "independent";

/**
 * @param {string} providerId
 */
function assertProvider(providerId) {
	if (!Object.hasOwn(MANAGED_STORE_FILENAMES, providerId)) {
		throw new Error(`Unknown provider for credential store: ${providerId}`);
	}
}

/**
 * Resolve the single canonical managed-store path for a provider.
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {{ home?: string }} [options] - Inject a home directory (tests).
 * @returns {string}
 */
export function getManagedStorePath(providerId, options = {}) {
	assertProvider(providerId);
	const home = options.home ?? homedir();
	return join(home, MANAGED_STORE_FILENAMES[providerId]);
}

/**
 * @param {string} providerId
 * @returns {Record<string, string[]>}
 */
function tokenFieldsFor(providerId) {
	return TOKEN_FIELD_MAPS[providerId] ?? {};
}

/**
 * Read the store, keeping only labelled, independently enrolled rows.
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {{ home?: string }} [options]
 * @returns {ReturnType<typeof readMultiAccountContainer>}
 */
function readContainer(providerId, options = {}) {
	assertProvider(providerId);
	const container = readMultiAccountContainer(getManagedStorePath(providerId, options));
	return { ...container, accounts: container.accounts.filter(isIndependentlyEnrolled) };
}

/**
 * Refuse to treat an unparsable existing file as an empty store. Without this
 * guard, every write path below would silently replace a corrupted-but-maybe-
 * recoverable file with a single fresh entry the moment any mutation ran.
 * A missing file (`rootType: "missing"`) is fine — that is a legitimate empty
 * store, not data loss.
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {ReturnType<typeof readMultiAccountContainer>} container
 * @param {{ home?: string }} [options]
 */
function assertWritableContainer(providerId, container, options = {}) {
	if (container.rootType === "invalid") {
		throw new Error(
			`Refusing to modify ${providerId} store at ${getManagedStorePath(providerId, options)}: `
			+ "existing file is not valid JSON. Fix or remove it by hand before retrying.",
		);
	}
}

/**
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {{ home?: string }} [options]
 * @returns {ReturnType<typeof readMultiAccountContainer>}
 */
function readWritableContainer(providerId, options = {}) {
	const container = readContainer(providerId, options);
	assertWritableContainer(providerId, container, options);
	return container;
}

/**
 * Write owned accounts back to the managed store. `activeLabel` and rows that
 * `readContainer` ignored are dropped.
 * @param {string} providerId
 * @param {ReturnType<typeof readMultiAccountContainer>} container
 * @param {unknown[]} accounts
 * @param {{ home?: string }} [options]
 */
function writeAccounts(providerId, container, accounts, options = {}) {
	const path = getManagedStorePath(providerId, options);
	return writeMultiAccountContainer(path, container, accounts, {}, { mode: 0o600 });
}

/**
 * A row is shuvquota's only when this module stamped it during
 * `addManagedAccount`/`replaceManagedAccount`. A physical location inside the
 * canonical file is not itself evidence of ownership.
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isIndependentlyEnrolled(entry) {
	return Boolean(entry && typeof entry === "object" && typeof entry.label === "string" && entry.label
		&& entry.enrollment === ENROLLMENT_INDEPENDENT);
}

/**
 * List every owned row in the managed store. Never throws; a missing or
 * invalid file yields an empty list.
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {{ home?: string }} [options]
 * @returns {Array<{ label: string, raw: Record<string, unknown> }>}
 */
export function listManagedAccounts(providerId, options = {}) {
	let container;
	try {
		container = readContainer(providerId, options);
	} catch {
		return [];
	}
	if (container.rootType === "invalid") return [];
	return container.accounts.map(entry => ({ label: entry.label, raw: entry }));
}

/**
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {string} label
 * @param {{ home?: string }} [options]
 * @returns {{ entry: Record<string, unknown>, container: ReturnType<typeof readMultiAccountContainer> } | null}
 */
export function findManagedAccount(providerId, label, options = {}) {
	const container = readContainer(providerId, options);
	const entry = container.accounts.find(a => a.label === label);
	return entry ? { entry, container } : null;
}

/**
 * Atomically add a brand-new, independently-enrolled managed credential.
 * Fails if the label already exists (use `replaceManagedAccount` for reauth).
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {Record<string, unknown>} entry - Must include `label`.
 * @param {{ home?: string }} [options]
 * @returns {{ path: string, entry: Record<string, unknown> }}
 */
export function addManagedAccount(providerId, entry, options = {}) {
	if (typeof entry?.label !== "string" || !entry.label.trim() || /[\x00-\x1f\x7f]/.test(entry.label)) {
		throw new Error("addManagedAccount requires a string label");
	}
	const container = readWritableContainer(providerId, options);
	if (container.accounts.some(a => a.label === entry.label)) {
		throw new Error(`Account '${entry.label}' already exists for ${providerId}`);
	}
	const record = { ...entry, enrollment: ENROLLMENT_INDEPENDENT };
	const accounts = [...container.accounts, record];
	const { path } = writeAccounts(providerId, container, accounts, options);
	return { path, entry: record };
}

/**
 * Replace an existing row's credential material end-to-end (reauth). Always
 * re-stamps the row as independently enrolled, since the caller just
 * completed a fresh login for this label.
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {string} label
 * @param {Record<string, unknown>} entry - New credential fields (label optional; forced to `label`).
 * @param {{ home?: string }} [options]
 * @returns {{ path: string, entry: Record<string, unknown> }}
 */
export function replaceManagedAccount(providerId, label, entry, options = {}) {
	const container = readWritableContainer(providerId, options);
	const index = container.accounts.findIndex(a => a.label === label);
	if (index < 0) {
		throw new Error(`Account '${label}' not found for ${providerId}`);
	}
	const record = { ...entry, label, enrollment: ENROLLMENT_INDEPENDENT };
	const accounts = [...container.accounts];
	accounts[index] = record;
	const { path } = writeAccounts(providerId, container, accounts, options);
	return { path, entry: record };
}

/**
 * Rename a managed row.
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {string} oldLabel
 * @param {string} newLabel
 * @param {{ home?: string }} [options]
 * @returns {{ path: string, entry: Record<string, unknown> }}
 */
export function renameManagedAccount(providerId, oldLabel, newLabel, options = {}) {
	if (typeof newLabel !== "string" || !newLabel.trim() || /[\x00-\x1f\x7f]/.test(newLabel)) {
		throw new Error("renameManagedAccount requires a new label");
	}
	const container = readWritableContainer(providerId, options);
	if (container.accounts.some(a => a.label === newLabel)) {
		throw new Error(`Account '${newLabel}' already exists for ${providerId}`);
	}
	const index = container.accounts.findIndex(a => a.label === oldLabel);
	if (index < 0) {
		throw new Error(`Account '${oldLabel}' not found for ${providerId}`);
	}
	const accounts = [...container.accounts];
	accounts[index] = { ...accounts[index], label: newLabel };
	const { path } = writeAccounts(providerId, container, accounts, options);
	return { path, entry: accounts[index] };
}

/**
 * Remove a managed row (idempotent — returns removed:false when absent).
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {string} label
 * @param {{ home?: string }} [options]
 * @returns {{ path: string, removed: boolean }}
 */
export function removeManagedAccount(providerId, label, options = {}) {
	const container = readWritableContainer(providerId, options);
	const index = container.accounts.findIndex(a => a.label === label);
	if (index < 0) {
		return { path: getManagedStorePath(providerId, options), removed: false };
	}
	const accounts = container.accounts.filter((_, i) => i !== index);
	const { path } = writeAccounts(providerId, container, accounts, options);
	return { path, removed: true };
}

/**
 * Compare-and-swap token rotation. Rereads the store fresh (callers should
 * invoke this from inside `withManagedAccountLock`) and refuses to overwrite a row whose
 * on-disk tokens no longer match the pre-refresh values the caller started
 * from (another in-process refresh already landed — the caller should adopt
 * the value already on disk instead of clobbering it).
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {string} label
 * @param {Record<string, unknown>} tokens - New canonical field values (access/refresh/expires/...).
 * @param {{ previousAccess?: string | null, previousRefresh?: string | null }} [expected]
 * @param {{ home?: string, harnessRefreshTokens?: Array<string | null | undefined>, harnessAccessTokens?: Array<string | null | undefined> }} [options]
 *   `harnessRefreshTokens`/`harnessAccessTokens` are an optional, caller-supplied snapshot of tokens
 *   currently visible in read-only harness stores (Codex CLI auth.json, OpenCode, pi, Hermes, …).
 *   When the row's *current* on-disk refresh (or access) token coincides with one of these, rotation
 *   is refused even if the row is stamped `enrollment: "independent"` — a coincident harness token
 *   means this row was seeded from (or is still shared with) a live external session, and rotating it
 *   would silently invalidate that harness's session. This is a belt-and-suspenders check in addition
 *   to the enrollment marker, not a replacement for it.
 * @returns {{ updated: boolean, skipped: boolean, reason?: string, path?: string, entry?: Record<string, unknown> }}
 */
export function updateManagedAccountTokens(providerId, label, tokens, expected = {}, options = {}) {
	const container = readWritableContainer(providerId, options);
	const index = container.accounts.findIndex(a => a.label === label);
	if (index < 0) {
		return { updated: false, skipped: false, reason: "not-found" };
	}
	const entry = container.accounts[index];
	const fields = tokenFieldsFor(providerId);
	const stored = normalizeEntryTokens(entry, fields);

	const harnessRefresh = new Set((options.harnessRefreshTokens ?? []).filter(Boolean));
	const harnessAccess = new Set((options.harnessAccessTokens ?? []).filter(Boolean));
	if ((stored.refresh && harnessRefresh.has(stored.refresh)) || (stored.access && harnessAccess.has(stored.access))) {
		return { updated: false, skipped: true, reason: "coincident-harness-token", entry };
	}

	const expectedAccess = expected.previousAccess ?? null;
	const expectedRefresh = expected.previousRefresh ?? null;
	if (expectedAccess != null || expectedRefresh != null) {
		const refreshMatches = expectedRefresh != null && stored.refresh === expectedRefresh;
		const accessMatches = expectedAccess != null && stored.access === expectedAccess;
		if (!(expectedRefresh != null ? refreshMatches : accessMatches)) {
			return { updated: false, skipped: true, reason: "stale", entry };
		}
	}
	const updatedEntry = updateEntryTokens({ ...entry }, tokens, fields);
	const accounts = [...container.accounts];
	accounts[index] = updatedEntry;
	const { path } = writeAccounts(providerId, container, accounts, options);
	return { updated: true, skipped: false, path, entry: updatedEntry };
}

/**
 * Fan-out compare-and-swap rotation: update every independently-enrolled
 * managed row for this provider whose *current* on-disk refresh (or access)
 * token matches `expected.previousRefresh`/`expected.previousAccess` — not
 * just a single named label.
 *
 * xAI rotates its refresh token on every exchange. If the same underlying
 * session was independently enrolled under two labels (e.g. re-added after a
 * rename, or imported twice), only one exchange happens per rotation; every
 * managed row that shared the pre-rotation refresh token must move to the new
 * one together, or the other row is left holding a token the server has
 * already invalidated. External harness stores (pi, OpenCode, Hermes, …) are
 * never a fan-out target here — only rows inside this provider's own managed
 * container are touched. Provider adapters must never write harness stores.
 * @param {"codex"|"claude"|"grok"|"antigravity"} providerId
 * @param {Record<string, unknown>} tokens - New canonical field values.
 * @param {{ previousAccess?: string | null, previousRefresh?: string | null }} [expected]
 * @param {{ home?: string, harnessRefreshTokens?: Array<string | null | undefined>, harnessAccessTokens?: Array<string | null | undefined> }} [options]
 * @returns {{ updatedLabels: string[], skipped: Array<{ label: string, reason: string }>, path: string }}
 */
export function fanOutManagedAccountTokens(providerId, tokens, expected = {}, options = {}) {
	const container = readWritableContainer(providerId, options);
	const fields = tokenFieldsFor(providerId);
	const expectedRefresh = expected.previousRefresh ?? null;
	const expectedAccess = expected.previousAccess ?? null;
	const harnessRefresh = new Set((options.harnessRefreshTokens ?? []).filter(Boolean));
	const harnessAccess = new Set((options.harnessAccessTokens ?? []).filter(Boolean));

	const updatedLabels = [];
	const skipped = [];
	let changed = false;
	const accounts = container.accounts.map(entry => {
		const stored = normalizeEntryTokens(entry, fields);
		const refreshMatches = expectedRefresh != null && stored.refresh === expectedRefresh;
		const accessMatches = expectedAccess != null && stored.access === expectedAccess;
		if (!(expectedRefresh != null ? refreshMatches : accessMatches)) return entry;
		if ((stored.refresh && harnessRefresh.has(stored.refresh)) || (stored.access && harnessAccess.has(stored.access))) {
			skipped.push({ label: entry.label, reason: "coincident-harness-token" });
			return entry;
		}
		changed = true;
		updatedLabels.push(entry.label);
		return updateEntryTokens({ ...entry }, tokens, fields);
	});
	if (!changed) {
		return { updatedLabels, skipped, path: getManagedStorePath(providerId, options) };
	}
	const { path } = writeAccounts(providerId, container, accounts, options);
	return { updatedLabels, skipped, path };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per credential+provider serialized refresh
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, Promise<unknown>>} */
const refreshLocks = new Map();

/**
 * Serialize an async operation by provider+stored credential identity. Concurrent calls
 * for the same credential run one at a time, in call order; calls for
 * different credentials (or different providers) run independently. This
 * protects rotation both within one parallel scan and across overlapping
 * scans in a single process.
 * @template T
 * @param {string} providerId
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {{ home?: string }} [options]
 * @returns {Promise<T>}
 */
export function withManagedAccountLock(providerId, label, fn, options = {}) {
	const entry = findManagedAccount(providerId, label, options)?.entry;
	const tokens = normalizeEntryTokens(entry ?? {}, tokenFieldsFor(providerId));
	const identity = tokens.refresh ?? tokens.access ?? `label:${label}`;
	const digest = createHash("sha256").update(identity).digest("hex");
	const key = `${getManagedStorePath(providerId, options)}::${digest}`;
	const previous = refreshLocks.get(key) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	const tail = run.then(() => undefined, () => undefined);
	refreshLocks.set(key, tail);
	tail.then(() => {
		if (refreshLocks.get(key) === tail) refreshLocks.delete(key);
	});
	return run;
}
