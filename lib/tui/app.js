import { createTerminal } from "./terminal.js";
import { renderShell, visibleCards, selectedIndex } from "./shell.js";
import { toDisplaySnapshot } from "../snapshot.js";

/** Seconds between automatic refreshes; `r` refreshes immediately. */
export const DEFAULT_INTERVAL = 180;

/** Initial watch state. Keep completed and successful timestamps distinct. */
export function createAppState({ providers = [], interval = DEFAULT_INTERVAL, showEmail = false } = {}) {
	return {
		snapshot: { schemaVersion: 2, generatedAt: null,
			providers: providers.map(({ id, name }) => ({ id, name, loading: true, accounts: [] })) },
		loading: false, lastUpdatedAt: null, lastSuccessfulAt: null, nextRefreshAt: null,
		error: null, scroll: 0, showEmail, providerFilter: null, showHelp: false,
		selected: null, showUpNext: false, interval: Math.max(15, interval),
	};
}

/** Apply one completed scan; individual account errors do not mark the scan stale. */
export function completeScan(state, snapshot, now) {
	state.snapshot = snapshot;
	state.loading = false;
	state.error = null;
	state.lastUpdatedAt = snapshot.generatedAt ?? new Date(now).toISOString();
	if (snapshot.providers?.some(provider => provider.accounts?.some(account => account.status === "ok"))) {
		state.lastSuccessfulAt = state.lastUpdatedAt;
	}
	state.nextRefreshAt = now + state.interval * 1000;
}

/**
 * Display snapshot for the current state: emails masked unless revealed, and
 * providers still scanning shown as loading placeholders.
 */
function displaySnapshot(state) {
	const source = toDisplaySnapshot(state.snapshot, { showEmail: state.showEmail });
	return { ...source, providers: source.providers
		.map(provider => state.loading && !provider.error && !provider.accounts.length
			&& state.snapshot.complete !== true ? { ...provider, accounts: [{
				label: "", email: null, plan: null, status: "loading", windows: [],
			}] } : provider) };
}

/**
 * Move the account selection by `delta`, clamped to the visible accounts.
 * @param {object} state
 * @param {number} delta
 */
export function moveSelection(state, delta) {
	const cards = visibleCards(displaySnapshot(state), state.providerFilter);
	if (!cards.length) return;
	const index = selectedIndex(cards, state.selected);
	state.selected = cards[Math.min(cards.length - 1, Math.max(0, index + delta))].key;
}

/** Render a bounded full frame: exactly `rows` lines of at most `cols` cells. */
export function renderFrame(state, { cols, rows }, { now = Date.now(), color = false } = {}) {
	cols = Math.max(0, Math.floor(cols));
	rows = Math.max(0, Math.floor(rows));
	if (!rows || !cols) return [];
	const result = renderShell({ ...state, snapshot: displaySnapshot(state) }, { cols, rows }, { now, color });
	if (result.selected >= 0) state.selected = result.cards[result.selected].key;
	return result.lines;
}

/**
 * Run a full-screen session. Return false when either stream is not a TTY.
 * The caller owns loading defaults, so this layer never accesses credentials.
 */
export async function runWatch({ providers, loadSnapshot, interval = DEFAULT_INTERVAL, showEmail = false,
	color = false, labelFilter, terminalFactory = createTerminal, now = Date.now } = {}) {
	const state = createAppState({ providers, interval, showEmail });
	let closed = false;
	let pendingFrame = null;
	let inFlight = null;
	let timer = null;
	let resolveDone;
	const done = new Promise(resolve => { resolveDone = resolve; });
	const draw = () => {
		if (closed || pendingFrame !== null) return;
		pendingFrame = setImmediate(() => {
			pendingFrame = null;
			if (!closed) terminal.write(renderFrame(state, terminal.size, { now: now(), color }));
		});
	};
	const finish = () => {
		if (closed) return;
		closed = true;
		clearInterval(timer);
		if (pendingFrame !== null) clearImmediate(pendingFrame);
		terminal.stop();
		resolveDone();
	};
	const refresh = () => {
		if (closed || inFlight) return inFlight;
		const previous = state.snapshot;
		state.loading = true;
		draw();
		inFlight = (async () => {
			try {
				await Promise.resolve();
				const snapshot = await loadSnapshot({ providers, labelFilter, onProgress(partial) {
					if (!closed) { state.snapshot = partial; draw(); }
				} });
				if (!closed) completeScan(state, snapshot, now());
			} catch {
				if (!closed) {
					state.snapshot = previous;
					state.loading = false;
					state.error = "Quota unavailable; retry with r";
					state.nextRefreshAt = now() + state.interval * 1000;
				}
			} finally { inFlight = null; draw(); }
		})();
		return inFlight;
	};
	const terminal = terminalFactory({ onResize: draw, onExit: finish, onAction(action) {
		const page = Math.max(1, Math.floor((terminal.size.rows - 2) / 2));
		if (action === "quit") return finish();
		if (action === "refresh") { refresh(); return; }
		if (action === "email") state.showEmail = !state.showEmail;
		if (action === "help") state.showHelp = !state.showHelp;
		if (action === "upnext") state.showUpNext = !state.showUpNext;
		if (action === "up") moveSelection(state, -1);
		if (action === "down") moveSelection(state, 1);
		if (action === "pageUp") moveSelection(state, -page);
		if (action === "pageDown") moveSelection(state, page);
		if (["all", "codex", "claude", "grok", "antigravity", "cursor"].includes(action)) {
			state.providerFilter = action === "all" ? null : action;
			state.selected = null;
		}
		if (action === "slower" || action === "faster") {
			state.interval = Math.max(15, state.interval + (action === "slower" ? 15 : -15));
			state.nextRefreshAt = now() + state.interval * 1000;
		}
		draw();
	} });
	if (!terminal.start()) return false;
	try {
		refresh();
		// Tick fast enough to animate spinners while loading; otherwise repaint
		// only when the countdown second changes.
		let lastSecond = -1;
		timer = setInterval(() => {
			const at = now();
			if (!state.loading && state.nextRefreshAt !== null && at >= state.nextRefreshAt) refresh();
			const second = Math.floor(at / 1000);
			if (state.loading || second !== lastSecond) {
				lastSecond = second;
				draw();
			}
		}, 100);
		await done;
		// Let any already-started rotating refresh finish its atomic persistence.
		await inFlight;
		return true;
	} finally { finish(); }
}
