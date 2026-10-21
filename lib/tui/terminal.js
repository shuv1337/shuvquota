import { StringDecoder } from "node:string_decoder";

const ENTER = "\x1b[?1049h\x1b[?25l";
const LEAVE = "\x1b[?25h\x1b[?1049l";

const ESC = "\x1b";
const CSI_KEYS = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab" };
const TILDE_KEYS = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };

/** One plain character as a readline-shaped key. */
function charKey(ch) {
	const named = { "\r": "return", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\b": "backspace",
		[ESC]: "escape", " ": "space" }[ch];
	if (named) return { name: named, sequence: ch };
	const code = ch.codePointAt(0);
	if (code < 0x20) return { name: String.fromCharCode(code + 96), ctrl: true, sequence: ch };
	if (/^[a-z]$/i.test(ch)) return { name: ch.toLowerCase(), shift: ch !== ch.toLowerCase(), sequence: ch };
	return { name: /^[0-9]$/.test(ch) ? ch : undefined, sequence: ch };
}

/**
 * Split one input chunk into keys. A chunk that is exactly ESC is the Escape
 * key: terminals deliver escape sequences in a single read, and unlike
 * readline's decoder this never holds a lone ESC waiting for more input.
 * @param {string} chunk
 * @returns {Array<{ text: string | undefined, key: { name?: string, ctrl?: boolean, meta?: boolean, shift?: boolean, sequence: string } }>}
 */
export function parseKeys(chunk) {
	const keys = [];
	let i = 0;
	while (i < chunk.length) {
		if (chunk[i] === ESC && (chunk[i + 1] === "[" || chunk[i + 1] === "O")) {
			let j = i + 2;
			while (j < chunk.length && !/[@-~]/.test(chunk[j])) j++;
			const sequence = chunk.slice(i, j + 1);
			const [first, modifier] = chunk.slice(i + 2, j).split(";");
			const bits = Math.max(0, Number(modifier || 1) - 1);
			const name = chunk[j] === "~" ? TILDE_KEYS[first] : CSI_KEYS[chunk[j]];
			if (name) {
				keys.push({ text: undefined, key: { name, sequence, shift: Boolean(bits & 1) || chunk[j] === "Z",
					meta: Boolean(bits & 2), ctrl: Boolean(bits & 4) } });
			}
			i = j + 1;
			continue;
		}
		if (chunk[i] === ESC && i + 1 < chunk.length && chunk[i + 1] !== ESC) {
			const ch = String.fromCodePoint(chunk.codePointAt(i + 1));
			keys.push({ text: ch, key: { ...charKey(ch), meta: true, sequence: ESC + ch } });
			i += 1 + ch.length;
			continue;
		}
		const ch = String.fromCodePoint(chunk.codePointAt(i));
		keys.push({ text: ch, key: charKey(ch) });
		i += ch.length;
	}
	return keys;
}

/** Translate parsed key events into app actions. */
export function keyAction(text, key = {}) {
	if (key.ctrl && key.name === "c") return "quit";
	const byName = { up: "up", down: "down", pageup: "pageUp", pagedown: "pageDown" };
	if (byName[key.name]) return byName[key.name];
	return ({ q: "quit", r: "refresh", e: "email", "?": "help", j: "down", k: "up",
		u: "upnext", m: "manage", "+": "slower", "=": "slower", "-": "faster", "1": "all", "2": "codex",
		"3": "claude", "4": "grok", "5": "antigravity", "6": "cursor" })[text] ?? null;
}

/**
 * Own terminal state for one watch session. Restore before reporting completion.
 * Inject streams/process for tests. Both stdin and stdout must be terminals.
 * `onKey(text, key)` sees every key first (Ctrl-C excepted) and returns true
 * when it consumed the key, e.g. while a text field has focus.
 */
export function createTerminal({
	input = process.stdin, output = process.stdout, proc = process,
	onAction = () => {}, onKey = () => false, onResize = () => {}, onExit = () => {},
} = {}) {
	let active = false;
	const decoder = new StringDecoder("utf8");
	let previousRaw = false;
	let previousPaused = true;
	const onKeypress = (text, key = {}) => {
		if (!(key.ctrl && key.name === "c") && onKey(text, key)) return;
		const action = keyAction(text, key);
		if (action) onAction(action);
	};
	const onData = chunk => {
		for (const { text, key } of parseKeys(typeof chunk === "string" ? chunk : decoder.write(chunk))) onKeypress(text, key);
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
		input.removeListener("data", onData);
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
				input.setRawMode(true);
				input.on("data", onData);
				output.on("resize", onResize);
				input.resume();
				output.write(ENTER);
				return true;
			} catch (error) { stop(); throw error; }
		},
		write(lines) {
			// Clear before painting: erasing after a full-width line can erase
			// its last cell while the terminal is in the wrap-pending state.
			// Synchronized output (DEC 2026) keeps supporting terminals from
			// showing the cleared screen between frames; others ignore it.
			if (active) output.write(`\x1b[?2026h\x1b[H\x1b[2J${lines.join("\r\n")}\x1b[?2026l`);
		},
		/** Put text on the system clipboard via OSC 52 where the terminal allows it. */
		copy(text) {
			if (active) output.write(`\x1b]52;c;${Buffer.from(String(text)).toString("base64")}\x07`);
		},
		stop,
	};
}
