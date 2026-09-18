import { readFileSync } from "node:fs";
import { sanitize } from "./tui/width.js";

const PROVIDER_IDS = ["codex", "claude", "grok", "antigravity"];
const REMOVED_COMMANDS = new Set([
	"factory", "opencode-go", "synthetic", "proxx", "switch", "sync", "set-plan",
]);
const REMOVED_FLAGS = new Set([
	"--local", "--native", "--no-factory", "--billing-day", "--oauth", "--manual",
	"--dry-run", "--no-browser", "--base-url", "--token",
]);
const BOOLEAN_FLAGS = new Map([
	["--json", "json"], ["--compact", "compact"], ["-c", "compact"],
	["--once", "once"], ["--show-email", "showEmail"], ["--no-color", "noColor"],
	["--version", "version"], ["-v", "version"], ["--help", "help"], ["-h", "help"],
	["-w", "watch"],
]);

function cliError(message, exitCode = 1) {
	return Object.assign(new Error(message), { exitCode });
}

function removedError(value) {
	return cliError(`'${value}' was removed in v2. Use npx shuvquota@1 … instead.`, 2);
}

/** Parse the v2 command surface without reading credentials or touching a terminal. */
export function parseArgs(args) {
	const options = { interval: 60 };
	const positional = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const flag = arg.split("=", 1)[0];
		if (REMOVED_FLAGS.has(flag)) throw removedError(flag);
		if (arg === "--interval" || arg.startsWith("--interval=")) {
			const value = arg === "--interval" ? args[++index] : arg.slice(11);
			const interval = Number(value);
			if (!value || !Number.isFinite(interval) || interval < 15) {
				throw cliError("--interval must be a number of seconds, at least 15.");
			}
			options.interval = interval;
		} else if (BOOLEAN_FLAGS.has(arg)) {
			options[BOOLEAN_FLAGS.get(arg)] = true;
		} else if (arg.startsWith("-")) {
			throw cliError(`Unknown option: ${arg}`);
		} else {
			positional.push(arg);
		}
	}
	const provider = PROVIDER_IDS.includes(positional[0]) ? positional.shift() : null;
	let command = positional.shift() ?? "quota";
	if (options.watch) {
		if (!["quota", "tui", "watch"].includes(command)) positional.unshift(command);
		command = "watch";
	} else if (command === "tui") command = "watch";
	if (REMOVED_COMMANDS.has(command)) throw removedError(command);
	if (!provider && !["quota", "watch", "accounts", "sources"].includes(command)) {
		throw cliError(`Unknown command: ${command}`);
	}
	if (provider && ![
		"quota", "watch", "accounts", "sources", "add", "reauth", "rename", "remove",
	].includes(command)) {
		positional.unshift(command);
		command = "quota";
	}
	const count = positional.length;
	if (!options.help && !options.version) {
		const maximum = command === "rename" ? 2 : ["accounts", "sources"].includes(command) ? 0 : 1;
		const minimum = command === "rename" ? 2 : ["reauth", "remove"].includes(command) ? 1 : 0;
		if (count < minimum || count > maximum) {
			throw cliError(`Invalid arguments for ${provider ? `${provider} ` : ""}${command}. See --help.`);
		}
	}
	return { provider, command, args: positional, options };
}

/** Compact, shared command help for all providers. */
export function helpText(provider = null) {
	const prefix = provider ? `cq ${provider}` : "cq <provider>";
	return [
		"shuvquota — multi-account quota monitor",
		"",
		"cq                         Show quota once",
		"cq watch                   Live quota view (aliases: tui, -w)",
		"cq quota [label]           Filter by account label",
		"cq accounts                List managed accounts",
		"cq sources                 List physical credential sources",
		`${prefix} [quota] [label]`,
		`${prefix} add [label]`,
		`${prefix} reauth <label>`,
		`${prefix} rename <old> <new>`,
		`${prefix} remove <label>`,
		"",
		"Providers: codex, claude, grok, antigravity",
		"Options: --json --compact --once --show-email --no-color",
		"         --interval <seconds> (default 60, minimum 15) --version --help",
	].join("\n");
}

