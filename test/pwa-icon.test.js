import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createShuvquotaServer } from "../lib/shuvquota-server.js";

test("served HTML carries the current Apple icon without a second network fetch", async () => {
	const server = createShuvquotaServer({
		quotaLoader: async () => ({ schemaVersion: 2, providers: [] }),
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const origin = `http://127.0.0.1:${server.address().port}`;
		const response = await fetch(origin);
		expect(response.status).toBe(200);
		const html = await response.text();
		const encoded = html.match(/<link id="apple-touch-icon-inline"[^>]*href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/)?.[1];
		expect(encoded).toBeDefined();
		const source = await readFile(new URL("../web/icons/icon-180.png", import.meta.url));
		expect(Buffer.from(encoded, "base64")).toEqual(source);
		const fallback = await fetch(`${origin}/apple-touch-icon.png`);
		expect(fallback.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await fallback.arrayBuffer())).toEqual(source);
		// The native inline-icon workaround does not need relaxed HTTP policies.
		expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
		expect(fallback.headers.get("cross-origin-resource-policy")).toBe("same-origin");
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
});
