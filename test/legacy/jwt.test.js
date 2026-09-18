/**
 * Legacy JWT utilities tests migrated from shuvquota.test.js
 * Run with: bun test test/legacy/jwt.test.js
 */

import { describe, expect, test } from "bun:test";
import { decodeJWT, extractAccountId } from "../../lib/jwt.js";

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

const MOCK_ACCOUNT_ID = "acc_12345";

describe("decodeJWT", () => {
	test("decodes valid JWT and returns payload", () => {
		const token = createMockAccessToken(MOCK_ACCOUNT_ID);
		const payload = decodeJWT(token);

		expect(payload).not.toBeNull();
		expect(payload["https://api.openai.com/auth"].chatgpt_account_id).toBe(MOCK_ACCOUNT_ID);
	});

	test("returns null for invalid JWT format", () => {
		expect(decodeJWT("not.a.valid.token.format")).toBeNull();
		expect(decodeJWT("just-a-string")).toBeNull();
		expect(decodeJWT("")).toBeNull();
	});

	test("returns null for JWT with invalid base64", () => {
		expect(decodeJWT("header.!!!invalid!!!.signature")).toBeNull();
	});
});

describe("extractAccountId", () => {
	test("extracts account ID from valid token", () => {
		const token = createMockAccessToken(MOCK_ACCOUNT_ID);
		const accountId = extractAccountId(token);
		expect(accountId).toBe(MOCK_ACCOUNT_ID);
	});

	test("returns null for token without account ID", () => {
		const header = { alg: "RS256" };
		const payload = { sub: "user123" };
		const token = `${Buffer.from(JSON.stringify(header)).toString("base64")}.${Buffer.from(JSON.stringify(payload)).toString("base64")}.sig`;

		expect(extractAccountId(token)).toBeNull();
	});
});
