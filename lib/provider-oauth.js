/**
 * Independent OAuth enrollment for shuvquota-owned sessions (Codex, Claude,
 * Grok, Antigravity). `loginProvider()` returns normalized tokens only — it
 * never persists anything and never reads harness credential files.
 *
 * Depends on: lib/constants.js, lib/oauth.js, lib/claude-oauth.js, lib/jwt.js,
 * lib/prompts.js, lib/grok-accounts.js, lib/antigravity-usage.js
 *
 * Every side effect is injectable through `ctx` so the whole flow is testable
 * without a browser, a network, or a pinned port:
 *   fetch           token/identity HTTP (defaults to global fetch)
 *   openBrowser     (url, { noBrowser }) → void
 *   prompt          (message) → Promise<string>   (paste fallback)
 *   stdout          { write }                     (progress lines)
 *   env             ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET source
 *   signal          AbortSignal cancelling the whole login
 *   headless        force paste mode (also `noBrowser`)
 *   timeoutMs       callback wait and token exchange timeout
 *   waitForCallback ({ url, state, redirectUri }) → Promise<{ code, state? }>
 *                   replaces the loopback server entirely
 *   now             () → epoch ms
 */

import { createServer } from "node:http";
import {
	AUTHORIZE_URL,
	CLIENT_ID,
	REDIRECT_URI,
	TOKEN_URL,
	CLAUDE_OAUTH_CLIENT_ID,
	CLAUDE_OAUTH_REDIRECT_URI,
	CLAUDE_OAUTH_TOKEN_URL,
	OAUTH_TIMEOUT_MS,
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_TOKEN_URL,
	ANTIGRAVITY_TOKEN_URL,
	ANTIGRAVITY_CLOUD_CODE_URL,
	ANTIGRAVITY_TIMEOUT_MS,
	ANTIGRAVITY_USER_AGENT,
	GROK_TIMEOUT_MS,
	JWT_CLAIM,
	PRIMARY_CMD,
} from "./constants.js";
import {
	generatePKCE,
	generateState,
	buildAuthUrl,
	exchangeCodeForTokens,
	openBrowser as defaultOpenBrowser,
	isHeadlessEnvironment,
	SUCCESS_HTML,
	getErrorHtml,
} from "./oauth.js";
import {
	buildClaudeAuthUrl,
	parseClaudeCodeState,
	exchangeClaudeCodeForTokens,
} from "./claude-oauth.js";
import { decodeJWT, extractAccountId, extractProfile } from "./jwt.js";
import { promptInput } from "./prompts.js";
import { extractGrokProfile } from "./grok-accounts.js";
import { loadAntigravityProjectId } from "./antigravity-usage.js";

/** @typedef {"codex" | "claude" | "grok" | "antigravity"} ProviderOAuthId */

/**
 * @typedef {{
 *   accessToken: string,
 *   refreshToken: string,
 *   expiresAt: number,
 *   email?: string,
 *   accountId?: string,
 *   projectId?: string,
 *   enrollment: "independent",
 * }} EnrollmentCredential
 */

export const GROK_AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
export const GROK_REDIRECT_URI = "http://127.0.0.1:56121/callback";
export const GROK_OAUTH_SCOPES = "openid profile email offline_access";
export const GROK_OAUTH_PLAN = "generic";

export const ANTIGRAVITY_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:36742/oauth-callback";
export const ANTIGRAVITY_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const ANTIGRAVITY_OAUTH_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];

const DEFAULT_EXPIRES_IN_S = 3600;
const LOOPBACK_HOST = "127.0.0.1";

const PROVIDER_ALIASES = Object.freeze({
	codex: "codex",
	openai: "codex",
	claude: "claude",
	anthropic: "claude",
	grok: "grok",
	xai: "grok",
	antigravity: "antigravity",
	google: "antigravity",
});

/**
 * Normalize a provider id or alias.
 * @param {unknown} providerId
 * @returns {ProviderOAuthId}
 */
export function resolveProviderId(providerId) {
	const key = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
	const resolved = PROVIDER_ALIASES[key];
	if (!resolved) {
		throw new Error(`Unknown OAuth provider "${providerId ?? ""}". Use codex, claude, grok, or antigravity.`);
	}
	return resolved;
}

