/**
 * Pure formatting helpers for quota values, reset times, and paths.
 * Depends on: lib/constants.js
 *
 * v1 presentation is gone: the bars, boxes, per-provider usage-line builders,
 * and the `printHelp*` family are superseded by lib/tui/* (rendering and width
 * measurement), lib/cli.js (help text and removed-command errors), and
 * lib/snapshot.js (payload normalization and email masking). What remains is
 * side-effect-free formatting with no command semantics.
 */

import { homedir } from "node:os";
import { PRIMARY_CMD, V1_COMPAT_COMMAND } from "./constants.js";

/**
 * One-line error for a provider namespace that was removed in v2.
 * @param {string} namespace - Removed namespace (e.g. "factory")
 * @param {string[]} [rest=[]] - Remaining non-flag args after the namespace
 * @returns {string}
 */
export function formatRemovedNamespaceError(namespace, rest = []) {
	const invocation = [namespace, ...rest].join(" ");
	return `Error: '${PRIMARY_CMD} ${namespace}' was removed in v2. Use '${V1_COMPAT_COMMAND} ${invocation}' instead.`;
}

/**
 * Project a Codex rate-limit window onto its recognized field aliases.
 * @param {object | null | undefined} window
 * @returns {{ used: number | undefined, remaining: number | undefined, resets: unknown, resetAfterSeconds: number | undefined, limitWindowSeconds: number | undefined } | null}
 */
export function parseWindow(window) {
	if (!window) return null;
	const used = window.used_percent ?? window.usedPercent ?? window.percent_used;
	const remaining = window.remaining_percent ?? window.remainingPercent;
	const resets = window.resets_at ?? window.resetsAt ?? window.reset_at;
	const resetAfterSeconds = window.reset_after_seconds ?? window.resetAfterSeconds;
	const limitWindowSeconds = window.limit_window_seconds ?? window.limitWindowSeconds;
	return { used, remaining, resets, resetAfterSeconds, limitWindowSeconds };
}

/**
 * Whether a Codex rate-limit window represents a weekly quota.
 * The API formerly returned a 5-hour primary window and weekly secondary window.
 * Weekly-only plans now return their 7-day quota as the primary window instead.
 * @param {object | null} window - Parsed rate-limit window
 * @returns {boolean}
 */
export function isCodexWeeklyWindow(window) {
	return Number(window?.limitWindowSeconds) >= 6 * 24 * 60 * 60;
}

/**
 * @param {number | undefined} used
 * @param {number | undefined} remaining
 * @returns {string | null}
 */
export function formatPercent(used, remaining) {
	// Prefer showing remaining (matches Codex CLI /status display)
	if (remaining !== undefined) return `${Math.round(remaining)}% left`;
	if (used !== undefined) return `${Math.round(100 - used)}% left`;
	return null;
}

/**
 * Render a countdown as a reset clock time.
 * @param {number | null | undefined} seconds - Seconds until reset
 * @param {"parentheses" | "inline" | "compact"} [style="parentheses"]
 * @returns {string}
 */
export function formatResetTime(seconds, style = "parentheses") {
	if (!seconds) return "";

	const resetDate = new Date(Date.now() + seconds * 1000);
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);

	// Format time as HH:MM
	const timeStr = resetDate.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	if (style === "compact") {
		if (hours >= 24) {
			const day = resetDate.getDate();
			const month = resetDate.toLocaleDateString("en-US", { month: "short" });
			return `${day} ${month} ${timeStr}`;
		}
		return timeStr;
	}

	// For display matching Codex CLI style
	if (style === "inline") {
		if (hours >= 24) {
			// Show date for weekly+ resets: "resets 20:26 on 19 Jan"
			const day = resetDate.getDate();
			const month = resetDate.toLocaleDateString("en-US", { month: "short" });
			return `(resets ${timeStr} on ${day} ${month})`;
		}
		// Same day: "resets 23:14"
		return `(resets ${timeStr})`;
	}

	// Legacy parentheses style for JSON/other uses
	if (hours > 24) {
		const days = Math.floor(hours / 24);
		return `(resets in ${days}d ${hours % 24}h)`;
	}
	if (hours > 0) {
		return `(resets in ${hours}h ${mins}m)`;
	}
	return `(resets in ${mins}m)`;
}

/**
 * Render an absolute reset timestamp as a countdown clock time.
 * @param {string | number | Date | null | undefined} dateString
 * @param {"inline" | "compact" | "parentheses"} [style="inline"]
 * @returns {string}
 */
export function formatResetAt(dateString, style = "inline") {
	if (!dateString) return "";
	const date = new Date(dateString);
	if (Number.isNaN(date.getTime())) return "";
	const seconds = Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
	return formatResetTime(seconds, style);
}

/**
 * Format a banked reset expiration timestamp in the machine's local timezone.
 * @param {string | number | Date | null} timestamp - Reset expiration timestamp
 * @param {boolean} [compact=false] - Whether to use the single-line format
 * @returns {string}
 */
export function formatBankedResetExpiration(timestamp, compact = false) {
	if (!timestamp) return "not set";
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "not set";
	return date.toLocaleString("en-US", compact ? {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZoneName: "short",
	} : {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
		timeZoneName: "short",
	});
}

/**
 * Read banked reset-credit details from a Codex usage payload.
 * @param {object} usage - Codex usage payload
 * @returns {{ availableCount: number, credits: object[] } | null}
 */
