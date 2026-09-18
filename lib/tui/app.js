import { createTerminal } from "./terminal.js";
import { computeLayout } from "./layout.js";
import { renderView } from "./render.js";
import { truncate } from "./width.js";
import { toDisplaySnapshot } from "../snapshot.js";

const HELP = [
	"q / Ctrl-C  Quit", "r  Refresh", "e  Toggle email", "?  Close help",
	"1 All  2 Codex  3 Claude  4 Grok  5 Antigravity",
	"j/k / arrows  Scroll", "PgUp/PgDn  Page", "+/-  Refresh interval (+/-15s)",
];

/** Initial watch state. Keep completed and successful timestamps distinct. */
export function createAppState({ providers = [], interval = 60, showEmail = false } = {}) {
	return {
		snapshot: { schemaVersion: 2, generatedAt: null,
			providers: providers.map(({ id, name }) => ({ id, name, loading: true, accounts: [] })) },
		loading: false, lastUpdatedAt: null, lastSuccessfulAt: null, nextRefreshAt: null,
		error: null, scroll: 0, showEmail, providerFilter: null, showHelp: false,
		interval: Math.max(15, interval),
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

/** Render a bounded full frame with two reserved chrome rows when available. */
export function renderFrame(state, { cols, rows }, { now = Date.now(), color = false } = {}) {
	cols = Math.max(0, Math.floor(cols));
	rows = Math.max(0, Math.floor(rows));
	if (!rows || !cols) return [];
	const updated = state.lastUpdatedAt ? new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", second: "2-digit",
	}).format(new Date(state.lastUpdatedAt)) : "never";
	const countdown = state.nextRefreshAt === null ? "" : ` · next ${Math.max(0,
		Math.ceil((state.nextRefreshAt - now) / 1000))}s`;
	const title = `shuvquota · ${state.loading ? "loading…" : `updated ${updated}`}${countdown}${state.error ? " · stale" : ""} · ?`;
	if (rows === 1) return [truncate(title, cols)];
	const source = toDisplaySnapshot(state.snapshot, { showEmail: state.showEmail });
	const snapshot = { ...source, providers: source.providers
		.filter(provider => !state.providerFilter || provider.id === state.providerFilter)
		.map(provider => state.loading && !provider.error && !provider.accounts.length
			&& state.snapshot.complete !== true ? { ...provider, accounts: [{
				label: "", email: null, plan: null, status: "loading", windows: [],
			}] } : provider) };
	const layout = computeLayout(snapshot, { cols, rows: rows - 2, scroll: state.scroll });
	const view = renderView(layout, { now: new Date(now), color, showEmail: state.showEmail });
	state.scroll = view.viewport.offset;
	const body = state.showHelp ? HELP.slice(0, rows - 2).map(line => truncate(line, cols)) : view.lines;
	const footer = state.error ? `error: ${state.error}`
		: `${view.indicator ? `${view.indicator} · ` : ""}q quit · r refresh · e email · 1–5 providers · ${state.interval}s`;
	return [truncate(title, cols), ...body,
		...Array(Math.max(0, rows - 2 - body.length)).fill(""), truncate(footer, cols)];
}

/**
 * Run a full-screen session. Return false when either stream is not a TTY.
 * The caller owns loading defaults, so this layer never accesses credentials.
 */
export async function runWatch({ providers, loadSnapshot, interval = 60, showEmail = false,
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
		const page = Math.max(1, terminal.size.rows - 2);
		if (action === "quit") return finish();
		if (action === "refresh") { refresh(); return; }
		if (action === "email") state.showEmail = !state.showEmail;
		if (action === "help") state.showHelp = !state.showHelp;
		if (action === "up") state.scroll = Math.max(0, state.scroll - 1);
		if (action === "down") state.scroll++;
		if (action === "pageUp") state.scroll = Math.max(0, state.scroll - page);
		if (action === "pageDown") state.scroll += page;
		if (["all", "codex", "claude", "grok", "antigravity"].includes(action)) {
			state.providerFilter = action === "all" ? null : action;
			state.scroll = 0;
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
		timer = setInterval(() => {
			if (!state.loading && state.nextRefreshAt !== null && now() >= state.nextRefreshAt) refresh();
			draw();
		}, 1000);
		await done;
		// Let any already-started rotating refresh finish its atomic persistence.
		await inFlight;
		return true;
	} finally { finish(); }
}
