/**
 * Shared v2 quota snapshot model (`schemaVersion: 2`).
 * Depends on: lib/plans.js
 *
 * Normalization is constructive: every DTO is rebuilt field by field from an
 * allowlist, so unknown provider fields, credentials, account IDs, and
 * filesystem paths can never reach a snapshot by omission. Internal snapshots
 * may retain a full email for terminal rendering; `toPublicSnapshot` masks the
 * email and redacts every other free-text field, including errors, plans,
 * labels, window details, and extras.
 */

import {
	formatClaudePlanLabel,
	formatCodexPlanLabel,
	formatGrokPlanLabel,
} from "./plans.js";

export const SNAPSHOT_SCHEMA_VERSION = 2;

/** Fixed provider display order. Unknown providers keep input order after these. */
export const PROVIDER_ORDER = Object.freeze(["codex", "claude", "grok", "antigravity", "cursor"]);

const PROVIDER_NAMES = Object.freeze({
	codex: "Codex",
	claude: "Claude",
	grok: "SuperGrok",
	antigravity: "Antigravity",
	cursor: "Cursor",
});

/**
 * The only statuses a v2 account may carry. Severity is deliberately absent:
 * a low window is still `ok`, and colour/urgency is computed downstream from
 * `percentRemaining` (plan §3.3 thresholds, migrated in Phase 6).
 */
export const ACCOUNT_STATUSES = Object.freeze(["loading", "ok", "error"]);

/** Shown when a fetch succeeded but carried no window we could parse. */
const NO_DATA_ERROR = "Quota data unavailable";

// ─────────────────────────────────────────────────────────────────────────────
// Primitive coercion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? /** @type {Record<string, unknown>} */ (value)
		: null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numberValue(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function clampPercent(value) {
	const parsed = numberValue(value);
	if (parsed === null) return null;
	return Math.min(100, Math.max(0, parsed));
}

/**
 * Claude historically returned ratios for non-integer values below one.
 * @param {unknown} value
 * @returns {number | null}
 */
function clampClaudePercent(value) {
	let parsed = numberValue(value);
	if (parsed === null) return null;
	if (parsed > 0 && parsed < 1) parsed *= 100;
	return Math.min(100, Math.max(0, parsed));
}

/**
 * Convert untrusted display text into a short, control-free string.
 * @param {unknown} value
 * @param {number} [maxLength=80]
 * @param {Set<string> | Array<string> | null} [secrets=null]
 * @returns {string | null}
 */
export function sanitizeText(value, maxLength = 80, secrets = null) {
	const scrubbed = secrets ? scrubSecrets(value, secrets) : value;
	if (typeof scrubbed !== "string") return null;
	const text = scrubbed
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/[<>&]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength);
	return text || null;
}

/**
 * Mask an email while keeping enough of its domain to distinguish accounts.
 * Values that are not plausibly an address are dropped rather than reflected.
 * @param {unknown} value
 * @returns {string | null}
 */
export function maskEmail(value) {
	const email = sanitizeText(value, 254);
	if (!email) return null;
	const at = email.lastIndexOf("@");
	if (at <= 0 || at === email.length - 1) return null;
	const local = email.slice(0, at).trim();
	const domain = email.slice(at + 1).trim().toLowerCase();
	if (!local || !/^[a-z0-9.-]+$/i.test(domain) || !domain.includes(".")) return null;
	return `${local.charAt(0)}***@${domain}`;
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SENSITIVE_KEY_RE = /^(access_?token|refresh_?token|oauth_?token|oauth_?refresh_?token|id_?token|token|tokens|api_?key|secret|client_?secret|password|account_?id|org(anization)?_?id|credentials_?path|config_?path|location|access|refresh)$/i;

const IGNORED_SECRET_WORDS = new Set([
	"[redacted]", "null", "undefined", "true", "false",
	"remote", "local", "default", "none", "unknown",
	"read", "write", "admin", "user",
]);

function isSensitiveKey(key) {
	if (typeof key !== "string") return false;
	if (SENSITIVE_KEY_RE.test(key)) return true;
	if (/.*(token|secret|api_?key)$/i.test(key) && !/^(token_?count|token_?usage|total_?tokens)$/i.test(key)) {
		return true;
	}
	return false;
}

function isValidSecretValue(value) {
	if (typeof value !== "string") return false;
	const str = String(value).trim();
	if (str.length < 3) return false;
	if (IGNORED_SECRET_WORDS.has(str.toLowerCase())) return false;
	// Do not treat emails as secrets (email display is preserved/handled separately)
	if (str.includes("@") && str.includes(".")) return false;
	return true;
}

/**
 * Collect known sensitive values (tokens, credentials, account IDs, paths)
 * from raw context objects with bounded traversal.
 * @param {...unknown} sources
 * @returns {Set<string>}
 */
export function collectKnownSecrets(...sources) {
	const secrets = new Set();
	const seen = new Set();
	let nodeCount = 0;

	function walk(obj, depth, isParentSensitive = false) {
		if (!obj || typeof obj !== "object" || depth > 5 || nodeCount > 250) return;
		if (seen.has(obj)) return;
		seen.add(obj);

		if (Array.isArray(obj)) {
			for (const item of obj) {
				nodeCount++;
				if (nodeCount > 250) break;
				if (typeof item === "string" || typeof item === "number") {
					if (isParentSensitive && isValidSecretValue(item)) {
						secrets.add(String(item).trim());
					}
				} else if (item && typeof item === "object") {
					walk(item, depth + 1, isParentSensitive);
				}
			}
			return;
		}

		for (const [key, value] of Object.entries(obj)) {
			nodeCount++;
			if (nodeCount > 250) break;
			const sensitive = isSensitiveKey(key);
			if (typeof value === "string" || typeof value === "number") {
				if (sensitive && isValidSecretValue(value)) {
					secrets.add(String(value).trim());
				}
			} else if (value && typeof value === "object") {
				walk(value, depth + 1, sensitive);
			}
		}
	}

	for (const source of sources) {
		if (source instanceof Set) {
			for (const item of source) {
				if (isValidSecretValue(item)) secrets.add(String(item).trim());
			}
		} else if (source && typeof source === "object") {
			walk(source, 0, false);
		}
	}

	return secrets;
}

/**
 * Scrub known secrets from free text.
 * @param {unknown} value
 * @param {Set<string> | Array<string> | null | undefined} secrets
 * @returns {string | null}
 */
export function scrubSecrets(value, secrets) {
	if (typeof value !== "string" || !value) return typeof value === "string" ? value : null;
	if (!secrets) return value;
	const list = secrets instanceof Set || Array.isArray(secrets) ? Array.from(secrets) : [];
	const items = list.filter(s => typeof s === "string" && s.trim().length >= 3 && s !== "[redacted]");
	if (items.length === 0) return value;

	items.sort((a, b) => b.length - a.length);

	let out = value;
	for (const secret of items) {
		const pattern = new RegExp(escapeRegExp(secret), "gi");
		out = out.replace(pattern, "[redacted]");
	}
	out = out.replace(/(\[redacted\]\s*)+/gi, "[redacted] ").trim();
	if (out === "[redacted]") return "[redacted]";
	return out;
}

/** Scrub raw context before allowlisting/truncation discards the evidence. */
function scrubContext(value, inherited = collectKnownSecrets(value)) {
	const seen = new Set();
	let remaining = 10_000;
	function visit(item, secrets, depth) {
		if (typeof item === "string") return scrubSecrets(item, secrets);
		if (!item || typeof item !== "object") return item;
		if (item instanceof Date) return item;
		if (item instanceof Error) return new Error(scrubSecrets(item.message, secrets));
		if (depth > 12 || remaining-- <= 0 || seen.has(item)) return null;
		seen.add(item);
		const local = collectKnownSecrets(secrets, item);
		const output = Array.isArray(item)
			? item.map(child => visit(child, local, depth + 1))
			: Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, local, depth + 1)]));
		seen.delete(item);
		return output;
	}
	return visit(value, inherited, 0);
}

