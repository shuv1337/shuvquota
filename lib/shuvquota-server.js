/**
 * Secure local HTTP server and quota normalization for the shuvquota PWA.
 * Zero dependencies: Node.js built-ins only.
 */

import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SHUVQUOTA_HOST = "127.0.0.1";
export const DEFAULT_SHUVQUOTA_PORT = 4789;
export const DEFAULT_QUOTA_CACHE_MS = 10_000;
export const DEFAULT_QUOTA_FAILURE_COOLDOWN_MS = 2_000;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SHUVQUOTA_WEB_ROOT = resolve(MODULE_DIR, "../web");


const MIME_TYPES = new Map([
	[".avif", "image/avif"],
	[".css", "text/css; charset=utf-8"],
	[".gif", "image/gif"],
	[".htm", "text/html; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".ico", "image/x-icon"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".txt", "text/plain; charset=utf-8"],
	[".webmanifest", "application/manifest+json; charset=utf-8"],
	[".webp", "image/webp"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
]);

const SECURITY_HEADERS = Object.freeze({
	"Content-Security-Policy": [
		"default-src 'self'",
		"base-uri 'none'",
		"connect-src 'self'",
		"font-src 'self'",
		"form-action 'none'",
		"frame-ancestors 'none'",
		"img-src 'self'",
		"manifest-src 'self'",
		"object-src 'none'",
		"script-src 'self'",
		"style-src 'self'",
		"worker-src 'self'",
	].join("; "),
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
});

/**
 * Error carrying only a browser-safe category. Raw CLI output is never retained.
 */
export class QuotaLoadError extends Error {
	/**
	 * @param {string} code
	 * @param {string} safeMessage
	 */
	constructor(code, safeMessage) {
		super(safeMessage);
		this.name = "QuotaLoadError";
		this.code = code;
		this.safeMessage = safeMessage;
	}
}

export function createQuotaLoader(options = {}) {
	const cacheMs = options.cacheMs ?? DEFAULT_QUOTA_CACHE_MS;
	const failureCooldownMs = options.failureCooldownMs ?? DEFAULT_QUOTA_FAILURE_COOLDOWN_MS;
	const now = options.now ?? (() => new Date());
	let inFlight = null;
	let cached = null;
	let cachedAt = 0;
	let failure = null;
	let failedAt = 0;

	const getSnapshot = async () => {
		const currentMs = now().getTime();
		if (cached && currentMs - cachedAt < cacheMs) return cached;
		if (failure && currentMs - failedAt < failureCooldownMs) throw failure;
		if (inFlight) return inFlight;

		inFlight = (async () => {
			const startedAt = now();
			try {
				let raw;
				if (options.execute) {
					raw = await options.execute();
				} else {
					const { loadSnapshot } = await import("./quota.js");
					const { providers } = await import("./providers/index.js");
					raw = await loadSnapshot({ providers });
				}
				
				const { toPublicSnapshot } = await import("./snapshot.js");
				const snapshot = toPublicSnapshot(raw);
				
				const completedAt = now();
				const finalSnapshot = {
					...snapshot,
					scanDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
				};
				cached = finalSnapshot;
				cachedAt = completedAt.getTime();
				failure = null;
				return finalSnapshot;
			} catch (error) {
				failure = error instanceof QuotaLoadError
					? error
					: new QuotaLoadError("LOAD_FAILED", "Quota data unavailable");
				failedAt = now().getTime();
				throw failure;
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};

	return {
		getSnapshot,
		clear() {
			cached = null;
			failure = null;
			cachedAt = 0;
			failedAt = 0;
		},
	};
}

/**
 * @param {string | string[] | undefined} configured
 * @param {string} bindHost
 * @returns {Set<string>}
 */
export function buildAllowedHosts(configured, bindHost = DEFAULT_SHUVQUOTA_HOST) {
	const values = Array.isArray(configured)
		? configured
		: typeof configured === "string" ? configured.split(",") : [];
	const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
	for (const value of [bindHost, ...values]) {
		const normalized = normalizeHostName(value);
		if (normalized) hosts.add(normalized);
	}
	return hosts;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeHostName(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed || /[\s/@\\?#]/.test(trimmed)) return null;
	try {
		const parsed = new URL(`http://${trimmed}`);
		if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
			return null;
		}
		return parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	} catch {
		return null;
	}
}

/**
 * @param {unknown} header
 * @param {Set<string>} allowedHosts
 * @returns {boolean}
 */
export function isAllowedHost(header, allowedHosts) {
	const normalized = normalizeHostName(header);
	return normalized !== null && allowedHosts.has(normalized);
}

/**
 * @param {import("node:http").ServerResponse} response
 */
function applySecurityHeaders(response) {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		response.setHeader(name, value);
	}
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} statusCode
 * @param {Buffer | string} body
 * @param {string} contentType
 * @param {boolean} headOnly
 * @param {Record<string, string>} [headers]
 */
function sendResponse(response, statusCode, body, contentType, headOnly, headers = {}) {
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
	applySecurityHeaders(response);
	response.statusCode = statusCode;
	response.setHeader("Content-Type", contentType);
	response.setHeader("Content-Length", String(payload.length));
	for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
	response.end(headOnly ? undefined : payload);
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} statusCode
 * @param {object} value
 * @param {boolean} headOnly
 */
function sendApiJson(response, statusCode, value, headOnly) {
	sendResponse(
		response,
		statusCode,
		`${JSON.stringify(value)}\n`,
		"application/json; charset=utf-8",
		headOnly,
		{
			"Cache-Control": "private, no-store, max-age=0",
			Expires: "0",
			Pragma: "no-cache",
		},
	);
}

/**
 * @param {Date} now
 * @param {unknown} error
 * @returns {object}
 */
async function buildUnavailableSnapshot(now, error) {
	const { toPublicSnapshot, safePublicError } = await import("./snapshot.js");
	const message = error instanceof QuotaLoadError
		? safePublicError(error.safeMessage) ?? "Quota data unavailable" : "Quota data unavailable";
	const snapshot = toPublicSnapshot({ generatedAt: now.toISOString() });
	snapshot.error = message;
	return snapshot;
}

/**
 * Resolve a decoded URL path beneath webRoot, rejecting traversal and symlink
 * escapes. Returns null for invalid or missing files.
 * @param {string} rawUrl
 * @param {string} webRoot
 * @returns {Promise<string | null>}
 */
export async function resolveStaticFile(rawUrl, webRoot = DEFAULT_SHUVQUOTA_WEB_ROOT) {
	const rawPath = String(rawUrl || "/").split(/[?#]/, 1)[0] || "/";
	let decoded;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		return null;
	}
	if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return null;
	if (decoded.split("/").some(segment => segment === "..")) return null;
	const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
	const rootPath = resolve(webRoot);
	const candidate = resolve(rootPath, relativePath);
	const lexicalRelative = relative(rootPath, candidate);
	if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
		return null;
	}
	try {
		const rootRealPath = await realpath(rootPath);
		let filePath = candidate;
		let fileStat = await stat(filePath);
		if (fileStat.isDirectory()) {
			filePath = join(filePath, "index.html");
			fileStat = await stat(filePath);
		}
		if (!fileStat.isFile()) return null;
		const fileRealPath = await realpath(filePath);
		const realRelative = relative(rootRealPath, fileRealPath);
		if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
			return null;
		}
		return fileRealPath;
	} catch {
		return null;
	}
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function getMimeType(filePath) {
	return MIME_TYPES.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

/**
 * Create the shuvquota request handler.
 * @param {{ webRoot?: string, quotaLoader?: { getSnapshot: () => Promise<object> } | (() => Promise<object>), host?: string, allowedHosts?: string | string[] | Set<string>, now?: () => Date }} [options]
 * @returns {import("node:http").RequestListener}
 */
export function createShuvquotaHandler(options = {}) {
	const webRoot = options.webRoot ?? DEFAULT_SHUVQUOTA_WEB_ROOT;
	const defaultLoader = createQuotaLoader();
	const getSnapshot = typeof options.quotaLoader === "function"
		? options.quotaLoader
		: options.quotaLoader?.getSnapshot?.bind(options.quotaLoader) ?? defaultLoader.getSnapshot;
	const allowedHosts = options.allowedHosts instanceof Set
		? options.allowedHosts
		: buildAllowedHosts(options.allowedHosts, options.host ?? DEFAULT_SHUVQUOTA_HOST);
	const now = options.now ?? (() => new Date());

	return async (request, response) => {
		const method = request.method ?? "GET";
		const headOnly = method === "HEAD";
		if (!isAllowedHost(request.headers.host, allowedHosts)) {
			sendResponse(response, 421, "Misdirected Request\n", "text/plain; charset=utf-8", headOnly);
			return;
		}
		if (request.headers["sec-fetch-site"] === "cross-site") {
			sendResponse(response, 403, "Forbidden\n", "text/plain; charset=utf-8", headOnly);
			return;
		}
		if (method !== "GET" && method !== "HEAD") {
			response.setHeader("Allow", "GET, HEAD");
			sendResponse(response, 405, "Method Not Allowed\n", "text/plain; charset=utf-8", false);
			return;
		}

		const path = String(request.url ?? "/").split(/[?#]/, 1)[0];
		if (path === "/api/health") {
			sendApiJson(response, 200, { status: "ok", service: "shuvquota", schemaVersion: 2 }, headOnly);
			return;
		}
		if (path === "/api/quota") {
			try {
				const snapshot = await getSnapshot();
				sendApiJson(response, 200, snapshot, headOnly);
			} catch (error) {
				sendApiJson(response, 503, await buildUnavailableSnapshot(now(), error), headOnly);
			}
			return;
		}
		if (path.startsWith("/api/")) {
			sendApiJson(response, 404, { error: "Not found" }, headOnly);
			return;
		}

		const filePath = await resolveStaticFile(request.url ?? "/", webRoot);
		if (!filePath) {
			sendResponse(response, 404, "Not Found\n", "text/plain; charset=utf-8", headOnly, {
				"Cache-Control": "no-store",
			});
			return;
		}
		try {
			const contents = await readFile(filePath);
			const basename = filePath.slice(filePath.lastIndexOf(sep) + 1);
			const extension = extname(filePath).toLowerCase();
			const cacheControl = basename === "index.html" || basename === "sw.js"
				|| extension === ".webmanifest" || extension === ".js" || extension === ".css"
				? "no-cache"
				: "public, max-age=3600";
			sendResponse(response, 200, contents, getMimeType(filePath), headOnly, {
				"Cache-Control": cacheControl,
			});
		} catch {
			sendResponse(response, 404, "Not Found\n", "text/plain; charset=utf-8", headOnly, {
				"Cache-Control": "no-store",
			});
		}
	};
}

/**
 * Create the shuvquota HTTP server.
 * @param {Parameters<typeof createShuvquotaHandler>[0]} [options]
 * @returns {import("node:http").Server}
 */
export function createShuvquotaServer(options = {}) {
	return createServer(createShuvquotaHandler(options));
}