/**
 * Google client credentials come from the environment only; they are never
 * embedded in source.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ clientId: string, clientSecret: string }}
 */
export function getAntigravityOAuthClient(env = process.env) {
	const clientId = typeof env?.ANTIGRAVITY_CLIENT_ID === "string" ? env.ANTIGRAVITY_CLIENT_ID.trim() : "";
	const clientSecret = typeof env?.ANTIGRAVITY_CLIENT_SECRET === "string" ? env.ANTIGRAVITY_CLIENT_SECRET.trim() : "";
	if (!clientId || !clientSecret) {
		throw new Error(
			"Antigravity login needs ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET in the environment (e.g. ~/.shuvquota.env).",
		);
	}
	return { clientId, clientSecret };
}

/**
 * Google may omit `refresh_token` on refresh; keep the token we already hold.
 * @param {string | null | undefined} current
 * @param {unknown} returned
 * @returns {string | null}
 */
export function nextRefreshToken(current, returned) {
	if (typeof returned === "string" && returned) return returned;
	return typeof current === "string" && current ? current : null;
}

/**
 * @param {{ challenge: string, state: string, nonce: string }} params
 * @returns {string}
 */
export function buildGrokAuthorizeUrl(params) {
	const search = new URLSearchParams({
		response_type: "code",
		client_id: XAI_OAUTH_CLIENT_ID,
		redirect_uri: GROK_REDIRECT_URI,
		scope: GROK_OAUTH_SCOPES,
		code_challenge: params.challenge,
		code_challenge_method: "S256",
		state: params.state,
		nonce: params.nonce,
		plan: GROK_OAUTH_PLAN,
	});
	return `${GROK_AUTHORIZE_URL}?${search.toString()}`;
}

/**
 * @param {{ challenge: string, state: string, clientId: string }} params
 * @returns {string}
 */
export function buildAntigravityAuthorizeUrl(params) {
	const search = new URLSearchParams({
		response_type: "code",
		client_id: params.clientId,
		redirect_uri: ANTIGRAVITY_REDIRECT_URI,
		scope: ANTIGRAVITY_OAUTH_SCOPES.join(" "),
		code_challenge: params.challenge,
		code_challenge_method: "S256",
		access_type: "offline",
		prompt: "consent",
		state: params.state,
	});
	return `${ANTIGRAVITY_AUTHORIZE_URL}?${search.toString()}`;
}

/**
 * Parse a pasted redirect URL, `code#state`, or bare authorization code.
 * @param {unknown} input
 * @returns {{ code: string | null, state: string | null }}
 */
export function parseOAuthCallbackInput(input) {
	const trimmed = typeof input === "string" ? input.trim() : "";
	if (!trimmed) return { code: null, state: null };
	if (/^https?:\/\//i.test(trimmed)) {
		try {
			const url = new URL(trimmed);
			return { code: url.searchParams.get("code") || null, state: url.searchParams.get("state") || null };
		} catch {
			return { code: null, state: null };
		}
	}
	if (trimmed.includes("#")) {
		const [code, state] = trimmed.split("#", 2);
		return { code: code || null, state: state || null };
	}
	return { code: trimmed, state: null };
}

/**
 * Codex identity, with the same precedence as `exchangeCodeForTokens` in
 * lib/oauth.js: account id from the access token, then the id_token; email
 * from the id_token, then the access-token profile claim.
 * @param {string} accessToken
 * @param {string | null | undefined} idToken
 * @returns {{ accountId: string | null, email: string | null }}
 */
export function codexIdentityFromTokens(accessToken, idToken) {
	let accountId = extractAccountId(accessToken);
	let email = null;
	const idPayload = idToken ? decodeJWT(idToken) : null;
	if (idPayload) {
		email = typeof idPayload.email === "string" && idPayload.email ? idPayload.email : null;
		if (!accountId) accountId = idPayload[JWT_CLAIM]?.chatgpt_account_id || null;
	}
	if (!email) email = extractProfile(accessToken).email ?? null;
	return { accountId, email };
}

