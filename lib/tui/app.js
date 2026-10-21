import { createTerminal } from "./terminal.js";
import { renderShell, visibleCards, selectedIndex } from "./shell.js";
import { beginAuth, failAuth, manageKey, openManage, showList } from "./manage.js";
import { sanitize } from "./width.js";
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
		selected: null, showUpNext: false, interval: Math.max(15, interval), manage: null,
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
 * Default account operations: the shared service plus a quiet browser opener.
 * @returns {Promise<object>}
 */
async function defaultAccounts() {
	const [service, { launchBrowser }] = await Promise.all([import("../accounts.js"), import("../oauth.js")]);
	return {
		list: providers => service.listAccounts(providers),
		manageable: providerId => service.isManageable(providerId),
		add: (provider, label, loginContext) => service.addAccount(provider, label, { loginContext }),
		reauth: (provider, label, loginContext) => service.reauthAccount(provider, label, { loginContext }),
		rename: (provider, from, to) => service.renameAccount(provider, from, to),
		remove: (provider, label) => service.removeAccount(provider, label),
		openBrowser: launchBrowser,
	};
}

/** Last non-empty line of OAuth helper output, for the sign-in status. */
function lastLine(text) {
	return String(text).split(/\r?\n/).map(part => sanitize(part).trim()).filter(Boolean).at(-1) ?? null;
}

/**
 * Run a full-screen session. Return false when either stream is not a TTY.
 * The caller owns loading defaults, so this layer never reads the quota
 * credentials itself. Account changes go through `accounts` (injectable);
 * sign-in output is routed into the panel, never written to the terminal.
 */
export async function runWatch({ providers, loadSnapshot, interval = DEFAULT_INTERVAL, showEmail = false,
	color = false, labelFilter, terminalFactory = createTerminal, now = Date.now, accounts } = {}) {
	const state = createAppState({ providers, interval, showEmail });
	let closed = false;
	let pendingFrame = null;
	let inFlight = null;
	let refreshAgain = false;
	let timer = null;
	let service = accounts ?? null;
	/** Sign-in in progress: its abort controller and pending code prompt. */
	let signIn = null;
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
		signIn?.controller.abort();
		clearInterval(timer);
		if (pendingFrame !== null) clearImmediate(pendingFrame);
		terminal.stop();
		resolveDone();
	};
	/** Start a scan. `after` queues one more when a running scan may predate an account change. */
	const refresh = ({ after = false } = {}) => {
		if (closed) return inFlight;
		if (inFlight) {
			if (after) refreshAgain = true;
			return inFlight;
		}
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
			} finally {
				inFlight = null;
				if (refreshAgain && !closed) { refreshAgain = false; refresh(); }
				draw();
			}
		})();
		return inFlight;
	};
	const manageable = () => providers.filter(provider => service.manageable(provider.id))
		.map(({ id, name }) => ({ id, name: name ?? id }));
	const providerById = id => providers.find(provider => provider.id === id);
	const errorText = error => sanitize(error?.message ?? String(error)).trim() || "Account change failed.";
	/** Reload rows after a change, show the notice, and rescan. */
	const changed = (notice, key) => {
		if (state.manage) showList(state.manage, notice, service.list(providers), key);
		if (key) state.selected = key;
		refresh({ after: true });
	};
	const openPanel = async () => {
		service ??= await defaultAccounts();
		if (closed || state.manage) return;
		state.showHelp = false;
		state.manage = openManage(manageable(), service.list(providers),
			{ providerFilter: state.providerFilter, selectedKey: state.selected });
		draw();
	};
	const startSignIn = effect => {
		const manage = state.manage;
		beginAuth(manage, { kind: effect.type, provider: effect.provider, label: effect.label });
		const auth = manage.auth;
		const controller = new AbortController();
		const current = { controller, prompt: null };
		signIn = current;
		const live = () => !closed && signIn === current && state.manage === manage && manage.auth === auth;
		const cancelled = () => new Error("Sign-in cancelled.");
		const loginContext = {
			signal: controller.signal,
			stdout: { write(text) { const message = lastLine(text); if (live() && message) { auth.message = message; draw(); } return true; } },
			openBrowser(url, { noBrowser } = {}) {
				if (!live()) return;
				auth.url = String(url);
				auth.status = "waiting";
				if (!noBrowser) service.openBrowser(auth.url);
				draw();
			},
			prompt(message) {
				if (controller.signal.aborted) return Promise.reject(cancelled());
				return new Promise((resolve, reject) => {
					current.prompt = { resolve, reject };
					controller.signal.addEventListener("abort", () => reject(cancelled()), { once: true });
					if (live()) { auth.prompt = sanitize(message).trim(); auth.input = ""; draw(); }
				});
			},
		};
		// Persist only while this sign-in is still the one on screen.
		const provider = providerById(effect.provider);
		const guarded = { ...provider, login: async ctx => {
			const credential = await provider.login(ctx);
			if (controller.signal.aborted) throw cancelled();
			return credential;
		} };
		(async () => {
			try {
				await service[effect.type](guarded, effect.label, loginContext);
				if (!live()) return;
				signIn = null;
				changed({ text: `${effect.type === "add" ? "Added" : "Signed in again to"} ${auth.providerName} ${effect.label}`, tone: "good" },
					`${effect.provider}:${effect.label}`);
			} catch (error) {
				if (!live()) return;
				signIn = null;
				failAuth(manage, errorText(error));
			}
			draw();
		})();
	};
	const runEffect = effect => {
		const manage = state.manage;
		if (effect.type === "close") { state.manage = null; return; }
		if (effect.type === "add" || effect.type === "reauth") { startSignIn(effect); return; }
		if (effect.type === "cancel") {
			signIn?.controller.abort();
			signIn = null;
			showList(manage, { text: "Sign-in cancelled", tone: "bad" });
			return;
		}
		if (effect.type === "submit") {
			const prompt = signIn?.prompt;
			if (!prompt) return;
			signIn.prompt = null;
			manage.auth.prompt = null;
			manage.auth.status = "exchanging";
			prompt.resolve(effect.value);
			return;
		}
		if (effect.type === "copy") { terminal.copy?.(manage.auth.url); manage.auth.note = "URL sent to the clipboard"; return; }
		if (effect.type === "open") { service.openBrowser(manage.auth.url); return; }
		const provider = providerById(effect.provider);
		try {
			if (effect.type === "rename") {
				service.rename(provider, effect.from, effect.to);
				changed({ text: `Renamed ${effect.from} to ${effect.to}`, tone: "good" }, `${effect.provider}:${effect.to}`);
			} else {
				service.remove(provider, effect.label);
				changed({ text: `Removed ${provider.name ?? provider.id} ${effect.label}`, tone: "good" }, null);
			}
		} catch (error) {
			if (effect.type === "rename" && manage.form) manage.form.error = errorText(error);
			else showList(manage, { text: errorText(error), tone: "bad" });
		}
	};
	const terminal = terminalFactory({ onResize: draw, onExit: finish, onKey(text, key) {
		if (!state.manage) return false;
		const effect = manageKey(state.manage, text, key);
		if (effect) runEffect(effect);
		draw();
		return true;
	}, onAction(action) {
		const page = Math.max(1, Math.floor((terminal.size.rows - 2) / 2));
		if (action === "quit") return finish();
		if (action === "refresh") { refresh(); return; }
		if (action === "manage") { openPanel().catch(() => {}); return; }
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
