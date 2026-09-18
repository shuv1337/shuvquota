import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	QuotaLoadError,
	buildAllowedHosts,
	createQuotaLoader,
	createShuvquotaServer,
	getMimeType,
	isAllowedHost,
	resolveStaticFile,
} from "./lib/shuvquota-server.js";
import { parseShuvquotaPort } from "./shuvquota-server.js";

const FIXED_NOW = new Date("2026-07-16T12:00:00.000Z");

// A broken projection module must fail the suite, never skip privacy coverage.
await import("./lib/snapshot.js");

function maliciousV2Payload() {
	return {
		schemaVersion: 2,
		providers: [
			{
				id: "codex",
				name: "Codex",
				accounts: [
					{
						label: "work<script>",
						email: "user-secret-email@example.com",
						plan: "Pro",
						status: "ok",
						windows: [
							{
								id: "session",
								label: "Session",
								percentRemaining: 0,
								resetsAt: "2026-07-16T16:00:00.000Z",
								detail: "/home/private/secret-detail-path.json",
							}
						],
						extras: [
							{ id: "token", label: "Token", value: "secret-token-value-1234567890" }
						]
					}
				],
				error: "HTTP 401 token sk-secret at /home/shuv/auth.json",
			}
		]
	};
}

describe("quota loader", () => {
	test("single-flights concurrent scans and serves the short success cache", async () => {
		let calls = 0;
		let release;
		const pending = new Promise(resolvePromise => {
			release = resolvePromise;
		});
		const clock = { value: 1000 };
		const loader = createQuotaLoader({
			execute: async () => {
				calls += 1;
				await pending;
				return maliciousV2Payload();
			},
			now: () => new Date(clock.value),
			cacheMs: 5000,
		});
		const first = loader.getSnapshot();
		const second = loader.getSnapshot();
		expect(calls).toBe(1);
		release();
		const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
		expect(firstSnapshot).toBe(secondSnapshot);
		expect(firstSnapshot.scanDurationMs).toBe(0);
		expect(await loader.getSnapshot()).toBe(firstSnapshot);
		expect(calls).toBe(1);
	});

	test("rejects errors and cools down failures without re-running", async () => {
		let calls = 0;
		const loader = createQuotaLoader({
			execute: async () => {
				calls += 1;
				throw new Error("failed with secret sk-abc");
			},
			failureCooldownMs: 10_000,
		});
		await expect(loader.getSnapshot()).rejects.toMatchObject({
			code: "LOAD_FAILED",
			safeMessage: "Quota data unavailable",
		});
		await expect(loader.getSnapshot()).rejects.toBeInstanceOf(QuotaLoadError);
		expect(calls).toBe(1);
	});
});

describe("host and entry point configuration", () => {
	test("allows configured names port-insensitively alongside localhost defaults", () => {
		const allowed = buildAllowedHosts("shuvdev.tail586a6d.ts.net, quota.internal:8443", "127.0.0.1");
		expect(isAllowedHost("shuvdev.tail586a6d.ts.net:4789", allowed)).toBe(true);
		expect(isAllowedHost("quota.internal:443", allowed)).toBe(true);
		expect(isAllowedHost("localhost:9999", allowed)).toBe(true);
		expect(isAllowedHost("attacker.example", allowed)).toBe(false);
		expect(isAllowedHost("shuvdev.tail586a6d.ts.net@attacker.example", allowed)).toBe(false);
	});

	test("validates the server port", () => {
		expect(parseShuvquotaPort(undefined)).toBe(4789);
		expect(parseShuvquotaPort("8443")).toBe(8443);
		expect(() => parseShuvquotaPort("0")).toThrow();
		expect(() => parseShuvquotaPort("not-a-port")).toThrow();
	});
});

describe("static file resolution and MIME", () => {
	let root;
	let outside;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "shuvquota-static-"));
		outside = `${root}-outside.txt`;
		writeFileSync(join(root, "index.html"), "<!doctype html><title>shuvquota</title>");
		writeFileSync(join(root, "app.js"), "export const app = true;\n");
		writeFileSync(join(root, "site.webmanifest"), "{}\n");
		writeFileSync(outside, "private\n");
		symlinkSync(outside, join(root, "escape.txt"));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { force: true });
	});

	test("resolves ordinary files but rejects encoded traversal and symlink escape", async () => {
		expect(await resolveStaticFile("/", root)).toBe(join(root, "index.html"));
		expect(await resolveStaticFile("/app.js?v=1", root)).toBe(join(root, "app.js"));
		expect(await resolveStaticFile("/%2e%2e/secret.txt", root)).toBeNull();
		expect(await resolveStaticFile("/..%2Fsecret.txt", root)).toBeNull();
		expect(await resolveStaticFile("/escape.txt", root)).toBeNull();
	});

	test("returns explicit PWA and asset MIME types", () => {
		expect(getMimeType("index.html")).toBe("text/html; charset=utf-8");
		expect(getMimeType("app.js")).toBe("text/javascript; charset=utf-8");
		expect(getMimeType("site.webmanifest")).toBe("application/manifest+json; charset=utf-8");
		expect(getMimeType("icon.png")).toBe("image/png");
		expect(getMimeType("unknown.bin")).toBe("application/octet-stream");
	});
});