/**
 * Validate and shape the tokens a provider returned. Initial independent
 * enrollment requires a refresh token; without one the session could never be
 * refreshed and must not become a managed row.
 * @param {ProviderOAuthId} provider
 * @param {{ accessToken?: unknown, refreshToken?: unknown, expiresAt?: unknown,
 *   email?: unknown, accountId?: unknown, projectId?: unknown }} tokens
 * @param {number} [now]
 * @returns {EnrollmentCredential}
 */
export function normalizeEnrollmentCredential(provider, tokens, now = Date.now()) {
	const accessToken = typeof tokens?.accessToken === "string" ? tokens.accessToken : "";
	const refreshToken = typeof tokens?.refreshToken === "string" ? tokens.refreshToken : "";
	if (!accessToken) throw new Error(`${provider} login failed: the provider returned no access token.`);
	if (!refreshToken) {
		throw new Error(
			`${provider} login failed: initial enrollment requires a refresh token, but the provider returned none. `
			+ "Re-run the login and grant offline access (revoke the app's earlier authorization first if the consent screen was skipped).",
		);
	}
	const expiresAt = typeof tokens.expiresAt === "number" && Number.isFinite(tokens.expiresAt)
		? tokens.expiresAt
		: now + DEFAULT_EXPIRES_IN_S * 1000;
	/** @type {EnrollmentCredential} */
	const credential = { accessToken, refreshToken, expiresAt, enrollment: "independent" };
	if (typeof tokens.email === "string" && tokens.email) credential.email = tokens.email;
	if (typeof tokens.accountId === "string" && tokens.accountId) credential.accountId = tokens.accountId;
	if (typeof tokens.projectId === "string" && tokens.projectId) credential.projectId = tokens.projectId;
	return credential;
}

/**
 * Enroll an independent provider session. Returns tokens only; never persists.
 * @param {string} providerId
 * @param {object} [ctx] - see module header
 * @returns {Promise<EnrollmentCredential>}
 */
export async function loginProvider(providerId, ctx = {}) {
	const provider = resolveProviderId(providerId);
	if (ctx.signal?.aborted) throw new Error("Authentication cancelled.");
	if (provider === "codex") return loginCodex(ctx);
	if (provider === "claude") return loginClaude(ctx);
	if (provider === "grok") return loginGrok(ctx);
	return loginAntigravity(ctx);
}

/** @param {object} ctx */
async function loginCodex(ctx) {
	const { verifier, challenge } = generatePKCE();
	const state = generateState();
	const { code } = await collectAuthorizationCode(ctx, {
		authUrl: buildAuthUrl(challenge, state),
		state,
		redirectUri: REDIRECT_URI,
		parse: parseOAuthCallbackInput,
	});
	const tokens = await exchangeCodexAuthorizationCode(code, verifier, ctx);
	return normalizeEnrollmentCredential("codex", {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: tokens.expires,
		email: tokens.email,
		accountId: tokens.accountId,
	}, nowOf(ctx));
}

/** @param {object} ctx */
async function loginClaude(ctx) {
	const { verifier, challenge } = generatePKCE();
	const state = generateState();
	const { code } = await collectAuthorizationCode(ctx, {
		authUrl: buildClaudeAuthUrl(challenge, state),
		state,
		redirectUri: CLAUDE_OAUTH_REDIRECT_URI,
		paste: true,
		promptMessage: "Paste the code shown by Claude (code#state): ",
		parse: parseClaudeCodeState,
	});
	const tokens = await exchangeClaudeAuthorizationCode(code, verifier, state, ctx);
	return normalizeEnrollmentCredential("claude", {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: nowOf(ctx) + Number(tokens.expiresIn || DEFAULT_EXPIRES_IN_S) * 1000,
	}, nowOf(ctx));
}

