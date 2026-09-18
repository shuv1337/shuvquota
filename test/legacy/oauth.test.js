/**
 * Legacy OAuth utilities tests migrated from shuvquota.test.js
 * Run with: bun test test/legacy/oauth.test.js
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	generatePKCE,
	generateState,
	buildAuthUrl,
	checkPortAvailable,
	isHeadlessEnvironment,
	openBrowser,
	startCallbackServer,
	exchangeCodeForTokens,
} from "../../lib/oauth.js";

import {
	buildClaudeAuthUrl,
	parseClaudeCodeState,
} from "../../lib/claude-oauth.js";

function createMockAccessToken(accountId, email = "test@example.com", planType = "plus") {
	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		"https://api.openai.com/auth": {
			chatgpt_account_id: accountId,
			chatgpt_plan_type: planType,
		},
		"https://api.openai.com/profile": {
			email,
		},
	};
	const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64");
	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
	return `${headerB64}.${payloadB64}.fake_signature`;
}

// ─────────────────────────────────────────────────────────────────────────────
// generatePKCE tests
// ─────────────────────────────────────────────────────────────────────────────

describe("generatePKCE", () => {
	test("returns object with verifier and challenge", () => {
		const pkce = generatePKCE();
		expect(pkce).toHaveProperty("verifier");
		expect(pkce).toHaveProperty("challenge");
	});

	test("verifier is 43 characters (32 bytes base64url)", () => {
		const pkce = generatePKCE();
		expect(pkce.verifier.length).toBe(43);
	});

	test("challenge is 43 characters (SHA256 in base64url)", () => {
		const pkce = generatePKCE();
		expect(pkce.challenge.length).toBe(43);
	});

	test("returns different values on each call", () => {
		const pkce1 = generatePKCE();
		const pkce2 = generatePKCE();
		expect(pkce1.verifier).not.toBe(pkce2.verifier);
		expect(pkce1.challenge).not.toBe(pkce2.challenge);
	});

	test("verifier is valid base64url (no +, /, or = chars)", () => {
		const pkce = generatePKCE();
		expect(pkce.verifier).not.toMatch(/[+/=]/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// generateState tests
// ─────────────────────────────────────────────────────────────────────────────

describe("generateState", () => {
	test("returns 64-character hex string", () => {
		const state = generateState();
		expect(state.length).toBe(64);
	});

	test("returns valid hex characters only", () => {
		const state = generateState();
		expect(state).toMatch(/^[0-9a-f]+$/);
	});

	test("returns different values on each call", () => {
		const state1 = generateState();
		const state2 = generateState();
		expect(state1).not.toBe(state2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildAuthUrl tests
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAuthUrl", () => {
	test("returns valid URL starting with AUTHORIZE_URL", () => {
		const pkce = generatePKCE();
		const state = generateState();
		const url = buildAuthUrl(pkce.challenge, state);
		
		expect(url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
	});

	test("includes all required OAuth parameters", () => {
		const pkce = generatePKCE();
		const state = generateState();
		const url = buildAuthUrl(pkce.challenge, state);
		const parsed = new URL(url);
		
		expect(parsed.searchParams.get("response_type")).toBe("code");
		expect(parsed.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
		expect(parsed.searchParams.get("scope")).toBe("openid profile email offline_access");
		expect(parsed.searchParams.get("code_challenge")).toBe(pkce.challenge);
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("state")).toBe(state);
	});

	test("URL is parseable by URL constructor", () => {
		const pkce = generatePKCE();
		const state = generateState();
		const url = buildAuthUrl(pkce.challenge, state);
		
		expect(() => new URL(url)).not.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// checkPortAvailable tests
// ─────────────────────────────────────────────────────────────────────────────

describe("checkPortAvailable", () => {
	test("returns true for available port", async () => {
		// Use a high port that's unlikely to be in use
		const result = await checkPortAvailable(59999);
		expect(result).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// isHeadlessEnvironment tests
// ─────────────────────────────────────────────────────────────────────────────

describe("isHeadlessEnvironment", () => {
	let originalSSH_CLIENT;
	let originalSSH_TTY;
	let originalDISPLAY;
	let originalWAYLAND_DISPLAY;

	beforeEach(() => {
		// Save original env values
		originalSSH_CLIENT = process.env.SSH_CLIENT;
		originalSSH_TTY = process.env.SSH_TTY;
		originalDISPLAY = process.env.DISPLAY;
		originalWAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY;
		// Clear all relevant env vars for clean test state
		delete process.env.SSH_CLIENT;
		delete process.env.SSH_TTY;
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
	});

	afterEach(() => {
		// Restore original env values
		if (originalSSH_CLIENT === undefined) {
			delete process.env.SSH_CLIENT;
		} else {
			process.env.SSH_CLIENT = originalSSH_CLIENT;
		}
		if (originalSSH_TTY === undefined) {
			delete process.env.SSH_TTY;
		} else {
			process.env.SSH_TTY = originalSSH_TTY;
		}
		if (originalDISPLAY === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDISPLAY;
		}
		if (originalWAYLAND_DISPLAY === undefined) {
			delete process.env.WAYLAND_DISPLAY;
		} else {
			process.env.WAYLAND_DISPLAY = originalWAYLAND_DISPLAY;
		}
	});

	test("returns true when SSH_CLIENT is set", () => {
		process.env.SSH_CLIENT = "192.168.1.100 50000 22";
		expect(isHeadlessEnvironment()).toBe(true);
	});

	test("returns true when SSH_TTY is set", () => {
		process.env.SSH_TTY = "/dev/pts/0";
		expect(isHeadlessEnvironment()).toBe(true);
	});

	test("returns true when both SSH_CLIENT and SSH_TTY are set", () => {
		process.env.SSH_CLIENT = "192.168.1.100 50000 22";
		process.env.SSH_TTY = "/dev/pts/0";
		expect(isHeadlessEnvironment()).toBe(true);
	});

	test("returns false when SSH vars not set and DISPLAY is available (non-Linux or Linux with display)", () => {
		// Clear SSH vars (already done in beforeEach)
		// Set DISPLAY to simulate graphical environment
		process.env.DISPLAY = ":0";
		const result = isHeadlessEnvironment();
		expect(result).toBe(false);
	});

	test("SSH detection takes priority over display availability", () => {
		// Even with DISPLAY set, SSH session should return true
		process.env.DISPLAY = ":0";
		process.env.SSH_CLIENT = "192.168.1.100 50000 22";
		expect(isHeadlessEnvironment()).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// openBrowser tests
// ─────────────────────────────────────────────────────────────────────────────

describe("openBrowser", () => {
	let originalSSH_CLIENT;
	let originalSSH_TTY;
	let originalDISPLAY;
	let originalWAYLAND_DISPLAY;
	let consoleLogSpy;
	let originalConsoleLog;

	beforeEach(() => {
		// Save original env values
		originalSSH_CLIENT = process.env.SSH_CLIENT;
		originalSSH_TTY = process.env.SSH_TTY;
		originalDISPLAY = process.env.DISPLAY;
		originalWAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY;
		// Clear all relevant env vars for clean test state
		delete process.env.SSH_CLIENT;
		delete process.env.SSH_TTY;
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
		// Spy on console.log
		originalConsoleLog = console.log;
		consoleLogSpy = [];
		console.log = (...args) => {
			consoleLogSpy.push(args.join(" "));
		};
	});

	afterEach(() => {
		// Restore console.log
		console.log = originalConsoleLog;
		// Restore original env values
		if (originalSSH_CLIENT === undefined) {
			delete process.env.SSH_CLIENT;
		} else {
			process.env.SSH_CLIENT = originalSSH_CLIENT;
		}
		if (originalSSH_TTY === undefined) {
			delete process.env.SSH_TTY;
		} else {
			process.env.SSH_TTY = originalSSH_TTY;
		}
		if (originalDISPLAY === undefined) {
			delete process.env.DISPLAY;
		} else {
			process.env.DISPLAY = originalDISPLAY;
		}
		if (originalWAYLAND_DISPLAY === undefined) {
			delete process.env.WAYLAND_DISPLAY;
		} else {
			process.env.WAYLAND_DISPLAY = originalWAYLAND_DISPLAY;
		}
	});

	test("returns false and prints URL when --no-browser option is set", () => {
		const testUrl = "https://auth.openai.com/authorize?test=123";
		const result = openBrowser(testUrl, { noBrowser: true });
		
		expect(result).toBe(false);
		// Check that URL was printed to console
		const logOutput = consoleLogSpy.join("\n");
		expect(logOutput).toContain(testUrl);
		expect(logOutput).toContain("Open this URL in your browser");
	});

	test("returns false and prints URL in headless environment (SSH_CLIENT set)", () => {
		process.env.SSH_CLIENT = "192.168.1.100 50000 22";
		const testUrl = "https://auth.openai.com/authorize?test=456";
		const result = openBrowser(testUrl, {});
		
		expect(result).toBe(false);
		const logOutput = consoleLogSpy.join("\n");
		expect(logOutput).toContain(testUrl);
		expect(logOutput).toContain("Open this URL in your browser");
	});

	test("returns false and prints URL in headless environment (SSH_TTY set)", () => {
		process.env.SSH_TTY = "/dev/pts/0";
		const testUrl = "https://auth.openai.com/authorize?test=789";
		const result = openBrowser(testUrl, {});
		
		expect(result).toBe(false);
		const logOutput = consoleLogSpy.join("\n");
		expect(logOutput).toContain(testUrl);
		expect(logOutput).toContain("Open this URL in your browser");
	});

	test("--no-browser option takes priority over display availability", () => {
		// Even with DISPLAY set (non-headless), --no-browser should still print URL
		process.env.DISPLAY = ":0";
		const testUrl = "https://auth.openai.com/authorize?test=priority";
		const result = openBrowser(testUrl, { noBrowser: true });
		
		expect(result).toBe(false);
		const logOutput = consoleLogSpy.join("\n");
		expect(logOutput).toContain(testUrl);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// startCallbackServer tests
// ─────────────────────────────────────────────────────────────────────────────

describe("startCallbackServer", () => {
	test("starts and listens on port 1455", async () => {
		const expectedState = generateState();
		
		// Start the server
		const serverPromise = startCallbackServer(expectedState);
		
		// Give the server time to start listening
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Verify the port is now in use (server is listening)
		const portAvailable = await checkPortAvailable(1455);
		expect(portAvailable).toBe(false);
		
		// Simulate a successful callback to clean up
		const response = await fetch(`http://127.0.0.1:1455/auth/callback?code=test_code&state=${expectedState}`);
		expect(response.ok).toBe(true);
		
		// Get the result
		const result = await serverPromise;
		expect(result.code).toBe("test_code");
		expect(result.state).toBe(expectedState);
	});

	test("returns code and state from callback URL", async () => {
		const expectedState = generateState();
		const testCode = "authorization_code_123";
		
		// Start the server
		const serverPromise = startCallbackServer(expectedState);
		
		// Give the server time to start
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Simulate callback with code and state
		const response = await fetch(`http://127.0.0.1:1455/auth/callback?code=${testCode}&state=${expectedState}`);
		expect(response.ok).toBe(true);
		
		// Verify the result
		const result = await serverPromise;
		expect(result.code).toBe(testCode);
		expect(result.state).toBe(expectedState);
	});

	test("rejects on state mismatch (CSRF protection)", async () => {
		const expectedState = generateState();
		const wrongState = generateState(); // Different state
		
		// Start the server and immediately attach error handler to prevent uncaught rejection
		let error = null;
		const serverPromise = startCallbackServer(expectedState).catch(e => {
			error = e;
		});
		
		// Give the server time to start
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Simulate callback with wrong state
		const response = await fetch(`http://127.0.0.1:1455/auth/callback?code=test_code&state=${wrongState}`);
		expect(response.status).toBe(400);
		
		// Wait for the promise to complete
		await serverPromise;
		
		// Verify the error was caught
		expect(error).not.toBeNull();
		expect(error.message).toContain("State mismatch");
	});

	test("rejects on OAuth error in callback", async () => {
		const expectedState = generateState();
		
		// Start the server and immediately attach error handler to prevent uncaught rejection
		let error = null;
		const serverPromise = startCallbackServer(expectedState).catch(e => {
			error = e;
		});
		
		// Give the server time to start
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Simulate error callback (user denied access)
		const response = await fetch(`http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=User%20denied%20access`);
		expect(response.ok).toBe(true); // Error page is still a 200 response
		
		// Wait for the promise to complete
		await serverPromise;
		
		// Verify the error was caught
		expect(error).not.toBeNull();
		expect(error.message).toContain("OAuth error");
	});

	test("returns 404 for non-callback paths", async () => {
		const expectedState = generateState();
		
		// Start the server
		const serverPromise = startCallbackServer(expectedState);
		
		// Give the server time to start
		await new Promise(resolve => setTimeout(resolve, 100));
		
		// Try a non-callback path
		const response = await fetch("http://127.0.0.1:1455/other/path");
		expect(response.status).toBe(404);
		
		// Clean up by sending valid callback
		await fetch(`http://127.0.0.1:1455/auth/callback?code=cleanup&state=${expectedState}`);
		await serverPromise;
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// exchangeCodeForTokens tests
// ─────────────────────────────────────────────────────────────────────────────

describe("exchangeCodeForTokens", () => {
	let originalFetch;

	beforeEach(() => {
		// Save original fetch
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		// Restore original fetch
		globalThis.fetch = originalFetch;
	});

	// Helper to create a mock id_token with email claim
	function createMockIdToken(email) {
		const header = { alg: "RS256", typ: "JWT" };
		const payload = { email };
		const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64");
		const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
		return `${headerB64}.${payloadB64}.fake_signature`;
	}

	test("returns token object with all required fields on success", async () => {
		const mockAccessToken = createMockAccessToken("acc_test_123", "user@example.com", "plus");
		const mockIdToken = createMockIdToken("user@example.com");
		
		// Mock successful token exchange response
		globalThis.fetch = async (url, options) => {
			// Verify the request is correct
			expect(url).toBe("https://auth.openai.com/oauth/token");
			expect(options.method).toBe("POST");
			expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
			
			// Verify body contains required parameters
			const body = new URLSearchParams(options.body);
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code")).toBe("test_auth_code");
			expect(body.get("code_verifier")).toBe("test_verifier");
			
			return new Response(JSON.stringify({
				access_token: mockAccessToken,
				refresh_token: "refresh_token_xyz",
				id_token: mockIdToken,
				expires_in: 3600, // 1 hour
				token_type: "Bearer",
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		const result = await exchangeCodeForTokens("test_auth_code", "test_verifier");
		
		// Verify all required fields are present
		expect(result).toHaveProperty("accessToken");
		expect(result).toHaveProperty("refreshToken");
		expect(result).toHaveProperty("idToken");
		expect(result).toHaveProperty("expires");
		expect(result).toHaveProperty("accountId");
		expect(result).toHaveProperty("email");
		
		// Verify field values
		expect(result.accessToken).toBe(mockAccessToken);
		expect(result.refreshToken).toBe("refresh_token_xyz");
		expect(result.idToken).toBe(mockIdToken);
		expect(result.accountId).toBe("acc_test_123");
		expect(result.email).toBe("user@example.com");
		
		// Verify expires is a timestamp in the future (within ~1 hour)
		const now = Date.now();
		expect(result.expires).toBeGreaterThan(now);
		expect(result.expires).toBeLessThan(now + 3700 * 1000); // Allow slight margin
	});

	test("throws error on HTTP error response", async () => {
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				error: "invalid_grant",
				error_description: "Authorization code has expired",
			}), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		await expect(exchangeCodeForTokens("invalid_code", "verifier")).rejects.toThrow("Token exchange failed");
		await expect(exchangeCodeForTokens("invalid_code", "verifier")).rejects.toThrow("Authorization code has expired");
	});

	test("throws error when access_token is missing", async () => {
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				refresh_token: "refresh_token_xyz",
				expires_in: 3600,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		await expect(exchangeCodeForTokens("code", "verifier")).rejects.toThrow("Missing access_token");
	});

	test("throws error when refresh_token is missing", async () => {
		const mockAccessToken = createMockAccessToken("acc_test_123");
		
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				access_token: mockAccessToken,
				expires_in: 3600,
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		await expect(exchangeCodeForTokens("code", "verifier")).rejects.toThrow("Missing refresh_token");
	});

	test("handles response without id_token (idToken is null)", async () => {
		const mockAccessToken = createMockAccessToken("acc_test_456", "notoken@example.com");
		
		globalThis.fetch = async () => {
			return new Response(JSON.stringify({
				access_token: mockAccessToken,
				refresh_token: "refresh_xyz",
				expires_in: 3600,
				// No id_token in response
			}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		
		const result = await exchangeCodeForTokens("code", "verifier");
		
		expect(result.idToken).toBeNull();
		expect(result.accountId).toBe("acc_test_456");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude OAuth browser flow tests
// ─────────────────────────────────────────────────────────────────────────────

describe("buildClaudeAuthUrl", () => {
	test("builds URL with correct base and required parameters", () => {
		const codeChallenge = "test_challenge_abc123";
		const state = "test_state_xyz789";
		const url = buildClaudeAuthUrl(codeChallenge, state);
		
		expect(url).toContain("https://claude.ai/oauth/authorize");
		expect(url).toContain("response_type=code");
		expect(url).toContain("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e");
		expect(url).toContain("redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback");
		expect(url).toContain("code_challenge=" + codeChallenge);
		expect(url).toContain("code_challenge_method=S256");
		expect(url).toContain("state=" + state);
		expect(url).toContain("code=true");
	});

	test("includes scopes with %20 encoding for spaces", () => {
		const url = buildClaudeAuthUrl("challenge", "state");
		expect(url).toContain("scope=org%3Acreate_api_key%20user%3Aprofile%20user%3Ainference");
	});

	test("works with PKCE values from generatePKCE", () => {
		const { verifier, challenge } = generatePKCE();
		const state = generateState();
		const url = buildClaudeAuthUrl(challenge, state);
		
		expect(url).toContain(challenge);
		expect(url).toContain(state);
		// Verify URL is parseable
		expect(() => new URL(url)).not.toThrow();
	});
});

describe("parseClaudeCodeState", () => {
	test("parses code#state format", () => {
		const result = parseClaudeCodeState("abc123#xyz789");
		expect(result.code).toBe("abc123");
		expect(result.state).toBe("xyz789");
	});

	test("parses code only (no state)", () => {
		const result = parseClaudeCodeState("abc123");
		expect(result.code).toBe("abc123");
		expect(result.state).toBeNull();
	});

	test("parses full callback URL", () => {
		const result = parseClaudeCodeState(
			"https://console.anthropic.com/oauth/code/callback?code=abc123&state=xyz789"
		);
		expect(result.code).toBe("abc123");
		expect(result.state).toBe("xyz789");
	});

	test("parses callback URL without state parameter", () => {
		const result = parseClaudeCodeState(
			"https://console.anthropic.com/oauth/code/callback?code=abc123"
		);
		expect(result.code).toBe("abc123");
		expect(result.state).toBeNull();
	});

	test("returns null for empty input", () => {
		const result = parseClaudeCodeState("");
		expect(result.code).toBeNull();
		expect(result.state).toBeNull();
	});

	test("returns null for null input", () => {
		const result = parseClaudeCodeState(null);
		expect(result.code).toBeNull();
		expect(result.state).toBeNull();
	});

	test("returns null for undefined input", () => {
		const result = parseClaudeCodeState(undefined);
		expect(result.code).toBeNull();
		expect(result.state).toBeNull();
	});

	test("trims whitespace from input", () => {
		const result = parseClaudeCodeState("  abc123#xyz789  ");
		expect(result.code).toBe("abc123");
		expect(result.state).toBe("xyz789");
	});

	test("handles code with empty state after # (treats empty as null)", () => {
		const result = parseClaudeCodeState("abc123#");
		expect(result.code).toBe("abc123");
		expect(result.state).toBeNull();
	});

	test("returns null for invalid URL", () => {
		const result = parseClaudeCodeState("http://invalid url with spaces");
		expect(result.code).toBeNull();
		expect(result.state).toBeNull();
	});
});