function rawRequest(port, path, options = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const req = request({
			host: "127.0.0.1",
			port,
			path,
			method: options.method ?? "GET",
			headers: {
				Host: options.host ?? `127.0.0.1:${port}`,
				...options.headers,
			},
		}, response => {
			const chunks = [];
			response.on("data", chunk => chunks.push(chunk));
			response.on("end", () => resolvePromise({
				status: response.statusCode,
				headers: response.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		req.once("error", rejectPromise);
		req.end();
	});
}

describe("shuvquota HTTP server", () => {
	let root;
	let server;
	let port;
	let quotaCalls;

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "shuvquota-http-"));
		writeFileSync(join(root, "index.html"), "<!doctype html><title>shuvquota</title>");
		writeFileSync(join(root, "app.js"), "export const app = true;\n");
		writeFileSync(join(root, "site.webmanifest"), "{}\n");
		quotaCalls = 0;
		server = createShuvquotaServer({
			webRoot: root,
			allowedHosts: "shuvdev.tail586a6d.ts.net",
			quotaLoader: createQuotaLoader({
				execute: async () => {
					quotaCalls += 1;
					return maliciousV2Payload();
				},
				now: () => FIXED_NOW,
			}),
		});
		await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
		port = server.address().port;
	});

	afterAll(async () => {
		await new Promise(resolvePromise => server.close(resolvePromise));
		rmSync(root, { recursive: true, force: true });
	});

	test("serves health with API privacy and strong security headers", async () => {
		const response = await rawRequest(port, "/api/health");
		expect(response.status).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ status: "ok", service: "shuvquota", schemaVersion: 2 });
		expect(response.headers["cache-control"]).toContain("private");
		expect(response.headers["cache-control"]).toContain("no-store");
		expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
		expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.headers["referrer-policy"]).toBe("no-referrer");
		expect(response.headers["permissions-policy"]).toContain("camera=()");
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
	});

	test("serves only the normalized quota snapshot with no-store and no secrets", async () => {
		const response = await rawRequest(port, "/api/quota");
		const payload = JSON.parse(response.body);
		expect(response.status).toBe(200);
		expect(response.headers["cache-control"]).toContain("no-store");
		expect(payload.schemaVersion).toBe(2);
		expect(payload.providers).toHaveLength(1);
		
		// Ensure secrets are stripped by toPublicSnapshot
		expect(response.body).not.toContain("secret-email");
		expect(response.body).not.toContain("sk-secret");
		expect(response.body).not.toContain("/home/shuv/auth.json");
		expect(response.body).not.toContain("secret-detail-path");
		expect(response.body).not.toContain("secret-token-value");
		expect(quotaCalls).toBe(1);
	});

	test("supports HEAD without returning a response body", async () => {
		const api = await rawRequest(port, "/api/health", { method: "HEAD" });
		expect(api.status).toBe(200);
		expect(api.body).toBe("");
		expect(Number(api.headers["content-length"])).toBeGreaterThan(0);
		const statik = await rawRequest(port, "/app.js", { method: "HEAD" });
		expect(statik.status).toBe(200);
		expect(statik.body).toBe("");
		expect(statik.headers["content-type"]).toBe("text/javascript; charset=utf-8");
	});

	test("serves static PWA assets with correct MIME and no CORS", async () => {
		const index = await rawRequest(port, "/");
		expect(index.status).toBe(200);
		expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
		expect(index.headers["cache-control"]).toBe("no-cache");
		expect(index.headers["access-control-allow-origin"]).toBeUndefined();
		const manifest = await rawRequest(port, "/site.webmanifest");
		expect(manifest.headers["content-type"]).toBe("application/manifest+json; charset=utf-8");
	});

	test("rejects unsafe Host, cross-site Fetch Metadata, traversal, and methods", async () => {
		const host = await rawRequest(port, "/", { host: "attacker.example:4789" });
		expect(host.status).toBe(421);
		const tailscale = await rawRequest(port, "/api/health", {
			host: "shuvdev.tail586a6d.ts.net:8443",
		});
		expect(tailscale.status).toBe(200);
		const crossSite = await rawRequest(port, "/api/quota", {
			headers: { "Sec-Fetch-Site": "cross-site" },
		});
		expect(crossSite.status).toBe(403);
		const traversal = await rawRequest(port, "/..%2Foutside.txt");
		expect(traversal.status).toBe(404);
		const post = await rawRequest(port, "/api/quota", { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.allow).toBe("GET, HEAD");
	});
});

describe("quota API failures", () => {
	test("does not trust injected QuotaLoadError messages as public text", async () => {
		const server = createShuvquotaServer({ quotaLoader: async () => {
			throw new QuotaLoadError("FAILED", "token abc-private at /home/private/auth.json");
		} });
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		try {
			const response = await rawRequest(server.address().port, "/api/quota");
			expect(response.status).toBe(503);
			expect(JSON.parse(response.body).error).toBe("Authentication required");
			expect(response.body).not.toContain("abc-private");
			expect(response.body).not.toContain("/home/private");
		} finally { await new Promise(resolve => server.close(resolve)); }
	});
	test("returns a conforming, private 503 DTO without raw child errors", async () => {
		const root = mkdtempSync(join(tmpdir(), "shuvquota-failure-"));
		writeFileSync(join(root, "index.html"), "ok\n");
		const server = createShuvquotaServer({
			webRoot: root,
			quotaLoader: createQuotaLoader({
				execute: async () => {
					throw new Error("access token secret from /home/private/auth.json");
				},
				now: () => FIXED_NOW,
			}),
		});
		await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
		const port = server.address().port;
		try {
			const response = await rawRequest(port, "/api/quota");
			const payload = JSON.parse(response.body);
			expect(response.status).toBe(503);
			expect(response.headers["cache-control"]).toContain("no-store");
			expect(payload.schemaVersion).toBe(2);
			expect(payload.error).toBe("Quota data unavailable"); // v2 schema puts error at root or provider, toPublicSnapshot handles it
			expect(response.body).not.toContain("access token");
			expect(response.body).not.toContain("/home/private");
		} finally {
			await new Promise(resolvePromise => server.close(resolvePromise));
			rmSync(root, { recursive: true, force: true });
		}
	});
});