/** @param {object} ctx */
async function loginGrok(ctx) {
	const { verifier, challenge } = generatePKCE();
	const state = generateState();
	const nonce = generateState();
	const { code } = await collectAuthorizationCode(ctx, {
		authUrl: buildGrokAuthorizeUrl({ challenge, state, nonce }),
		state,
		redirectUri: GROK_REDIRECT_URI,
		parse: parseOAuthCallbackInput,
	});
	const tokens = await exchangeGrokAuthorizationCode(code, verifier, ctx);
	const profile = extractGrokProfile(tokens.accessToken);
	return normalizeEnrollmentCredential("grok", {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: tokens.expiresAt,
		email: profile.email,
		accountId: profile.accountId,
	}, nowOf(ctx));
}

/** @param {object} ctx */
async function loginAntigravity(ctx) {
	// Fail before opening a browser when the client is not configured.
	const client = getAntigravityOAuthClient(ctx.env ?? process.env);
	const { verifier, challenge } = generatePKCE();
	const state = generateState();
	const { code } = await collectAuthorizationCode(ctx, {
		authUrl: buildAntigravityAuthorizeUrl({ challenge, state, clientId: client.clientId }),
		state,
		redirectUri: ANTIGRAVITY_REDIRECT_URI,
		parse: parseOAuthCallbackInput,
	});
	const tokens = await exchangeAntigravityAuthorizationCode(code, verifier, ctx);
	const [projectId, email] = await Promise.all([
		loadAntigravityProjectId(tokens.accessToken, {
			fetchFn: fetchOf(ctx),
			timeoutMs: ctx.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS,
			baseUrl: ctx.cloudCodeUrl ?? ANTIGRAVITY_CLOUD_CODE_URL,
		}).catch(() => null),
		tokens.email ? tokens.email : fetchGoogleEmail(tokens.accessToken, ctx),
	]);
	return normalizeEnrollmentCredential("antigravity", {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: tokens.expiresAt,
		email,
		projectId,
	}, nowOf(ctx));
}

/**
 * Codex token exchange. Without an injected fetch this reuses the read-only
 * helper in lib/oauth.js; with one it performs the equivalent request and the
 * same JWT identity extraction.
 * @param {string} code
 * @param {string} verifier
 * @param {object} [ctx]
 * @returns {Promise<{ accessToken: string, refreshToken: string, idToken: string | null,
 *   expires: number, accountId: string | null, email: string | null }>}
 */
export async function exchangeCodexAuthorizationCode(code, verifier, ctx = {}) {
	if (!hasInjectedFetch(ctx)) return exchangeCodeForTokens(code, verifier);
	const body = await postForm(ctx, TOKEN_URL, {
		grant_type: "authorization_code",
		code,
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
	}, ctx.timeoutMs ?? OAUTH_TIMEOUT_MS);
	requireTokenFields(body);
	const idToken = typeof body.id_token === "string" && body.id_token ? body.id_token : null;
	const identity = codexIdentityFromTokens(body.access_token, idToken);
	if (!identity.accountId) throw new Error("Token exchange failed: could not extract account_id from tokens");
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		idToken,
		expires: expiresAtFrom(body, nowOf(ctx)),
		accountId: identity.accountId,
		email: identity.email,
	};
}

/**
 * Claude token exchange (JSON body, state echoed back for server-side CSRF
 * validation). Reuses lib/claude-oauth.js when no fetch is injected.
 * @param {string} code
 * @param {string} verifier
 * @param {string} state
 * @param {object} [ctx]
 * @returns {Promise<{ accessToken: string, refreshToken: string | null, expiresIn: number }>}
 */
export async function exchangeClaudeAuthorizationCode(code, verifier, state, ctx = {}) {
	if (!hasInjectedFetch(ctx)) return exchangeClaudeCodeForTokens(code, verifier, state);
	const body = await postJson(ctx, CLAUDE_OAUTH_TOKEN_URL, {
		grant_type: "authorization_code",
		code,
		state,
		redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
		client_id: CLAUDE_OAUTH_CLIENT_ID,
		code_verifier: verifier,
	}, ctx.timeoutMs ?? OAUTH_TIMEOUT_MS);
	if (typeof body.access_token !== "string" || !body.access_token) {
		throw new Error("Token exchange failed: missing access_token in response");
	}
	return {
		accessToken: body.access_token,
		refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
		expiresIn: Number(body.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_EXPIRES_IN_S,
	};
}

/**
 * @param {string} code
 * @param {string} verifier
 * @param {object} [ctx]
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
 */
export async function exchangeGrokAuthorizationCode(code, verifier, ctx = {}) {
	const body = await postForm(ctx, XAI_OAUTH_TOKEN_URL, {
		grant_type: "authorization_code",
		code,
		redirect_uri: GROK_REDIRECT_URI,
		client_id: XAI_OAUTH_CLIENT_ID,
		code_verifier: verifier,
	}, ctx.timeoutMs ?? GROK_TIMEOUT_MS);
	requireTokenFields(body);
	return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: expiresAtFrom(body, nowOf(ctx)) };
}

