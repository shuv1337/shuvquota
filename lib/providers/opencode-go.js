/** Read-only OpenCode Go usage from configured API keys. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { normalizeGenericAccount } from "../snapshot.js";

/** Build the read-only adapter; database and network dependencies are injectable. */
export function createOpenCodeGoProvider(deps = {}) {
	const dataHome = deps.dataHome ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	const paths = deps.dbPaths ?? [join(dataHome, "shuvcode", "opencode.db"), join(dataHome, "opencode", "opencode.db")];
	async function sources() {
		const accounts = [];
		const add = (key, label, location, kind) => {
			if (typeof key !== "string" || !key.trim()) return;
			key = key.trim();
			accounts.push({ label: label || "OpenCode Go", apiKey: key, kind, location, writable: false,
				identityKey: createHash("sha256").update(key).digest("hex") });
		};
		add(deps.envKey ?? process.env.OPENCODE_GO_API_KEY, "OpenCode Go", "env:OPENCODE_GO_API_KEY", "env");
		let DatabaseSync = deps.DatabaseSync;
		if (!DatabaseSync) { try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* optional */ } }
		for (const path of paths) {
			if (!DatabaseSync || !existsSync(path)) continue;
			let db;
			try {
				db = new DatabaseSync(path, { readOnly: true });
				for (const row of db.prepare("SELECT label, value FROM credential WHERE integration_id = ? ORDER BY time_updated DESC").all("opencode-go")) {
					let value = row.value;
					if (typeof value === "string") value = JSON.parse(value);
					add(value?.key, row.label, path, "harness");
				}
			} catch { /* optional source */ } finally { db?.close(); }
		}
		const authPath = join(dataHome, "opencode", "auth.json");
		try { const auth = JSON.parse(readFileSync(authPath, "utf8")); add(auth["opencode-go"]?.key, "OpenCode Go", authPath, "harness"); } catch { /* optional source */ }
		return accounts;
	}
	return {
		id: "opencode-go", name: "OpenCode Go",
		async discoverSources() { return (await sources()).map(({ apiKey, ...source }) => ({ provider: "opencode-go", ...source })); },
		async discoverAccounts() { const seen = new Set(); return (await sources()).filter(item => !seen.has(item.identityKey) && seen.add(item.identityKey)); },
		async fetch(account) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 15000);
			try {
				const response = await (deps.fetchFn ?? fetch)("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: `Bearer ${account.apiKey}` }, signal: controller.signal });
				if (!response.ok) throw new Error(`OpenCode Go quota service returned HTTP ${response.status}`);
				const body = await response.json();
				const windows = [["rolling", "5h", 18000], ["weekly", "Weekly", 604800], ["monthly", "Monthly", null]].flatMap(([id, label, windowSeconds]) => {
					const item = body?.usage?.[id];
					return typeof item?.percent === "number" && Number.isFinite(item.percent) ? [{ id, label, percentUsed: item.percent, resetsAt: item.resetsAt, windowSeconds }] : [];
				});
				if (!windows.length) throw new Error("OpenCode Go quota response contained no usage windows");
				return { usage: { windows } };
			} finally { clearTimeout(timer); }
		},
		normalize: normalizeGenericAccount,
		async login() { throw new Error("Configure an OpenCode Go key in Shuvcode or OPENCODE_GO_API_KEY"); },
	};
}
export const opencodeGo = createOpenCodeGoProvider();