export function parseBankedResetCredits(usage) {
	const raw = usage?.rate_limit_reset_credits ?? usage?.rateLimitResetCredits;
	if (!raw || typeof raw !== "object") return null;

	const credits = Array.isArray(raw.credits) ? raw.credits : [];
	const rawCount = raw.available_count ?? raw.availableCount;
	const parsedCount = Number(rawCount);
	const availableCount = Number.isFinite(parsedCount) ? parsedCount : credits.length;
	return { availableCount, credits };
}

/**
 * @param {number | null | undefined} percentLeft
 * @returns {string}
 */
export function formatClaudePercentLeft(percentLeft) {
	if (percentLeft === null || percentLeft === undefined || Number.isNaN(percentLeft)) {
		return "?";
	}
	return `${Math.round(percentLeft)}% left`;
}

/**
 * Clamp a Claude utilization value to 0-100 percentage points.
 * @param {unknown} value
 * @returns {number | null}
 */
export function normalizePercentUsed(value) {
	if (value === null || value === undefined) return null;
	let used = Number(value);
	if (!Number.isFinite(used)) return null;

	// Claude OAuth usage now reports percentage points (0-100).
	// Keep integer values like 1 as 1% used; only treat fractional values
	// in (0, 1) as ratio form for backward compatibility.
	if (used > 0 && used < 1) {
		used *= 100;
	}

	return Math.min(100, Math.max(0, used));
}

/**
 * Read remaining percent and reset time from a Claude utilization window.
 * @param {object | null | undefined} window
 * @returns {{ remaining: number | null, resetsAt: unknown } | null}
 */
export function parseClaudeUtilizationWindow(window) {
	if (!window || typeof window !== "object") return null;
	const utilization = window.utilization ?? window.used_percent ?? window.usedPercent ?? window.percent_used;
	const remainingPercent = window.remaining_percent ?? window.remainingPercent ?? window.percent_remaining;
	const resetsAt = window.resets_at ?? window.resetsAt ?? window.reset_at ?? window.resetAt;
	let remaining = null;
	if (remainingPercent !== undefined) {
		remaining = Number(remainingPercent);
	} else {
		const used = normalizePercentUsed(utilization);
		if (used !== null) {
			remaining = 100 - used;
		}
	}
	if (remaining !== null && Number.isFinite(remaining)) {
		remaining = Math.min(100, Math.max(0, remaining));
	}
	return { remaining, resetsAt };
}

/**
 * Format a token count with comma separators (e.g., 5000000 → "5,000,000").
 * Returns "0" for null, undefined, or NaN. Truncates decimals.
 * @param {number | null | undefined} n - Token count
 * @returns {string}
 */
export function formatTokenCount(n) {
	if (n === null || n === undefined || !Number.isFinite(n)) return "0";
	const int = Math.trunc(n);
	const isNeg = int < 0;
	const abs = Math.abs(int);
	const str = String(abs);
	let result = "";
	for (let i = 0; i < str.length; i++) {
		if (i > 0 && (str.length - i) % 3 === 0) result += ",";
		result += str[i];
	}
	return isNeg ? `-${result}` : result;
}

/**
 * Format a Grok billing period end as Codex/Claude-style "(resets HH:MM on D Mon)".
 * @param {string | null | undefined} periodEnd - ISO timestamp
 * @param {"inline" | "compact"} [style="inline"]
 * @returns {string}
 */
export function formatGrokPeriodReset(periodEnd, style = "inline") {
	if (!periodEnd) return "";
	const end = new Date(periodEnd);
	if (Number.isNaN(end.getTime())) return "";
	const seconds = Math.max(0, Math.floor((end.getTime() - Date.now()) / 1000));
	return formatResetTime(seconds, style);
}

/**
 * Format an Antigravity Cloud Code reset timestamp.
 * @param {string | null | undefined} timestamp
 * @param {"inline" | "compact"} [style="inline"]
 * @returns {string}
 */
export function formatAntigravityReset(timestamp, style = "inline") {
	if (!timestamp) return "";
	const resetAt = new Date(timestamp).getTime();
	if (!Number.isFinite(resetAt)) return "";
	return formatResetTime(Math.max(0, Math.floor((resetAt - Date.now()) / 1000)), style);
}

/**
 * Format expiry time as human-readable duration
 * @param {number | undefined} expires - Expiry timestamp in milliseconds
 * @returns {{ status: string, display: string }} Status and display string
 */
export function formatExpiryStatus(expires) {
	if (!expires) {
		return { status: "unknown", display: "Unknown" };
	}

	const now = Date.now();
	const diff = expires - now;

	if (diff <= 0) {
		return { status: "expired", display: "Expired" };
	}

	// Warn if expiring within 5 minutes
	if (diff < 5 * 60 * 1000) {
		const mins = Math.ceil(diff / 60000);
		return { status: "expiring", display: `Expiring in ${mins}m` };
	}

	// Format remaining time
	const hours = Math.floor(diff / (60 * 60 * 1000));
	const mins = Math.floor((diff % (60 * 60 * 1000)) / 60000);

	if (hours > 24) {
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return { status: "valid", display: `${days}d ${remainingHours}h` };
	}

	if (hours > 0) {
		return { status: "valid", display: `${hours}h ${mins}m` };
	}

	return { status: "valid", display: `${mins}m` };
}

/**
 * Shorten a path for display (replace home directory with ~)
 * @param {string} filePath - Full file path
 * @returns {string} Shortened path
 */
export function shortenPath(filePath) {
	const home = homedir();
	if (filePath.startsWith(home)) {
		return "~" + filePath.slice(home.length);
	}
	return filePath;
}