/**
 * Google token exchange for Antigravity. Email is taken from the id_token when
 * present so no extra identity call is needed.
 * @param {string} code
 * @param {string} verifier
 * @param {object} [ctx]
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number, email: string | null }>}
 */
export async function exchangeAntigravityAuthorizationCode(code, verifier, ctx = {}) {
	const client = getAntigravityOAuthClient(ctx.env ?? process.env);
	const body = await postForm(ctx, ANTIGRAVITY_TOKEN_URL, {
		grant_type: "authorization_code",
		code,
		code_verifier: verifier,
		client_id: client.clientId,
		client_secret: client.clientSecret,
		redirect_uri: ANTIGRAVITY_REDIRECT_URI,
	}, ctx.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS, { "User-Agent": ANTIGRAVITY_USER_AGENT });
	if (typeof body.access_token !== "string" || !body.access_token) {
		throw new Error("Token exchange failed: missing access_token in response");
	}
	const refreshToken = nextRefreshToken(null, body.refresh_token);
	const idPayload = typeof body.id_token === "string" ? decodeJWT(body.id_token) : null;
	const email = typeof idPayload?.email === "string" && idPayload.email ? idPayload.email : null;
	return { accessToken: body.access_token, refreshToken, expiresAt: expiresAtFrom(body, nowOf(ctx)), email };
}

/**
 * One-shot loopback listener for an authorization-code redirect. Resolves with
 * the code once a request with the expected state arrives; rejects on provider
 * error, state mismatch, timeout, or abort. The server is always closed and
 * the timer/abort listener removed, whichever way it settles.
 * @param {{ host?: string, port: number, path: string, expectedState: string,
 *   timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ wait: Promise<{ code: string, state: string }>, close: () => Promise<void>, port: number }>}
 */