/** Read package metadata relative to the installed module. */
export function packageVersion() {
	return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

/** Execute the parsed command; dependencies may be injected for offline tests. */
export async function runCli(argv = process.argv.slice(2), deps = {}) {
	const parsed = parseArgs(argv);
	const { provider, command, args, options } = parsed;
	const output = deps.output ?? process.stdout;
	const errorOutput = deps.errorOutput ?? process.stderr;
	const write = value => output.write(`${value}\n`);
	if (options.version) { write(packageVersion()); return; }
	if (options.help) { write(helpText(provider)); return; }
	const registry = deps.providers ?? (await import("./providers/index.js")).providers;
	const selected = provider ? registry.filter(item => item.id === provider) : registry;
	if (provider && selected.length === 0) throw cliError(`Unknown provider: ${provider}`);
	const snapshots = deps.snapshots ?? await import("./snapshot.js");
	if (command === "sources") {
		const sources = (await Promise.all(selected.map(item => item.discoverSources()))).flat();
		const cleanSourceText = value => {
			const text = sanitize(typeof value === "string" ? value : "");
			return options.showEmail ? text : text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
				email => snapshots.maskEmail(email) ?? "[redacted]");
		};
		const records = sources.map(source => {
			let location = source.location;
			if (source.kind === "remote") {
				try {
					const url = new URL(location);
					url.username = ""; url.password = ""; url.search = ""; url.hash = "";
					location = url.toString();
				} catch { location = "remote"; }
			}
			return { provider: cleanSourceText(source.provider), label: cleanSourceText(source.label),
				kind: ["managed", "env", "harness", "remote"].includes(source.kind) ? source.kind : "harness",
				location: cleanSourceText(location),
				identityKey: source.identityKey == null ? null : cleanSourceText(source.identityKey),
				writable: Boolean(source.writable) };
		});
		if (options.json) write(JSON.stringify(records, null, 2));
		else for (const source of records) write(`${source.provider}\t${source.label}\t${source.kind}\t${source.writable ? "writable" : "read-only"}\t${source.location}`);
		return;
	}
	if (["accounts", "add", "reauth", "rename", "remove"].includes(command)) {
		const store = deps.store ?? await import("./credential-store.js");
		if (command === "accounts") {
			const seen = new Set();
			const records = selected.flatMap(item => store.listManagedAccounts(item.id).flatMap(row => {
				const identity = `${item.id}:${row.raw.accountId ?? row.raw.email ?? row.label}`;
				if (seen.has(identity)) return [];
				seen.add(identity);
				return [{ provider: item.id, label: snapshots.redactPublicText(row.label),
					email: options.showEmail && snapshots.maskEmail(row.raw.email)
						? snapshots.sanitizeText(row.raw.email, 254) : snapshots.maskEmail(row.raw.email),
					enrollment: row.enrollment, readOnly: row.readOnly }];
			}));
			if (options.json) write(JSON.stringify(records, null, 2));
			else if (!records.length) write("No managed accounts. Use cq <provider> add.");
			else for (const account of records) write(`${account.provider}\t${account.label}\t${account.readOnly ? "reauth required" : "managed"}`);
			return;
		}
		let label = args[0];
		if (command === "add" && !label) {
			if (!process.stdin.isTTY && !deps.promptInput) throw cliError("Provide an account label: cq <provider> add <label>.");
			const prompt = deps.promptInput ?? (await import("./prompts.js")).promptInput;
			label = await prompt("Account label: ");
		}
		if (!label?.trim() || /[\x00-\x1f\x7f]/.test(label)) throw cliError("Provide a non-empty account label without control characters.");
		if (command === "rename") {
			if (!args[1]?.trim() || /[\x00-\x1f\x7f]/.test(args[1])) throw cliError("Provide a valid new label.");
			store.renameManagedAccount(provider, label, args[1]);
		} else if (command === "remove") {
			if (!store.removeManagedAccount(provider, label).removed) throw cliError(`Account '${label}' not found.`);
		}
		else {
			const existing = store.findManagedAccount(provider, label);
			if (command === "add" && existing) throw cliError(`Account '${label}' already exists. Use reauth.`);
			if (command === "reauth" && !existing) throw cliError(`Account '${label}' not found.`);
			const credential = await selected[0].login({ label });
			if (command === "add") store.addManagedAccount(provider, { ...credential, label });
			else store.replaceManagedAccount(provider, label, credential);
		}
		const result = { provider, command, label: command === "rename" ? args[1] : label };
		write(options.json ? JSON.stringify(result) : `${provider}: ${command} ${result.label}`);
		return;
	}
	const load = deps.loadSnapshot ?? (await import("./quota.js")).loadSnapshot;
	const color = !options.noColor && process.env.NO_COLOR === undefined && Boolean(output.isTTY);
	if (command === "watch" && !options.once && !options.json && !options.compact) {
		const watch = deps.runWatch ?? (await import("./tui/app.js")).runWatch;
		if (await watch({ providers: selected, loadSnapshot: load, labelFilter: args[0],
			interval: options.interval, showEmail: options.showEmail, color })) return;
		errorOutput.write("Watch needs an interactive terminal; showing quota once.\n");
	}
	const snapshot = await load({ providers: selected, labelFilter: args[0] });
	const display = snapshots.toDisplaySnapshot(snapshot, { showEmail: options.showEmail });
	if (options.json) { write(JSON.stringify(display, null, 2)); return; }
	const render = deps.render ?? await import("./tui/render.js");
	const lines = options.compact ? render.renderCompact(display, { showEmail: options.showEmail })
		: render.renderStatic(display, { cols: output.columns ?? 80, color, showEmail: options.showEmail });
	write(lines.join("\n"));
}
