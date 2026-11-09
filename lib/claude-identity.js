/** Lazy, cached CLI identity detection; never reads or refreshes credentials. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CLAUDE_MIN_CLI_VERSION, claudeUserAgent } from "./constants.js";

const execute = promisify(execFile);

async function installedVersion() {
	const { stdout } = await execute("claude", ["--version"], {
		timeout: 1500, killSignal: "SIGKILL", maxBuffer: 1024, windowsHide: true,
	});
	return stdout;
}

/** Cache successes and failures, including concurrent readers; inject only the subprocess boundary. */
export function createClaudeUserAgent(readVersion = installedVersion) {
	let cached;
	return () => (cached ??= Promise.resolve().then(readVersion).then(output => {
		const version = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(output.trim())?.[1];
		if (!version) return CLAUDE_MIN_CLI_VERSION;
		const floor = CLAUDE_MIN_CLI_VERSION.split(".").map(Number);
		const difference = version.split(".").map((part, i) => Number(part) - floor[i]).find(part => part !== 0);
		return difference < 0 ? CLAUDE_MIN_CLI_VERSION : version;
	}).catch(() => CLAUDE_MIN_CLI_VERSION).then(claudeUserAgent));
}

export const getClaudeUserAgent = createClaudeUserAgent();