export async function listenForOAuthCallback(options) {
	const host = options.host ?? LOOPBACK_HOST;
	const timeoutMs = options.timeoutMs ?? OAUTH_TIMEOUT_MS;
	let settled = false;
	/** @type {ReturnType<typeof setTimeout> | null} */
	let timer = null;
	/** @type {(() => void) | null} */
	let onAbort = null;
	/** @type {{ resolve: (v: { code: string, state: string }) => void, reject: (e: Error) => void }} */
	let settle;
	const wait = new Promise((resolve, reject) => { settle = { resolve, reject }; });
	// Avoid an unhandled rejection when the caller only awaits `close()`.
	wait.catch(() => {});

	const server = createServer((req, res) => {
		const url = new URL(req.url || "/", `http://${host}`);
		if (url.pathname !== options.path) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not Found");
			return;
		}
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (error) {
			const description = url.searchParams.get("error_description");
			const message = description ? `${error}: ${description}` : error;
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(getErrorHtml(message));
			finish(new Error(`OAuth error: ${message}`));
			return;
		}
		if (!code) {
			res.writeHead(400, { "Content-Type": "text/html" });
			res.end(getErrorHtml("Missing authorization code"));
			finish(new Error("Missing authorization code in callback."));
			return;
		}
		if (state !== options.expectedState) {
			res.writeHead(400, { "Content-Type": "text/html" });
			res.end(getErrorHtml("State mismatch - possible CSRF attack"));
			finish(new Error("State mismatch. Possible CSRF attack. Please try again."));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(SUCCESS_HTML);
		finish(null, { code, state });
	});

	const close = () => new Promise(resolve => {
		// An explicit close before a callback arrived is a cancellation.
		if (!settled) {
			settled = true;
			settle.reject(new Error("Authentication cancelled."));
		}
		if (timer) { clearTimeout(timer); timer = null; }
		if (onAbort) { options.signal?.removeEventListener("abort", onAbort); onAbort = null; }
		if (!server.listening) { resolve(); return; }
		server.close(() => resolve());
		server.closeAllConnections?.();
	});

	/**
	 * @param {Error | null} error
	 * @param {{ code: string, state: string }} [result]
	 */
	function finish(error, result) {
		if (settled) return;
		settled = true;
		if (error) settle.reject(error); else settle.resolve(result);
		void close();
	}

	await new Promise((resolve, reject) => {
		server.once("error", err => {
			reject(err?.code === "EADDRINUSE"
				? new Error(`Port ${options.port} is in use. Close other ${PRIMARY_CMD} instances and retry.`)
				: err);
		});
		server.listen(options.port, host, () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;

	timer = setTimeout(() => {
		finish(new Error(`Authentication timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
	}, timeoutMs);
	if (options.signal) {
		onAbort = () => finish(new Error("Authentication cancelled."));
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	return { wait, close, port };
}

/**
 * Obtain an authorization code via (in order) the injected `waitForCallback`
 * hook, a pasted value (Claude always; others when headless), or a loopback
 * listener bound from the provider's redirect URI.
 * @param {object} ctx
 * @param {{ authUrl: string, state: string, redirectUri: string,
 *   parse: (input: string) => { code: string | null, state: string | null },
 *   paste?: boolean, promptMessage?: string }} spec
 * @returns {Promise<{ code: string, state: string }>}
 */
async function collectAuthorizationCode(ctx, spec) {
	if (typeof ctx.waitForCallback === "function") {
		presentAuthorizeUrl(ctx, spec.authUrl);
		const result = await ctx.waitForCallback({ url: spec.authUrl, state: spec.state, redirectUri: spec.redirectUri });
		return validateCollectedCode(result, spec.state);
	}
	if (spec.paste || isHeadless(ctx)) {
		presentAuthorizeUrl(ctx, spec.authUrl);
		const prompt = ctx.prompt ?? promptInput;
		const input = await prompt(spec.promptMessage ?? "Paste the redirect URL (or authorization code) from the browser: ");
		return validateCollectedCode(spec.parse(input), spec.state);
	}
	const redirect = new URL(spec.redirectUri);
	const listener = await listenForOAuthCallback({
		host: LOOPBACK_HOST,
		port: Number(redirect.port),
		path: redirect.pathname,
		expectedState: spec.state,
		timeoutMs: ctx.timeoutMs ?? OAUTH_TIMEOUT_MS,
		signal: ctx.signal,
	});
	try {
		presentAuthorizeUrl(ctx, spec.authUrl);
		writeLine(ctx, "Waiting for browser authentication...");
		return validateCollectedCode(await listener.wait, spec.state);
	} finally {
		await listener.close();
	}
}

/**
 * @param {{ code?: string | null, state?: string | null } | null | undefined} result
 * @param {string} expectedState
 * @returns {{ code: string, state: string }}
 */
function validateCollectedCode(result, expectedState) {
	const code = typeof result?.code === "string" ? result.code.trim() : "";
	if (!code) throw new Error("No authorization code provided. Authentication cancelled.");
	const state = typeof result?.state === "string" && result.state ? result.state : null;
	if (state !== null && state !== expectedState) {
		throw new Error("State mismatch. Possible CSRF attack. Please try again.");
	}
	return { code, state: expectedState };
}

/** @param {object} ctx */
function isHeadless(ctx) {
	if (typeof ctx.headless === "boolean") return ctx.headless;
	if (typeof ctx.noBrowser === "boolean") return ctx.noBrowser;
	return isHeadlessEnvironment();
}

/**
 * @param {object} ctx
 * @param {string} url
 */
function presentAuthorizeUrl(ctx, url) {
	const headless = isHeadless(ctx);
	if (typeof ctx.openBrowser === "function") {
		ctx.openBrowser(url, { noBrowser: headless });
		return;
	}
	if (headless) {
		writeLine(ctx, `\nOpen this URL in your browser to authenticate:\n\n  ${url}\n`);
		return;
	}
	defaultOpenBrowser(url, { noBrowser: false });
}

/**
 * @param {object} ctx
 * @param {string} message
 */
function writeLine(ctx, message) {
	const out = ctx.stdout && typeof ctx.stdout.write === "function" ? ctx.stdout : process.stdout;
	out.write(message.endsWith("\n") ? message : `${message}\n`);
}

/** @param {object} ctx */
function nowOf(ctx) {
	return typeof ctx.now === "function" ? ctx.now() : Date.now();
}

/** @param {object} ctx */
function hasInjectedFetch(ctx) {
	return typeof ctx.fetch === "function" || typeof ctx.fetchFn === "function";
}

/** @param {object} ctx */
function fetchOf(ctx) {
	return ctx.fetch ?? ctx.fetchFn ?? globalThis.fetch;
}

/**
 * @param {Record<string, unknown>} body
 * @param {number} now
 * @returns {number}
 */
function expiresAtFrom(body, now) {
	const seconds = Number(body.expires_in);
	return now + (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_EXPIRES_IN_S) * 1000;
}

/** @param {Record<string, unknown>} body */
function requireTokenFields(body) {
	if (typeof body.access_token !== "string" || !body.access_token) {
		throw new Error("Token exchange failed: missing access_token in response");
	}
	if (typeof body.refresh_token !== "string" || !body.refresh_token) {
		throw new Error("Token exchange failed: missing refresh_token in response");
	}
}

/**
 * @param {object} ctx
 * @param {string} url
 * @param {Record<string, string>} fields
 * @param {number} timeoutMs
 * @param {Record<string, string>} [headers]
 */
function postForm(ctx, url, fields, timeoutMs, headers = {}) {
	return post(ctx, url, {
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
		body: new URLSearchParams(fields).toString(),
	}, timeoutMs);
}

/**
 * @param {object} ctx
 * @param {string} url
 * @param {Record<string, string>} payload
 * @param {number} timeoutMs
 */
function postJson(ctx, url, payload, timeoutMs) {
	return post(ctx, url, {
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(payload),
	}, timeoutMs);
}

/**
 * POST with timeout and abort propagation. Error messages carry the HTTP
 * status and the provider's `error`/`error_description` only — never the
 * request body, tokens, or client secret.
 * @param {object} ctx
 * @param {string} url
 * @param {{ headers: Record<string, string>, body: string }} request
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>>}
 */
async function post(ctx, url, request, timeoutMs) {
	const fetchFn = fetchOf(ctx);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	ctx.signal?.addEventListener("abort", onAbort, { once: true });
	if (ctx.signal?.aborted) controller.abort();
	try {
		const response = await fetchFn(url, { method: "POST", headers: request.headers, body: request.body, signal: controller.signal });
		const text = typeof response?.text === "function" ? await response.text() : "";
		const json = parseJsonObject(text);
		if (!response.ok) {
			const detail = json && typeof json.error === "string"
				? `${json.error}${typeof json.error_description === "string" ? `: ${json.error_description}` : ""}`.slice(0, 200)
				: "";
			throw new Error(`Token exchange failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
		}
		if (!json) throw new Error("Token exchange failed: invalid JSON response");
		return json;
	} catch (error) {
		if (ctx.signal?.aborted) throw new Error("Token exchange cancelled.");
		if (error?.name === "AbortError" || controller.signal.aborted) {
			throw new Error(`Token exchange timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		ctx.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseJsonObject(text) {
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Best-effort Google userinfo lookup when the id_token carried no email.
 * @param {string} accessToken
 * @param {object} ctx
 * @returns {Promise<string | null>}
 */
async function fetchGoogleEmail(accessToken, ctx) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS);
	try {
		const response = await fetchOf(ctx)(ctx.userInfoUrl ?? ANTIGRAVITY_USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": ANTIGRAVITY_USER_AGENT, Accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const body = parseJsonObject(await response.text());
		return typeof body?.email === "string" && body.email ? body.email : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
