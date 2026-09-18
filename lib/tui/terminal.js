import { emitKeypressEvents } from "node:readline";

const ENTER = "\x1b[?1049h\x1b[?25l";
const LEAVE = "\x1b[?25h\x1b[?1049l";

/** Translate readline key events into app actions. */
export function keyAction(text, key = {}) {
	if (key.ctrl && key.name === "c") return "quit";
	const byName = { up: "up", down: "down", pageup: "pageUp", pagedown: "pageDown" };
	if (byName[key.name]) return byName[key.name];
	return ({ q: "quit", r: "refresh", e: "email", "?": "help", j: "down", k: "up",
		"+": "slower", "=": "slower", "-": "faster", "1": "all", "2": "codex",
		"3": "claude", "4": "grok", "5": "antigravity" })[text] ?? null;
}

/**
 * Own terminal state for one watch session. Restore before reporting completion.
 * Inject streams/process for tests. Both stdin and stdout must be terminals.
 */
export function createTerminal({
	input = process.stdin, output = process.stdout, proc = process,
	keypress = emitKeypressEvents, onAction = () => {}, onResize = () => {},
	onExit = () => {},
} = {}) {
	let active = false;
	let previousRaw = false;
	let previousPaused = true;
	const onKey = (text, key) => {
		const action = keyAction(text, key);
		if (action) onAction(action);
	};
	const onSignal = signal => {
		stop();
		onExit(signal);
	};
	const onInt = () => onSignal("SIGINT");
	const onTerm = () => onSignal("SIGTERM");
	function stop() {
		if (!active) return;
		active = false;
		input.removeListener("keypress", onKey);
		output.removeListener("resize", onResize);
		proc.removeListener("exit", stop);
		proc.removeListener("SIGINT", onInt);
		proc.removeListener("SIGTERM", onTerm);
		proc.removeListener("uncaughtExceptionMonitor", stop);
		try { input.setRawMode(previousRaw); }
		finally {
			if (previousPaused) input.pause();
			output.write(LEAVE);
		}
	}
	return {
		get active() { return active; },
		get size() { return { cols: output.columns ?? 80, rows: output.rows ?? 24 }; },
		start() {
			if (active) return true;
			if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return false;
			previousRaw = Boolean(input.isRaw);
			// A fresh TTY has readableFlowing=null but isPaused()===false. Restore
			// that inactive state too, otherwise our resume() keeps Node alive.
			previousPaused = input.readableFlowing !== true;
			active = true;
			proc.on("exit", stop);
			proc.on("SIGINT", onInt);
			proc.on("SIGTERM", onTerm);
			// Monitoring preserves Node's default fatal-error behavior after restoration.
			proc.on("uncaughtExceptionMonitor", stop);
			try {
				keypress(input);
				input.setRawMode(true);
				input.on("keypress", onKey);
				output.on("resize", onResize);
				input.resume();
				output.write(ENTER);
				return true;
			} catch (error) { stop(); throw error; }
		},
		write(lines) {
			// Clear before painting: erasing after a full-width line can erase
			// its last cell while the terminal is in the wrap-pending state.
			if (active) output.write(`\x1b[H\x1b[2J${lines.join("\r\n")}`);
		},
		stop,
	};
}
