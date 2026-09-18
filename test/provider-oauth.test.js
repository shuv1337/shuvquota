/**
 * lib/provider-oauth.js — independent OAuth enrollment, fully mocked.
 * No browser, no network, no pinned ports, no credential files: every side
 * effect goes through `ctx`. Loopback behaviour is exercised on an ephemeral
 * port via listenForOAuthCallback directly.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	ANTIGRAVITY_REDIRECT_URI,
	GROK_OAUTH_PLAN,
	GROK_OAUTH_SCOPES,
	GROK_REDIRECT_URI,
	buildAntigravityAuthorizeUrl,
	buildGrokAuthorizeUrl,
	codexIdentityFromTokens,
	exchangeCodexAuthorizationCode,
	exchangeGrokAuthorizationCode,
	getAntigravityOAuthClient,
	listenForOAuthCallback,
	loginProvider,
	nextRefreshToken,
	normalizeEnrollmentCredential,
	parseOAuthCallbackInput,
	resolveProviderId,
} from "../lib/provider-oauth.js";
import {
	CLAUDE_OAUTH_CLIENT_ID,
	CLAUDE_OAUTH_REDIRECT_URI,
	CLAUDE_OAUTH_TOKEN_URL,
	CLIENT_ID,
	JWT_CLAIM,
	JWT_PROFILE,
	REDIRECT_URI,
	TOKEN_URL,
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_TOKEN_URL,
	ANTIGRAVITY_TOKEN_URL,
} from "../lib/constants.js";
import { runProviderOauthLogin } from "../lib/providers/_util.js";

const NOW = 1_800_000_000_000;
const GOOGLE_ENV = { ANTIGRAVITY_CLIENT_ID: "google-client.apps", ANTIGRAVITY_CLIENT_SECRET: "GOCSPX-fixture-secret" };

/** @param {object} payload */
function jwt(payload) {
	const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

/** @param {object} body @param {number} [status] */
function json(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * fetch double that records every call and routes by URL.
 * @param {(url: string, init: RequestInit) => Response | Promise<Response>} route
 */
function fetchMock(route) {
	const calls = [];
	const fn = async (url, init = {}) => {
		calls.push({ url: String(url), init });
		return route(String(url), init);
	};
	fn.calls = calls;
	return fn;
}

/** @param {RequestInit} init */
function formOf(init) {
	return Object.fromEntries(new URLSearchParams(String(init.body)));
}

/** Captures the authorize URL and answers like a browser redirect would. */
function browserHook(overrides = {}) {
	const seen = {};
	const waitForCallback = async ({ url, state, redirectUri }) => {
		seen.url = new URL(url);
		seen.state = state;
		seen.redirectUri = redirectUri;
		return { code: "auth-code-1", state, ...overrides };
	};
	return { seen, waitForCallback };
}

/** A fetch that never answers but honours its abort signal. */
function hangingFetch() {
	return fetchMock((_url, init) => new Promise((_resolve, reject) => {
		init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
	}));
}

describe("resolveProviderId / client config", () => {
	test("accepts canonical ids and aliases, case-insensitively", () => {
		expect(resolveProviderId("codex")).toBe("codex");
		expect(resolveProviderId(" OpenAI ")).toBe("codex");
		expect(resolveProviderId("anthropic")).toBe("claude");
		expect(resolveProviderId("xai")).toBe("grok");
		expect(resolveProviderId("google")).toBe("antigravity");
	});

	test("rejects unknown providers with a helpful message", () => {
		expect(() => resolveProviderId("factory")).toThrow(/Unknown OAuth provider "factory".*codex, claude, grok, or antigravity/);
		expect(() => resolveProviderId(undefined)).toThrow(/Unknown OAuth provider/);
	});

	test("Antigravity client comes from env only and both halves are required", () => {
		expect(getAntigravityOAuthClient(GOOGLE_ENV)).toEqual({ clientId: "google-client.apps", clientSecret: "GOCSPX-fixture-secret" });
		expect(getAntigravityOAuthClient({ ANTIGRAVITY_CLIENT_ID: "  id  ", ANTIGRAVITY_CLIENT_SECRET: " s " })).toEqual({ clientId: "id", clientSecret: "s" });
		expect(() => getAntigravityOAuthClient({})).toThrow(/ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET/);
		expect(() => getAntigravityOAuthClient({ ANTIGRAVITY_CLIENT_ID: "id" })).toThrow(/ANTIGRAVITY_CLIENT_SECRET/);
		expect(() => getAntigravityOAuthClient({ ANTIGRAVITY_CLIENT_ID: "id", ANTIGRAVITY_CLIENT_SECRET: "   " })).toThrow();
	});

	test("nextRefreshToken keeps the current token when Google omits a replacement", () => {
		expect(nextRefreshToken("old", "new")).toBe("new");
		expect(nextRefreshToken("old", undefined)).toBe("old");
		expect(nextRefreshToken("old", null)).toBe("old");
		expect(nextRefreshToken("old", "")).toBe("old");
		expect(nextRefreshToken("old", 42)).toBe("old");
		expect(nextRefreshToken(null, undefined)).toBeNull();
		expect(nextRefreshToken("", "")).toBeNull();
	});
});

describe("authorize URLs", () => {
	test("Grok: pinned loopback redirect, public client, PKCE S256, state, nonce, generic plan", () => {
		const url = new URL(buildGrokAuthorizeUrl({ challenge: "chal", state: "st", nonce: "nn" }));
		expect(url.origin + url.pathname).toBe("https://auth.x.ai/oauth2/authorize");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			response_type: "code",
			client_id: XAI_OAUTH_CLIENT_ID,
			redirect_uri: "http://127.0.0.1:56121/callback",
			scope: GROK_OAUTH_SCOPES,
			code_challenge: "chal",
			code_challenge_method: "S256",
			state: "st",
			nonce: "nn",
			plan: GROK_OAUTH_PLAN,
		});
		expect(GROK_REDIRECT_URI).toBe("http://127.0.0.1:56121/callback");
		expect(GROK_OAUTH_SCOPES.split(" ")).toContain("offline_access");
	});

	test("Antigravity: env client id, localhost:36742 redirect, offline access with forced consent", () => {
		const url = new URL(buildAntigravityAuthorizeUrl({ challenge: "chal", state: "st", clientId: "cid" }));
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		const params = Object.fromEntries(url.searchParams);
		expect(params).toMatchObject({
			response_type: "code",
			client_id: "cid",
			redirect_uri: "http://localhost:36742/oauth-callback",
			code_challenge: "chal",
			code_challenge_method: "S256",
			access_type: "offline",
			prompt: "consent",
			state: "st",
		});
		expect(params.scope.split(" ")).toContain("https://www.googleapis.com/auth/cloud-platform");
		expect(params.scope.split(" ")).toContain("https://www.googleapis.com/auth/userinfo.email");
		expect(params).not.toHaveProperty("client_secret");
		expect(ANTIGRAVITY_REDIRECT_URI).toBe("http://localhost:36742/oauth-callback");
	});
});