const REDACTION_PATTERNS = Object.freeze([
	/[a-z][a-z0-9+.-]*:\/\/\S+/gi,                                        // URLs
	/[a-z]:\\[^\s]*/gi,                                                    // Windows paths
	/(?:~|\.{1,2})?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\/?/g,           // POSIX paths
	/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,        // JWTs
	/[^\s@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,                               // emails
	/\b[A-Za-z0-9_-]{24,}\b/g,                                             // opaque tokens
]);

/**
 * Sanitize free text and strip anything that could carry identity or secrets:
 * URLs, filesystem paths, JWTs, email addresses, and long opaque tokens.
 * @param {unknown} value
 * @param {number} [maxLength=80]
 * @param {Set<string> | Array<string> | null} [secrets=null]
 * @returns {string | null}
 */
export function redactPublicText(value, maxLength = 80, secrets = null) {
	const text = sanitizeText(value, 1024, secrets);
	if (!text) return null;
	let out = text;
	for (const pattern of REDACTION_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	out = out.replace(/(\[redacted\]\s*)+/g, "[redacted] ").replace(/\s+/g, " ").trim();
	if (out === "[redacted]") return "[redacted]";
	return out.slice(0, maxLength).trim() || null;
}

/**
 * Collapse any error into a small set of browser-safe categories.
 * @param {unknown} error
 * @returns {string | null}
 */
export function safePublicError(error) {
	const message = typeof error === "string" ? error : "";
	if (!message) return null;
	if (message === "This Grok session lacks Code CLI access") return message;
	const rateLimit = message.match(/^Rate limited; retry in (\d+) seconds$/);
	if (rateLimit) return `Rate limited; retry in ${rateLimit[1]} seconds`;
	const enrollment = message.match(/\bcq (codex|claude|grok|antigravity) (add|reauth)\b/);
	if (enrollment) return `Authentication required; run cq ${enrollment[1]} ${enrollment[2]}`;
	if (/timeout|timed out|abort/i.test(message)) return "Quota request timed out";
	if (/401|403|auth|token|login|session|credential/i.test(message)) return "Authentication required";
	if (/no accounts?|not found/i.test(message)) return "No accounts found";
	const http = message.match(/http\s+(\d{3})/i);
	if (http) return `Quota service returned HTTP ${http[1]}`;
	return "Quota data unavailable";
}

/**
 * Internal error text: keeps the message specific enough to act on, but strips
 * paths, tokens, URLs, and addresses so no snapshot ever carries them.
 * @param {unknown} error
 * @param {Set<string> | Array<string> | null} [secrets=null]
 * @returns {string | null}
 */
export function sanitizeErrorText(error, secrets = null) {
	if (error === null || error === undefined) return null;
	const message = typeof error === "string"
		? error
		: (error instanceof Error ? error.message : String(error));
	return redactPublicText(message, 200, secrets);
}

/**
 * @param {unknown} value
 * @returns {Date}
 */
function resolveDate(value) {
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	if (typeof value === "string" || typeof value === "number") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	return new Date();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function isoOrNull(value) {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.toISOString();
	}
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Stable ISO timestamp from ISO text, epoch seconds/milliseconds, or a relative
 * number of seconds from `now`.
 * @param {unknown} value
 * @param {Date} now
 * @param {boolean} [relative=false]
 * @returns {string | null}
 */
function isoTimestamp(value, now, relative = false) {
	const numeric = numberValue(value);
	let date;
	if (numeric !== null) {
		date = relative
			? new Date(now.getTime() + numeric * 1000)
			: new Date(Math.abs(numeric) >= 1e12 ? numeric : numeric * 1000);
	} else if (typeof value === "string" && value.trim()) {
		date = new Date(value);
	} else {
		return null;
	}
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function slug(value) {
	const text = typeof value === "string" ? value : String(value ?? "");
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
		|| "limit";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function humanize(value) {
	const text = sanitizeText(value, 60);
	if (!text) return "Additional limit";
	return text.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Window normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Record<string, unknown>} window
 * @param {Date} now
 * @param {{ claude?: boolean, defaultWindowSeconds?: number | null }} [options]
 * @returns {{ percentUsed: number, percentRemaining: number, resetsAt: string | null, windowSeconds: number | null } | null}
 */
export function normalizeWindowValues(window, now, options = {}) {
	const source = objectValue(window);
	if (!source) return null;
	const at = resolveDate(now);
	const percentFn = options.claude ? clampClaudePercent : clampPercent;
	let percentUsed = percentFn(
		source.used_percent ?? source.usedPercent ?? source.percent_used
			?? source.percentUsed ?? source.usagePercent ?? source.percent ?? source.utilization,
	);
	let percentRemaining = percentFn(
		source.remaining_percent ?? source.remainingPercent
			?? source.percent_remaining ?? source.percentRemaining,
	);
	if (percentUsed === null && percentRemaining !== null) percentUsed = 100 - percentRemaining;
	if (percentRemaining === null && percentUsed !== null) percentRemaining = 100 - percentUsed;
	if (percentUsed === null || percentRemaining === null) return null;

	const resetAbsolute = source.reset_at ?? source.resetAt ?? source.resets_at ?? source.resetsAt;
	const resetRelative = source.reset_after_seconds ?? source.resetAfterSeconds ?? source.resetInSec;
	const resetsAt = isoTimestamp(resetAbsolute, at) ?? isoTimestamp(resetRelative, at, true);
	const parsedWindowSeconds = numberValue(
		source.limit_window_seconds ?? source.limitWindowSeconds
			?? source.window_seconds ?? source.windowSeconds,
	);
	const windowSeconds = parsedWindowSeconds !== null && parsedWindowSeconds >= 0
		? parsedWindowSeconds
		: options.defaultWindowSeconds ?? null;
	return {
		percentUsed: clampPercent(percentUsed),
		percentRemaining: clampPercent(percentRemaining),
		resetsAt,
		windowSeconds,
	};
}

/**
 * @param {Array<object>} windows
 * @param {Set<string>} seen
 * @param {string} id
 * @param {string} label
 * @param {unknown} rawWindow
 * @param {Date} now
 * @param {{ claude?: boolean, defaultWindowSeconds?: number | null, detail?: unknown }} [options]
 */
function addWindow(windows, seen, id, label, rawWindow, now, options = {}) {
	if (!rawWindow || seen.has(id)) return;
	const values = normalizeWindowValues(rawWindow, now, options);
	if (!values) return;
	seen.add(id);
	const window = { id, label, ...values };
	const detail = redactPublicText(options.detail, 60);
	if (detail) window.detail = detail;
	windows.push(window);
}

/**
 * Rebuild a window from an allowlist. Used on provider-supplied normalizer
 * output so injected adapters cannot smuggle extra fields into a snapshot.
 * @param {unknown} value
 * @param {number} index
 * @returns {object | null}
 */
function coerceWindow(value, index, secrets = null) {
	const record = objectValue(value);
	if (!record) return null;
	let percentRemaining = clampPercent(record.percentRemaining);
	let percentUsed = clampPercent(record.percentUsed);
	if (percentRemaining === null && percentUsed !== null) percentRemaining = 100 - percentUsed;
	if (percentUsed === null && percentRemaining !== null) percentUsed = 100 - percentRemaining;
	const windowSeconds = numberValue(record.windowSeconds);
	const window = {
		id: slug(record.id ?? `limit-${index + 1}`),
		label: redactPublicText(record.label, 40, secrets) ?? "Limit",
		percentRemaining,
		percentUsed,
		resetsAt: isoOrNull(record.resetsAt),
		windowSeconds: windowSeconds !== null && windowSeconds >= 0 ? windowSeconds : null,
	};
	const detail = redactPublicText(record.detail, 60, secrets);
	if (detail) window.detail = detail;
	return window;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {Set<string> | Array<string> | null} [secrets=null]
 * @returns {{ id: string, label: string, value: string } | null}
 */
function coerceExtra(value, index, secrets = null) {
	const record = objectValue(value);
	if (!record) return null;
	const label = redactPublicText(record.label, 40, secrets);
	const text = redactPublicText(
		typeof record.value === "number" ? String(record.value) : record.value,
		60,
		secrets,
	);
	if (!label || !text) return null;
	return { id: slug(record.id ?? label ?? `extra-${index + 1}`), label, value: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Account snapshot construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the pair (status, error) for a finished account.
 *
 * A low window is still `ok`: severity is a rendering concern computed from
 * `percentRemaining`, not a status. A soft failure that still produced windows
 * also stays `ok` and keeps its message, so a partially degraded account is
 * not reported as a dead one. A fetch that produced no parseable window is an
 * error with a safe, generic message — there is nothing to show.
 * @param {{ error?: string | null, hardError?: boolean, windows?: Array<object> }} input
 * @returns {{ status: "ok" | "error", error: string | null }}
 */
function resolveAccountState(input) {
	const windows = Array.isArray(input.windows) ? input.windows : [];
	const error = input.error ?? null;
	if (input.hardError === true) return { status: "error", error: error ?? NO_DATA_ERROR };
	if (windows.length === 0) return { status: "error", error: error ?? NO_DATA_ERROR };
	return { status: "ok", error };
}

/**
 * @param {{
 *   label?: unknown, index?: number, email?: unknown, plan?: unknown,
 *   error?: string | null, hardError?: boolean,
 *   windows?: Array<object>, extras?: Array<object>,
 *   secrets?: unknown,
 * }} input
 * @param {Set<string> | Array<string> | null} [secrets=null]
 * @returns {object}
 */
function buildAccountSnapshot(input, secrets = null) {
	const allSecrets = collectKnownSecrets(input?.secrets, secrets);
	const rawWindows = Array.isArray(input.windows) ? input.windows : [];
	const windows = rawWindows.map((w, i) => coerceWindow(w, i, allSecrets)).filter(Boolean);
	const extras = (Array.isArray(input.extras) ? input.extras : [])
		.map((e, i) => coerceExtra(e, i, allSecrets))
		.filter(Boolean);
	const { status, error } = resolveAccountState({
		error: input.error ?? null,
		hardError: input.hardError === true,
		windows,
	});
	return {
		label: redactPublicText(input.label, 60, allSecrets)
			?? (typeof input.index === "number" ? `Account ${input.index + 1}` : "Account"),
		// Internal snapshots keep the full address for terminal rendering.
		email: sanitizeText(input.email, 254),
		plan: redactPublicText(input.plan, 40, allSecrets),
		status,
		error: scrubSecrets(error, allSecrets),
		windows,
		extras,
	};
}

/**
 * Rebuild an account snapshot from an allowlist. Applied to every provider
 * `normalize()` result so adapters cannot leak credentials, IDs, or paths.
 *
 * `allowLoading` is set only when re-coercing snapshots this module already
 * built. A provider's `normalize()` has finished by definition, so a
 * "loading" status coming from one is discarded rather than pinning an
 * account in the skeleton state forever.
 * @param {unknown} value
 * @param {{ account?: unknown, index?: number, allowLoading?: boolean, secrets?: unknown }} [options]
 * @returns {object}
 */
export function coerceAccountSnapshot(value, options = {}) {
	const fallback = objectValue(options.account) ?? {};
	const accountSecrets = collectKnownSecrets(value, options.account, options.secrets);
	const record = objectValue(scrubContext(value, accountSecrets)) ?? {};
	const windows = (Array.isArray(record.windows) ? record.windows : [])
		.map((w, i) => coerceWindow(w, i, accountSecrets))
		.filter(Boolean);
	const extras = (Array.isArray(record.extras) ? record.extras : [])
		.map((e, i) => coerceExtra(e, i, accountSecrets))
		.filter(Boolean);
	const rawError = sanitizeErrorText(record.error, accountSecrets);
	const provided = typeof record.status === "string" && ACCOUNT_STATUSES.includes(record.status)
		? record.status
		: null;
	if (options.allowLoading === true && provided === "loading") {
		return {
			label: redactPublicText(record.label ?? fallback.label, 60, accountSecrets)
				?? (typeof options.index === "number" ? `Account ${options.index + 1}` : "Account"),
			email: sanitizeText(record.email ?? fallback.email, 254),
			plan: redactPublicText(record.plan, 40, accountSecrets),
			status: "loading",
			error: rawError,
			windows,
			extras,
		};
	}
	// A normalizer may report a soft failure alongside usable windows (Claude
	// does this for partial data); that stays `ok` and keeps its message. Only
	// an explicit "error" status forces the account to error on its own.
	const { status, error } = resolveAccountState({
		error: rawError,
		hardError: provided === "error",
		windows,
	});
	return {
		label: redactPublicText(record.label ?? fallback.label, 60, accountSecrets)
			?? (typeof options.index === "number" ? `Account ${options.index + 1}` : "Account"),
		email: sanitizeText(record.email ?? fallback.email, 254),
		plan: redactPublicText(record.plan, 40, accountSecrets),
		status,
		error,
		windows,
		extras,
	};
}

/**
 * Skeleton card shown before an account's quota resolves.
 * @param {unknown} account
 * @param {{ index?: number, account?: unknown, secrets?: unknown }} [options]
 * @returns {object}
 */
export function createLoadingAccountSnapshot(account, options = {}) {
	const record = objectValue(account) ?? {};
	const secrets = collectKnownSecrets(account, options.account, options.secrets);
	return {
		label: redactPublicText(record.label, 60, secrets)
			?? (typeof options.index === "number" ? `Account ${options.index + 1}` : "Account"),
		email: sanitizeText(record.email, 254),
		plan: null,
		status: "loading",
		error: null,
		windows: [],
		extras: [],
	};
}

/**
 * @param {unknown} account
 * @param {unknown} error
 * @param {{ index?: number, account?: unknown, secrets?: unknown }} [options]
 * @returns {object}
 */
export function createErrorAccountSnapshot(account, error, options = {}) {
	const record = objectValue(account) ?? {};
	const secrets = collectKnownSecrets(account, options.account, options.secrets);
	return {
		label: redactPublicText(record.label, 60, secrets)
			?? (typeof options.index === "number" ? `Account ${options.index + 1}` : "Account"),
		email: sanitizeText(record.email, 254),
		plan: null,
		status: "error",
		error: sanitizeErrorText(error, secrets) ?? NO_DATA_ERROR,
		windows: [],
		extras: [],
	};
}

/**
 * @param {unknown} account
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
function mergeEntry(account, result) {
	return scrubContext({ ...(objectValue(account) ?? {}), ...(objectValue(result) ?? {}) },
		collectKnownSecrets(account, result));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-provider normalizers (adapted from the v1 server projection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Record<string, unknown>} usage
 * @param {Date} now
 * @returns {{ availableCount: number, nextExpiresAt: string | null } | null}
 */
function normalizeBankedResets(usage, now) {
	const raw = objectValue(usage.rate_limit_reset_credits ?? usage.rateLimitResetCredits);
	if (!raw) return null;
	const credits = Array.isArray(raw.credits) ? raw.credits : [];
	const expirations = credits
		.map(credit => {
			const item = objectValue(credit);
			return item ? isoTimestamp(item.expires_at ?? item.expiresAt, now) : null;
		})
		.filter(Boolean)
		.sort();
	const count = numberValue(raw.available_count ?? raw.availableCount);
	return {
		availableCount: Math.max(0, Math.floor(count ?? expirations.length)),
		nextExpiresAt: expirations[0] ?? null,
	};
}

/**
 * @param {unknown} account
 * @param {unknown} result
 * @param {Date | string | number} [now]
 * @param {{ index?: number }} [options]
 * @returns {object}
 */
export function normalizeCodexAccount(account, result, now = new Date(), options = {}) {
	const entry = mergeEntry(account, result);
	const at = resolveDate(now);
	const rawUsage = objectValue(entry.usage);
	const usage = objectValue(rawUsage?.usage) ?? rawUsage ?? {};
	const rateLimit = objectValue(usage.rate_limit ?? usage.rateLimit) ?? {};
	const primary = objectValue(rateLimit.primary_window ?? rateLimit.primaryWindow
		?? usage.primary ?? usage.session ?? usage.fiveHour);
	const secondary = objectValue(rateLimit.secondary_window ?? rateLimit.secondaryWindow
		?? usage.secondary ?? usage.weekly ?? usage.week);
	const windows = [];
	const seen = new Set();
	const primarySeconds = numberValue(primary?.limit_window_seconds ?? primary?.limitWindowSeconds);
	const primaryIsWeekly = primarySeconds !== null && primarySeconds >= 6 * 24 * 60 * 60;
	addWindow(
		windows,
		seen,
		primaryIsWeekly ? "weekly" : "session",
		primaryIsWeekly ? "Weekly" : "Session",
		primary,
		at,
	);
	addWindow(windows, seen, "weekly", "Weekly", secondary, at);

	const additional = Array.isArray(usage.additional_rate_limits)
		? usage.additional_rate_limits
		: Array.isArray(usage.additionalRateLimits) ? usage.additionalRateLimits : [];
	additional.forEach((rawAdditional, additionalIndex) => {
		const item = objectValue(rawAdditional);
		if (!item) return;
		const name = humanize(item.limit_name ?? item.limitName ?? item.name ?? `Additional ${additionalIndex + 1}`);
		const key = slug(name);
		const nested = objectValue(item.rate_limit ?? item.rateLimit) ?? item;
		addWindow(
			windows,
			seen,
			`additional-${key}-primary`,
			name,
			objectValue(nested.primary_window ?? nested.primaryWindow ?? nested.window ?? nested),
			at,
		);
		addWindow(
			windows,
			seen,
			`additional-${key}-secondary`,
			`${name} weekly`,
			objectValue(nested.secondary_window ?? nested.secondaryWindow),
			at,
		);
	});

	const hardError = sanitizeErrorText(entry.error ?? rawUsage?.error);
	const extras = [];
	const banked = normalizeBankedResets(usage, at);
	if (banked) {
		extras.push({ id: "banked-resets", label: "Banked resets", value: String(banked.availableCount) });
		if (banked.nextExpiresAt) {
			extras.push({ id: "banked-expires", label: "Next banked expiry", value: banked.nextExpiresAt });
		}
	}

	return buildAccountSnapshot({
		label: entry.label,
		index: options.index,
		email: entry.email,
		plan: formatCodexPlanLabel(
			entry.planType ?? entry.plan_type ?? usage.plan_type ?? usage.planType,
			{ planOverride: entry.planOverride ?? entry.plan_override },
		),
		error: hardError,
		hardError: Boolean(hardError),
		windows,
		extras,
	});
}

/**
 * @param {Record<string, unknown>} scope
 * @returns {string | null}
 */
function claudeScopeName(scope) {
	const model = scope.model;
	if (typeof model === "string") return sanitizeText(model);
	const modelObject = objectValue(model);
	const modelName = modelObject?.display_name ?? modelObject?.displayName ?? modelObject?.name;
	if (modelName) return sanitizeText(modelName);
	const surface = scope.surface;
	if (typeof surface === "string") return sanitizeText(surface);
	const surfaceObject = objectValue(surface);
	return sanitizeText(surfaceObject?.display_name ?? surfaceObject?.displayName ?? surfaceObject?.name);
}

/**
 * @param {unknown} account
 * @param {unknown} result
 * @param {Date | string | number} [now]
 * @param {{ index?: number }} [options]
 * @returns {object}
 */
export function normalizeClaudeAccount(account, result, now = new Date(), options = {}) {
	const entry = mergeEntry(account, result);
	const at = resolveDate(now);
	const usageOuter = objectValue(entry.usage) ?? {};
	const usage = objectValue(usageOuter.usage ?? usageOuter.quotas ?? usageOuter.quota) ?? usageOuter;
	const windows = [];
	const seen = new Set();
	const legacy = [
		["session", "Session", usage.five_hour ?? usage.fiveHour, 5 * 60 * 60],
		["weekly", "Weekly", usage.seven_day ?? usage.sevenDay, 7 * 24 * 60 * 60],
		["opus-weekly", "Opus weekly", usage.seven_day_opus ?? usage.sevenDayOpus, 7 * 24 * 60 * 60],
		["sonnet-weekly", "Sonnet weekly", usage.seven_day_sonnet ?? usage.sevenDaySonnet, 7 * 24 * 60 * 60],
	];
	for (const [id, label, rawWindow, seconds] of legacy) {
		addWindow(windows, seen, id, label, objectValue(rawWindow), at, {
			claude: true,
			defaultWindowSeconds: seconds,
		});
	}

	const limits = Array.isArray(usage.limits) ? usage.limits : [];
	limits.forEach((rawLimit, limitIndex) => {
		const limit = objectValue(rawLimit);
		if (!limit) return;
		const kind = String(limit.kind ?? "");
		const group = String(limit.group ?? "");
		const scopedName = claudeScopeName(objectValue(limit.scope) ?? {});
		let id;
		let label;
		let defaultWindowSeconds = null;
		if (scopedName) {
			id = `${slug(scopedName)}-${group === "weekly" || kind.startsWith("weekly") ? "weekly" : "limit"}`;
			label = `${humanize(scopedName)}${id.endsWith("weekly") ? " weekly" : ""}`;
			if (id.endsWith("weekly")) defaultWindowSeconds = 7 * 24 * 60 * 60;
		} else if (group === "session" || kind === "session") {
			id = "session";
			label = "Session";
			defaultWindowSeconds = 5 * 60 * 60;
		} else if (kind === "weekly_all" || group === "weekly") {
			id = "weekly";
			label = "Weekly";
			defaultWindowSeconds = 7 * 24 * 60 * 60;
		} else {
			id = `limit-${limitIndex + 1}`;
			label = humanize(kind || group || `Limit ${limitIndex + 1}`);
		}
		addWindow(windows, seen, id, label, limit, at, { claude: true, defaultWindowSeconds });
	});

	const accountObject = objectValue(entry.account) ?? {};
	const nestedAccount = objectValue(accountObject.account) ?? {};
	const entryError = sanitizeErrorText(entry.error);
	const partial = objectValue(entry.errors);
	const failed = entry.success === false || Boolean(entryError);
	// A partial failure is soft: if any window survived, the account is still
	// `ok` and carries this message alongside its data.
	const error = entryError ?? (partial ? "Some quota data is unavailable" : null);

	return buildAccountSnapshot({
		label: entry.label,
		index: options.index,
		email: accountObject.email ?? accountObject.email_address ?? nestedAccount.email ?? entry.email,
		plan: formatClaudePlanLabel(
			entry.subscriptionType ?? accountObject.plan ?? accountObject.plan_type ?? accountObject.planType,
			entry.rateLimitTier ?? accountObject.rateLimitTier ?? accountObject.rate_limit_tier,
			{ planOverride: entry.planOverride ?? entry.plan_override ?? accountObject.planOverride },
		),
		error,
		hardError: failed,
		windows,
	});
}

/**
 * @param {unknown} account
 * @param {unknown} result
 * @param {Date | string | number} [now]
 * @param {{ index?: number }} [options]
 * @returns {object}
 */
export function normalizeGrokAccount(account, result, now = new Date(), options = {}) {
	const entry = mergeEntry(account, result);
	const at = resolveDate(now);
	const usage = objectValue(entry.usage) ?? {};
	const period = objectValue(usage.period) ?? {};
	const startAt = isoTimestamp(period.start, at);
	const resetsAt = isoTimestamp(period.end, at);
	const periodSeconds = startAt && resetsAt
		? Math.max(0, (Date.parse(resetsAt) - Date.parse(startAt)) / 1000)
		: null;
	const windows = [];
	const seen = new Set(["credits"]);
	const mainPercent = clampPercent(usage.creditUsagePercent ?? usage.credit_usage_percent);
	if (mainPercent !== null) {
		windows.push({
			id: "credits",
			label: "Credits",
			percentUsed: mainPercent,
			percentRemaining: 100 - mainPercent,
			resetsAt,
			windowSeconds: periodSeconds,
		});
	}
	const products = Array.isArray(usage.products) ? usage.products : [];
	products.forEach((rawProduct, productIndex) => {
		const product = objectValue(rawProduct);
		if (!product) return;
		const percent = clampPercent(product.usagePercent ?? product.usage_percent);
		if (percent === null) return;
		const label = humanize(product.product ?? `Product ${productIndex + 1}`);
		let id = `product-${slug(label)}`;
		if (seen.has(id)) id = `${id}-${productIndex + 1}`;
		seen.add(id);
		windows.push({
			id,
			label,
			percentUsed: percent,
			percentRemaining: 100 - percent,
			resetsAt,
			windowSeconds: periodSeconds,
		});
	});

	const error = sanitizeErrorText(entry.error);
	return buildAccountSnapshot({
		label: entry.label,
		index: options.index,
		email: entry.email,
		plan: formatGrokPlanLabel(entry.tier, {
			plan: entry.plan,
			planType: entry.planType,
			planOverride: entry.planOverride ?? entry.plan_override,
		}),
		error,
		hardError: Boolean(error),
		windows,
	});
}

/**
 * @param {unknown} account
 * @param {unknown} result
 * @param {Date | string | number} [now]
 * @param {{ index?: number }} [options]
 * @returns {object}
 */
export function normalizeAntigravityAccount(account, result, now = new Date(), options = {}) {
	const entry = mergeEntry(account, result);
	const at = resolveDate(now);
	const usage = objectValue(entry.usage) ?? {};
	const groups = Array.isArray(usage.groups) ? usage.groups : [];
	const windows = [];
	const seen = new Set();
	for (const rawGroup of groups) {
		const group = objectValue(rawGroup);
		if (!group) continue;
		const groupName = sanitizeText(group.displayName ?? group.id) ?? "Models";
		const buckets = Array.isArray(group.buckets) ? group.buckets : [];
		for (const rawBucket of buckets) {
			const bucket = objectValue(rawBucket);
			if (!bucket) continue;
			const remaining = clampPercent(
				typeof bucket.percentRemaining === "number"
					? bucket.percentRemaining
					: typeof bucket.remainingFraction === "number"
						? bucket.remainingFraction * 100
						: null,
			);
			if (remaining === null) continue;
			const windowName = sanitizeText(bucket.window) === "5h"
				? "5h"
				: sanitizeText(bucket.window) === "weekly"
					? "Weekly"
					: sanitizeText(bucket.displayName) ?? "Limit";
			const label = groupName === "Gemini Models" || slug(groupName) === "gemini"
				? windowName
				: `${humanize(groupName)} ${windowName}`.trim();
			let id = slug(`${group.id ?? groupName}-${bucket.bucketId ?? windowName}`);
			if (seen.has(id)) id = `${id}-${windows.length + 1}`;
			seen.add(id);
			windows.push({
				id,
				label,
				percentUsed: 100 - remaining,
				percentRemaining: remaining,
				resetsAt: isoTimestamp(bucket.resetTime ?? bucket.reset_time, at),
				windowSeconds: bucket.window === "5h" ? 5 * 60 * 60
					: bucket.window === "weekly" ? 7 * 24 * 60 * 60
						: null,
			});
		}
	}
	const error = sanitizeErrorText(entry.error);
	const paidTier = sanitizeText(entry.paidTier ?? entry.paid_tier, 40);
	return buildAccountSnapshot({
		label: entry.label,
		index: options.index,
		email: entry.email,
		plan: paidTier === "g1-pro-tier" ? "Google AI Pro" : paidTier,
		error,
		hardError: Boolean(error),
		windows,
	});
}

/**
 * Fallback for providers that supply no `normalize()` and are not one of the
 * four known ids. Understands `{ error }` and `{ usage: { windows: [...] } }`.
 * @param {unknown} account
 * @param {unknown} result
 * @param {Date | string | number} [now]
 * @param {{ index?: number }} [options]
 * @returns {object}
 */
export function normalizeGenericAccount(account, result, now = new Date(), options = {}) {
	const entry = mergeEntry(account, result);
	const at = resolveDate(now);
	const usage = objectValue(entry.usage) ?? {};
	const rawWindows = Array.isArray(usage.windows) ? usage.windows : [];
	const windows = [];
	const seen = new Set();
	rawWindows.forEach((rawWindow, windowIndex) => {
		const item = objectValue(rawWindow);
		if (!item) return;
		const label = sanitizeText(item.label, 40) ?? `Limit ${windowIndex + 1}`;
		let id = slug(item.id ?? label);
		if (seen.has(id)) id = `${id}-${windowIndex + 1}`;
		addWindow(windows, seen, id, label, item, at, { detail: item.detail });
	});
	const error = sanitizeErrorText(entry.error);
	return buildAccountSnapshot({
		label: entry.label,
		index: options.index,
		email: entry.email,
		plan: entry.plan,
		error,
		hardError: Boolean(error),
		windows,
	});
}

/**
 * Normalizers keyed by provider id, matching the plan §3.2 `normalize` slot.
 * Production adapters can reference these directly.
 */
export const ACCOUNT_NORMALIZERS = Object.freeze({
	codex: normalizeCodexAccount,
	claude: normalizeClaudeAccount,
	grok: normalizeGrokAccount,
	antigravity: normalizeAntigravityAccount,
	cursor: normalizeGenericAccount,
});

/**
 * @param {string} id
 * @returns {string}
 */
export function defaultProviderName(id) {
	return PROVIDER_NAMES[id] ?? humanize(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ id?: unknown, name?: unknown, accounts?: unknown, error?: unknown, loading?: unknown }} input
 * @param {{ allowLoading?: boolean }} [options]
 * @returns {object}
 */
export function buildProviderSnapshot(input = {}, options = {}) {
	const record = objectValue(scrubContext(input)) ?? {};
	const id = slug(record.id ?? "provider");
	const allowLoading = options.allowLoading === true;
	const accounts = (Array.isArray(record.accounts) ? record.accounts : [])
		.map((account, index) => coerceAccountSnapshot(account, { index, allowLoading }));
	return {
		id,
		name: redactPublicText(record.name, 40) ?? defaultProviderName(id),
		accounts,
		error: sanitizeErrorText(record.error),
		loading: record.loading === true,
	};
}

/**
 * Counts by status only. A low-quota account is a successful one, so it counts
 * in `okCount`; how urgent it looks is decided downstream from
 * `percentRemaining`.
 * @param {Array<object>} providers
 * @returns {{ providerCount: number, accountCount: number, loadingCount: number, okCount: number, errorCount: number }}
 */
function buildSummary(providers) {
	const accounts = providers.flatMap(provider => provider.accounts);
	return {
		providerCount: providers.length,
		accountCount: accounts.length,
		loadingCount: accounts.filter(account => account.status === "loading").length,
		okCount: accounts.filter(account => account.status === "ok").length,
		errorCount: accounts.filter(account => account.status === "error").length,
	};
}

/**
 * Assemble a full snapshot. `generatedAt` stays null until the scan completes,
 * so in-flight progress frames are never mistaken for a finished scan.
 *
 * `allowLoading` is for callers assembling their own progress frames from
 * skeletons this module produced; without it a pending account would be
 * rewritten as a finished one on every frame.
 * @param {Array<object>} providers
 * @param {{ generatedAt?: unknown, startedAt?: unknown, complete?: boolean, allowLoading?: boolean }} [options]
 * @returns {object}
 */
export function buildSnapshot(providers, options = {}) {
	const allowLoading = options.allowLoading === true;
	const list = (Array.isArray(providers) ? providers : [])
		.map(provider => buildProviderSnapshot(provider, { allowLoading }));
	const complete = options.complete === true;
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		startedAt: isoOrNull(options.startedAt),
		generatedAt: complete ? isoOrNull(options.generatedAt) : null,
		complete,
		providers: list,
		summary: buildSummary(list),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Public projection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {object | null}
 */
function toPublicWindow(value, index) {
	const record = objectValue(value);
	if (!record) return null;
	const percentRemaining = clampPercent(record.percentRemaining);
	const percentUsed = clampPercent(record.percentUsed);
	const windowSeconds = numberValue(record.windowSeconds);
	const window = {
		id: slug(record.id ?? `limit-${index + 1}`),
		label: redactPublicText(record.label, 40) ?? "Limit",
		percentRemaining,
		percentUsed,
		resetsAt: isoOrNull(record.resetsAt),
		windowSeconds: windowSeconds !== null && windowSeconds >= 0 ? windowSeconds : null,
	};
	const detail = redactPublicText(record.detail, 60);
	if (detail) window.detail = detail;
	return window;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {object | null}
 */
function toPublicExtra(value, index) {
	const record = objectValue(value);
	if (!record) return null;
	const label = redactPublicText(record.label, 40);
	const text = redactPublicText(record.value, 60);
	if (!label || !text) return null;
	return { id: slug(record.id ?? label ?? `extra-${index + 1}`), label, value: text };
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {{ showEmail?: boolean }} options
 * @returns {object}
 */
function toPublicAccount(value, index, options) {
	const record = objectValue(value) ?? {};
	const windows = (Array.isArray(record.windows) ? record.windows : [])
		.map(toPublicWindow)
		.filter(Boolean);
	const extras = (Array.isArray(record.extras) ? record.extras : [])
		.map(toPublicExtra)
		.filter(Boolean);
	const provided = typeof record.status === "string" && ACCOUNT_STATUSES.includes(record.status)
		? record.status
		: null;
	const rawError = safePublicError(typeof record.error === "string" ? record.error : null);
	const { status, error } = provided === "loading"
		? { status: "loading", error: rawError }
		: resolveAccountState({ error: rawError, hardError: provided === "error", windows });
	return {
		label: redactPublicText(record.label, 40) ?? `Account ${index + 1}`,
		email: options.showEmail === true
			? (maskEmail(record.email) ? sanitizeText(record.email, 254) : null)
			: maskEmail(record.email),
		plan: redactPublicText(record.plan, 40),
		status,
		error,
		windows,
		extras,
	};
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {{ showEmail?: boolean }} options
 * @returns {object}
 */
function toPublicProvider(value, index, options) {
	const record = objectValue(value) ?? {};
	const id = slug(record.id ?? `provider-${index + 1}`);
	return {
		id,
		name: redactPublicText(record.name, 40) ?? defaultProviderName(id),
		accounts: (Array.isArray(record.accounts) ? record.accounts : [])
			.map((account, accountIndex) => toPublicAccount(account, accountIndex, options)),
		error: safePublicError(typeof record.error === "string" ? record.error : null),
		loading: record.loading === true,
	};
}

/**
 * @param {unknown} snapshot
 * @param {{ showEmail?: boolean }} options
 * @returns {object}
 */
function project(snapshot, options) {
	const root = objectValue(scrubContext(snapshot)) ?? {};
	const providers = (Array.isArray(root.providers) ? root.providers : [])
		.map((provider, index) => toPublicProvider(provider, index, options));
	const complete = root.complete === true;
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		startedAt: isoOrNull(root.startedAt),
		generatedAt: complete ? isoOrNull(root.generatedAt) : null,
		complete,
		providers,
		summary: buildSummary(providers),
	};
}

/**
 * Project an internal snapshot into the only shape safe to send to the browser
 * or to any untrusted consumer. Built field by field from an allowlist: emails
 * are always masked, every other free-text field is redacted, errors are
 * collapsed to a generic category, and credentials, account IDs, and paths
 * cannot appear because nothing copies them. There is no option to widen this.
 * @param {unknown} snapshot
 * @returns {object}
 */
export function toPublicSnapshot(snapshot) {
	return project(snapshot, { showEmail: false });
}

/**
 * Local-terminal projection for CLI `--json`, where the operator already has
 * filesystem access to the credentials behind these accounts and an opt-in
 * flag can show the address in full.
 *
 * Identical to `toPublicSnapshot` in every other respect — same allowlist,
 * same redaction of labels, plans, details, extras, and errors — so this is a
 * widening of exactly one field and never a bypass. Do not use it for the
 * server or anything that crosses a process boundary.
 * @param {unknown} snapshot
 * @param {{ showEmail?: boolean }} [options]
 * @returns {object}
 */
export function toDisplaySnapshot(snapshot, options = {}) {
	return project(snapshot, { showEmail: options.showEmail === true });
}