describe("parseOAuthCallbackInput", () => {
	test("accepts a redirect URL, code#state, or a bare code", () => {
		expect(parseOAuthCallbackInput("http://127.0.0.1:56121/callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
		expect(parseOAuthCallbackInput("  abc#xyz\n")).toEqual({ code: "abc", state: "xyz" });
		expect(parseOAuthCallbackInput("abc")).toEqual({ code: "abc", state: null });
		expect(parseOAuthCallbackInput("#xyz")).toEqual({ code: null, state: "xyz" });
		expect(parseOAuthCallbackInput("")).toEqual({ code: null, state: null });
		expect(parseOAuthCallbackInput(undefined)).toEqual({ code: null, state: null });
		expect(parseOAuthCallbackInput("https://example.test/cb?state=only")).toEqual({ code: null, state: "only" });
	});
});

describe("normalizeEnrollmentCredential", () => {
	test("requires access and refresh tokens; the refresh error is actionable", () => {
		expect(() => normalizeEnrollmentCredential("grok", { refreshToken: "r" })).toThrow(/grok login failed: .*no access token/);
		expect(() => normalizeEnrollmentCredential("antigravity", { accessToken: "a" }))
			.toThrow(/antigravity login failed: initial enrollment requires a refresh token.*offline access/);
		expect(() => normalizeEnrollmentCredential("codex", { accessToken: "a", refreshToken: 5 })).toThrow(/refresh token/);
	});

	test("shapes the credential, defaulting expiry to one hour from `now` and dropping empty optionals", () => {
		expect(normalizeEnrollmentCredential("claude", { accessToken: "a", refreshToken: "r" }, NOW)).toEqual({
			accessToken: "a", refreshToken: "r", expiresAt: NOW + 3_600_000, enrollment: "independent",
		});
		const full = normalizeEnrollmentCredential("codex", {
			accessToken: "a", refreshToken: "r", expiresAt: 123, email: "e@x.y", accountId: "acct", projectId: "",
		}, NOW);
		expect(full).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 123, email: "e@x.y", accountId: "acct", enrollment: "independent" });
		expect(normalizeEnrollmentCredential("codex", { accessToken: "a", refreshToken: "r", expiresAt: NaN }, NOW).expiresAt).toBe(NOW + 3_600_000);
	});
});

describe("codexIdentityFromTokens", () => {
	const auth = { chatgpt_account_id: "acct_access" };
	test("prefers the access-token account claim and the id_token email", () => {
		const access = jwt({ [JWT_CLAIM]: auth, [JWT_PROFILE]: { email: "profile@x.y" } });
		expect(codexIdentityFromTokens(access, jwt({ email: "id@x.y" }))).toEqual({ accountId: "acct_access", email: "id@x.y" });
	});
	test("falls back to the id_token account claim and the access-token profile email", () => {
		expect(codexIdentityFromTokens(jwt({ [JWT_PROFILE]: { email: "profile@x.y" } }), jwt({ [JWT_CLAIM]: { chatgpt_account_id: "acct_id" } })))
			.toEqual({ accountId: "acct_id", email: "profile@x.y" });
		expect(codexIdentityFromTokens("not-a-jwt", null)).toEqual({ accountId: null, email: null });
	});
});

describe("loginProvider: codex", () => {
	const access = jwt({ [JWT_CLAIM]: { chatgpt_account_id: "acct_123" }, [JWT_PROFILE]: { email: "profile@example.test" } });

	test("PKCE + state round trip, form exchange, JWT identity, normalized result", async () => {
		const { seen, waitForCallback } = browserHook();
		const fetch = fetchMock(url => {
			expect(url).toBe(TOKEN_URL);
			return json({ access_token: access, refresh_token: "rt-codex", id_token: jwt({ email: "id@example.test" }), expires_in: 600 });
		});
		const opened = [];
		const result = await loginProvider("codex", {
			fetch, waitForCallback, now: () => NOW, openBrowser: (url, opts) => opened.push([url, opts]),
		});

		expect(seen.url.origin + seen.url.pathname).toBe("https://auth.openai.com/oauth/authorize");
		expect(seen.url.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(seen.url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(seen.url.searchParams.get("state")).toBe(seen.state);
		expect(seen.redirectUri).toBe(REDIRECT_URI);
		expect(opened).toEqual([[seen.url.href, { noBrowser: expect.any(Boolean) }]]);

		expect(fetch.calls).toHaveLength(1);
		const form = formOf(fetch.calls[0].init);
		expect(fetch.calls[0].init.method).toBe("POST");
		expect(fetch.calls[0].init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
		expect(form).toMatchObject({ grant_type: "authorization_code", code: "auth-code-1", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI });
		const challenge = createHash("sha256").update(form.code_verifier).digest("base64url");
		expect(seen.url.searchParams.get("code_challenge")).toBe(challenge);
		expect(seen.url.searchParams.get("code_challenge_method")).toBe("S256");

		expect(result).toEqual({
			accessToken: access, refreshToken: "rt-codex", expiresAt: NOW + 600_000,
			email: "id@example.test", accountId: "acct_123", enrollment: "independent",
		});
	});

	test("injected-fetch exchange extracts identity exactly like the default helper (id_token fallback)", async () => {
		const bareAccess = jwt({ [JWT_PROFILE]: { email: "profile@example.test" } });
		const fetch = fetchMock(() => json({
			access_token: bareAccess, refresh_token: "rt", id_token: jwt({ [JWT_CLAIM]: { chatgpt_account_id: "acct_from_id" } }), expires_in: 60,
		}));
		const tokens = await exchangeCodexAuthorizationCode("c", "v", { fetch, now: () => NOW });
		expect(tokens).toEqual({
			accessToken: bareAccess, refreshToken: "rt", idToken: expect.any(String), expires: NOW + 60_000,
			accountId: "acct_from_id", email: "profile@example.test",
		});
		const noIdentity = fetchMock(() => json({ access_token: "opaque", refresh_token: "rt", expires_in: 60 }));
		await expect(exchangeCodexAuthorizationCode("c", "v", { fetch: noIdentity })).rejects.toThrow(/could not extract account_id/);
	});

	test("missing refresh token in the exchange is a clear failure, not a stored row", async () => {
		const fetch = fetchMock(() => json({ access_token: access, expires_in: 60 }));
		const { waitForCallback } = browserHook();
		await expect(loginProvider("codex", { fetch, waitForCallback, openBrowser() {} })).rejects.toThrow(/missing refresh_token/);
	});

	test("state mismatch from the callback aborts before any token exchange", async () => {
		const fetch = fetchMock(() => json({}));
		const { waitForCallback } = browserHook({ state: "someone-else" });
		await expect(loginProvider("codex", { fetch, waitForCallback, openBrowser() {} })).rejects.toThrow(/State mismatch/);
		await expect(loginProvider("codex", { fetch, waitForCallback: async () => ({ code: "" }), openBrowser() {} }))
			.rejects.toThrow(/No authorization code/);
		expect(fetch.calls).toHaveLength(0);
	});
});

describe("loginProvider: claude (pasted code#state)", () => {
	const tokenBody = { access_token: "sk-ant-oat-fixture", refresh_token: "sk-ant-ort-fixture", expires_in: 28_800 };

	test("prints the authorize URL, validates the pasted state, posts JSON with the state, normalizes expiry", async () => {
		let expectedState;
		const opened = [];
		const fetch = fetchMock(url => {
			expect(url).toBe(CLAUDE_OAUTH_TOKEN_URL);
			return json(tokenBody);
		});
		const result = await loginProvider("claude", {
			fetch,
			now: () => NOW,
			openBrowser: url => { opened.push(url); expectedState = new URL(url).searchParams.get("state"); },
			prompt: async message => {
				expect(message).toMatch(/code#state/);
				return `pasted-code#${expectedState}`;
			},
		});
		expect(opened).toHaveLength(1);
		expect(new URL(opened[0]).searchParams.get("redirect_uri")).toBe(CLAUDE_OAUTH_REDIRECT_URI);
		expect(new URL(opened[0]).searchParams.get("code")).toBe("true");

		const { init } = fetch.calls[0];
		expect(init.headers["Content-Type"]).toBe("application/json");
		expect(JSON.parse(String(init.body))).toMatchObject({
			grant_type: "authorization_code", code: "pasted-code", state: expectedState,
			redirect_uri: CLAUDE_OAUTH_REDIRECT_URI, client_id: CLAUDE_OAUTH_CLIENT_ID, code_verifier: expect.any(String),
		});
		expect(result).toEqual({
			accessToken: "sk-ant-oat-fixture", refreshToken: "sk-ant-ort-fixture", expiresAt: NOW + 28_800_000, enrollment: "independent",
		});
	});

	test("accepts the full callback URL and a bare code (state validation skipped only when absent)", async () => {
		let expectedState;
		const fetch = fetchMock(() => json(tokenBody));
		const openBrowser = url => { expectedState = new URL(url).searchParams.get("state"); };
		await expect(loginProvider("claude", {
			fetch, openBrowser, prompt: async () => `${CLAUDE_OAUTH_REDIRECT_URI}?code=url-code&state=${expectedState}`,
		})).resolves.toMatchObject({ enrollment: "independent" });
		expect(JSON.parse(String(fetch.calls.at(-1).init.body)).code).toBe("url-code");
		await expect(loginProvider("claude", { fetch, openBrowser, prompt: async () => "bare-code" }))
			.resolves.toMatchObject({ enrollment: "independent" });
		expect(JSON.parse(String(fetch.calls.at(-1).init.body)).code).toBe("bare-code");
	});

	test("a pasted state that does not match the expected state is rejected without an exchange", async () => {
		const fetch = fetchMock(() => json(tokenBody));
		await expect(loginProvider("claude", { fetch, openBrowser() {}, prompt: async () => "code#forged-state" }))
			.rejects.toThrow(/State mismatch/);
		await expect(loginProvider("claude", { fetch, openBrowser() {}, prompt: async () => "" }))
			.rejects.toThrow(/No authorization code/);
		expect(fetch.calls).toHaveLength(0);
	});

	test("Claude without a refresh token cannot be enrolled independently", async () => {
		const fetch = fetchMock(() => json({ access_token: "sk-ant-oat", expires_in: 60 }));
		await expect(loginProvider("claude", { fetch, openBrowser() {}, prompt: async () => "code" }))
			.rejects.toThrow(/claude login failed: initial enrollment requires a refresh token/);
	});
});

describe("loginProvider: grok", () => {
	const access = jwt({ sub: "xai-user-1", email: "grok@example.test", tier: 2 });

	test("pinned 127.0.0.1:56121 redirect, nonce, public client exchange, JWT profile", async () => {
		const { seen, waitForCallback } = browserHook();
		const fetch = fetchMock(url => {
			expect(url).toBe(XAI_OAUTH_TOKEN_URL);
			return json({ access_token: access, refresh_token: "rt-grok", expires_in: 3600 });
		});
		const result = await loginProvider("grok", { fetch, waitForCallback, now: () => NOW, headless: true, stdout: { write() {} } });

		expect(seen.redirectUri).toBe(GROK_REDIRECT_URI);
		expect(seen.url.searchParams.get("nonce")).toMatch(/^[0-9a-f]{64}$/);
		expect(seen.url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
		expect(seen.url.searchParams.get("nonce")).not.toBe(seen.url.searchParams.get("state"));
		const form = formOf(fetch.calls[0].init);
		expect(form).toMatchObject({ grant_type: "authorization_code", code: "auth-code-1", redirect_uri: GROK_REDIRECT_URI, client_id: XAI_OAUTH_CLIENT_ID });
		expect(form).not.toHaveProperty("client_secret");
		expect(createHash("sha256").update(form.code_verifier).digest("base64url")).toBe(seen.url.searchParams.get("code_challenge"));

		expect(result).toEqual({
			accessToken: access, refreshToken: "rt-grok", expiresAt: NOW + 3_600_000,
			email: "grok@example.test", accountId: "xai-user-1", enrollment: "independent",
		});
	});

	test("headless with no openBrowser writes the URL to ctx.stdout and never opens a browser", async () => {
		const lines = [];
		const fetch = fetchMock(() => json({ access_token: access, refresh_token: "rt", expires_in: 1 }));
		await loginProvider("grok", { fetch, waitForCallback: async ({ state }) => ({ code: "c", state }), headless: true, stdout: { write: s => lines.push(s) } });
		expect(lines.join("")).toMatch(/Open this URL in your browser[\s\S]*https:\/\/auth\.x\.ai\/oauth2\/authorize\?/);
	});

	test("provider HTTP errors surface status and error code but never the request body", async () => {
		const fetch = fetchMock(() => json({ error: "invalid_grant", error_description: "code expired" }, 400));
		const err = await exchangeGrokAuthorizationCode("secret-code", "secret-verifier", { fetch }).catch(e => e);
		expect(err.message).toBe("Token exchange failed: HTTP 400 (invalid_grant: code expired)");
		expect(err.message).not.toContain("secret-code");
		expect(err.message).not.toContain("secret-verifier");
		const html = fetchMock(() => new Response("<html>", { status: 502 }));
		await expect(exchangeGrokAuthorizationCode("c", "v", { fetch: html })).rejects.toThrow("Token exchange failed: HTTP 502");
		const garbage = fetchMock(() => new Response("not json", { status: 200 }));
		await expect(exchangeGrokAuthorizationCode("c", "v", { fetch: garbage })).rejects.toThrow(/invalid JSON/);
	});

	test("token exchange honours timeoutMs and ctx.signal, cleaning up its abort listener", async () => {
		const slow = hangingFetch();
		await expect(exchangeGrokAuthorizationCode("c", "v", { fetch: slow, timeoutMs: 20 })).rejects.toThrow(/timed out after 0 seconds/);
		expect(slow.calls[0].init.signal.aborted).toBe(true);

		const controller = new AbortController();
		const pending = exchangeGrokAuthorizationCode("c", "v", { fetch: hangingFetch(), signal: controller.signal, timeoutMs: 5000 });
		controller.abort();
		await expect(pending).rejects.toThrow(/cancelled/);

		const preAborted = new AbortController();
		preAborted.abort();
		await expect(loginProvider("grok", { signal: preAborted.signal })).rejects.toThrow(/cancelled/);
	});

	test("the provider registry helper accepts the result as an independent enrollment", async () => {
		const fetch = fetchMock(() => json({ access_token: access, refresh_token: "rt", expires_in: 1 }));
		const result = await runProviderOauthLogin("grok", { fetch, waitForCallback: async ({ state }) => ({ code: "c", state }), headless: true, stdout: { write() {} } });
		expect(result).toMatchObject({ enrollment: "independent", accountId: "xai-user-1" });
	});
});

describe("loginProvider: antigravity (Google)", () => {
	const tokenOk = (extra = {}) => ({ access_token: "ya29.fixture", refresh_token: "1//fixture-refresh", expires_in: 3599, ...extra });

	/** Route Google token, Cloud Code, and userinfo calls. */
	function googleFetch({ token = tokenOk(), project = { cloudaicompanionProject: "projects/fixture-1" }, userinfo = { email: "userinfo@example.test" }, tokenStatus = 200 } = {}) {
		return fetchMock(url => {
			if (url === ANTIGRAVITY_TOKEN_URL) return json(token, tokenStatus);
			if (url.endsWith("/v1internal:loadCodeAssist")) return project instanceof Response ? project : json(project);
			if (url.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) return json(userinfo);
			throw new Error(`unexpected fetch ${url}`);
		});
	}

	test("fails before opening a browser when the env client is missing", async () => {
		const opened = [];
		await expect(loginProvider("antigravity", { env: {}, openBrowser: url => opened.push(url), waitForCallback: async () => ({ code: "c" }) }))
			.rejects.toThrow(/ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET/);
		expect(opened).toHaveLength(0);
	});

	test("PKCE offline-consent flow, secret sent only to the token endpoint, project id + id_token email", async () => {
		const { seen, waitForCallback } = browserHook();
		const fetch = googleFetch({ token: tokenOk({ id_token: jwt({ email: "idtoken@example.test" }) }) });
		const result = await loginProvider("antigravity", { env: GOOGLE_ENV, fetch, waitForCallback, now: () => NOW, openBrowser() {} });

		expect(seen.redirectUri).toBe(ANTIGRAVITY_REDIRECT_URI);
		expect(seen.url.searchParams.get("client_id")).toBe(GOOGLE_ENV.ANTIGRAVITY_CLIENT_ID);
		expect(seen.url.searchParams.get("access_type")).toBe("offline");
		expect(seen.url.searchParams.get("prompt")).toBe("consent");
		expect(seen.url.href).not.toContain(GOOGLE_ENV.ANTIGRAVITY_CLIENT_SECRET);

		const tokenCall = fetch.calls.find(c => c.url === ANTIGRAVITY_TOKEN_URL);
		const form = formOf(tokenCall.init);
		expect(form).toMatchObject({
			grant_type: "authorization_code", code: "auth-code-1", client_id: GOOGLE_ENV.ANTIGRAVITY_CLIENT_ID,
			client_secret: GOOGLE_ENV.ANTIGRAVITY_CLIENT_SECRET, redirect_uri: ANTIGRAVITY_REDIRECT_URI,
		});
		expect(createHash("sha256").update(form.code_verifier).digest("base64url")).toBe(seen.url.searchParams.get("code_challenge"));

		const codeAssist = fetch.calls.find(c => c.url.endsWith("/v1internal:loadCodeAssist"));
		expect(codeAssist.init.headers.Authorization).toBe("Bearer ya29.fixture");
		expect(JSON.parse(String(codeAssist.init.body))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
		expect(fetch.calls.some(c => c.url.includes("userinfo"))).toBe(false);

		expect(result).toEqual({
			accessToken: "ya29.fixture", refreshToken: "1//fixture-refresh", expiresAt: NOW + 3_599_000,
			email: "idtoken@example.test", projectId: "projects/fixture-1", enrollment: "independent",
		});
	});

	test("without an id_token email, userinfo supplies it; project discovery failure is non-fatal", async () => {
		const fetch = googleFetch({ project: new Response("boom", { status: 500 }) });
		const result = await loginProvider("antigravity", {
			env: GOOGLE_ENV, fetch, waitForCallback: async ({ state }) => ({ code: "c", state }), openBrowser() {},
		});
		expect(result.email).toBe("userinfo@example.test");
		expect(result).not.toHaveProperty("projectId");
		expect(result.enrollment).toBe("independent");
	});

	test("Google omitting refresh_token on initial enrollment is a clear, actionable error", async () => {
		const fetch = googleFetch({ token: { access_token: "ya29", expires_in: 10 } });
		await expect(loginProvider("antigravity", {
			env: GOOGLE_ENV, fetch, waitForCallback: async ({ state }) => ({ code: "c", state }), openBrowser() {},
		})).rejects.toThrow(/antigravity login failed: initial enrollment requires a refresh token.*offline access/);
	});

	test("token endpoint failures never leak the client secret", async () => {
		const fetch = googleFetch({ token: { error: "invalid_client", error_description: "Unauthorized" }, tokenStatus: 401 });
		const err = await loginProvider("antigravity", {
			env: GOOGLE_ENV, fetch, waitForCallback: async ({ state }) => ({ code: "c", state }), openBrowser() {},
		}).catch(e => e);
		expect(err.message).toBe("Token exchange failed: HTTP 401 (invalid_client: Unauthorized)");
		expect(err.message).not.toContain(GOOGLE_ENV.ANTIGRAVITY_CLIENT_SECRET);
	});
});

describe("listenForOAuthCallback (real loopback on an ephemeral port)", () => {
	const listen = (overrides = {}) => listenForOAuthCallback({ port: 0, path: "/callback", expectedState: "expected", timeoutMs: 5000, ...overrides });

	/** @param {number} port @param {string} query */
	async function hit(port, query, path = "/callback") {
		const response = await fetch(`http://127.0.0.1:${port}${path}${query}`);
		return { status: response.status, body: await response.text() };
	}

	async function expectClosed(port) {
		await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
	}

	test("resolves with the code on a matching state and closes the server", async () => {
		const listener = await listen();
		expect(listener.port).toBeGreaterThan(0);
		const response = await hit(listener.port, "?code=abc&state=expected");
		expect(response.status).toBe(200);
		expect(response.body).toContain("<!DOCTYPE html>");
		await expect(listener.wait).resolves.toEqual({ code: "abc", state: "expected" });
		await listener.close();
		await expectClosed(listener.port);
	});

	test("rejects on state mismatch, provider error, or missing code with a 4xx/error page", async () => {
		const mismatch = await listen();
		expect((await hit(mismatch.port, "?code=abc&state=forged")).status).toBe(400);
		await expect(mismatch.wait).rejects.toThrow(/State mismatch/);
		await mismatch.close();

		const denied = await listen();
		const page = await hit(denied.port, "?error=access_denied&error_description=User%20declined");
		expect(page.status).toBe(200);
		expect(page.body).toContain("access_denied");
		await expect(denied.wait).rejects.toThrow("OAuth error: access_denied: User declined");
		await denied.close();

		const missing = await listen();
		expect((await hit(missing.port, "?state=expected")).status).toBe(400);
		await expect(missing.wait).rejects.toThrow(/Missing authorization code/);
		await missing.close();
	});

	test("ignores other paths without settling", async () => {
		const listener = await listen();
		expect((await hit(listener.port, "", "/favicon.ico")).status).toBe(404);
		const outcome = await Promise.race([listener.wait.then(() => "settled", () => "settled"), new Promise(r => setTimeout(() => r("pending"), 50))]);
		expect(outcome).toBe("pending");
		await listener.close();
		await expect(listener.wait).rejects.toThrow(/cancelled/);
		await expectClosed(listener.port);
	});

	test("times out and releases the port", async () => {
		const listener = await listen({ timeoutMs: 30 });
		await expect(listener.wait).rejects.toThrow(/timed out after 0 seconds/);
		await expectClosed(listener.port);
	});

	test("abort signal cancels, closes the server, and detaches its listener", async () => {
		const controller = new AbortController();
		const listener = await listen({ signal: controller.signal });
		controller.abort();
		await expect(listener.wait).rejects.toThrow(/cancelled/);
		await expectClosed(listener.port);
		expect(controller.signal.aborted).toBe(true);

		const pre = new AbortController();
		pre.abort();
		const dead = await listen({ signal: pre.signal });
		await expect(dead.wait).rejects.toThrow(/cancelled/);
		await expectClosed(dead.port);
	});

	test("a busy port is reported by number", async () => {
		const first = await listen();
		await expect(listenForOAuthCallback({ port: first.port, path: "/callback", expectedState: "s" }))
			.rejects.toThrow(`Port ${first.port} is in use`);
		await first.close();
	});
});
