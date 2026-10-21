/**
 * Provider-agnostic quota scan pipeline (`schemaVersion: 2`).
 * Depends on: lib/snapshot.js
 *
 * Providers are injected, never imported: this module knows nothing about
 * Codex, Claude, Grok, or Antigravity beyond their display order. Discovery
 * runs concurrently across providers; account fetches run at most
 * `DEFAULT_ACCOUNT_CONCURRENCY` at a time per provider. A failure anywhere
 * below the scan — discovery, fetch, or normalize — becomes an error rendered
 * inside the snapshot, so `loadSnapshot` resolves even when everything fails.
 */

import {
	ACCOUNT_NORMALIZERS,
	PROVIDER_ORDER,
	buildSnapshot,
	coerceAccountSnapshot,
	createErrorAccountSnapshot,
	createLoadingAccountSnapshot,
	normalizeGenericAccount,
	sanitizeErrorText,
} from "./snapshot.js";
import { compareLabels } from "./display.js";

export const DEFAULT_ACCOUNT_CONCURRENCY = 4;

/**
 * Identity tokens for injected provider objects. Two providers may share an
 * `id` while being distinct instances (a test double and the real adapter, or
 * two differently configured clients), so single-flight keys are derived from
 * object identity rather than from `id`.
 * @type {WeakMap<object, string>}
 */
const PROVIDER_TOKENS = new WeakMap();
let tokenCounter = 0;

/** @type {Map<string, { subscribers: Set<Function>, latest: object | null, promise: Promise<object> | null }>} */
const FLIGHTS = new Map();

/**
 * @param {object} provider
 * @returns {string}
 */
function providerToken(provider) {
	let token = PROVIDER_TOKENS.get(provider);
	if (!token) {
		tokenCounter += 1;
		token = `p${tokenCounter}`;
		PROVIDER_TOKENS.set(provider, token);
	}
	return token;
}

/**
 * @param {Array<object>} providers
 * @param {string | null} labelFilter
 * @returns {string}
 */
function flightKey(providers, labelFilter) {
	const tokens = providers.map(providerToken).sort();
	return `${tokens.join("\u0000")}|${labelFilter ?? ""}`;
}

/**
 * @param {unknown} providers
 * @returns {Array<object>}
 */
function dedupeProviders(providers) {
	const seen = new Set();
	const list = [];
	for (const provider of Array.isArray(providers) ? providers : []) {
		if (!provider || typeof provider !== "object") continue;
		if (seen.has(provider)) continue;
		seen.add(provider);
		list.push(provider);
	}
	return list;
}

/**
 * Fixed display order first, then unknown providers in input order.
 * @param {Array<object>} providers
 * @returns {Array<object>}
 */
function orderProviders(providers) {
	return providers
		.map((provider, index) => {
			const rank = PROVIDER_ORDER.indexOf(
				typeof provider.id === "string" ? provider.id : "",
			);
			return { provider, index, rank: rank === -1 ? PROVIDER_ORDER.length : rank };
		})
		.sort((left, right) => left.rank - right.rank || left.index - right.index)
		.map(entry => entry.provider);
}

/**
 * @param {Array<object>} accounts
 * @returns {Array<object>}
 */
function sortAccounts(accounts) {
	return accounts
		.map((account, index) => ({ account, index }))
		.sort((left, right) => {
			const a = typeof left.account.label === "string" ? left.account.label : "";
			const b = typeof right.account.label === "string" ? right.account.label : "";
			return compareLabels(a, b) || left.index - right.index;
		})
		.map(entry => entry.account);
}

/**
 * Case-insensitive exact match on the discovered label.
 * @param {object} account
 * @param {string} labelFilter
 * @returns {boolean}
 */
function matchesLabel(account, labelFilter) {
	const label = typeof account.label === "string" ? account.label.trim() : "";
	return label.toLowerCase() === labelFilter.toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {Date}
 */
function resolveNow(value) {
	if (typeof value === "function") {
		const produced = value();
		return produced instanceof Date && !Number.isNaN(produced.getTime()) ? produced : new Date();
	}
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	return new Date();
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 * @template T
 * @param {Array<T>} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} worker
 * @returns {Promise<void>}
 */
async function runPool(items, limit, worker) {
	if (items.length === 0) return;
	const size = Math.max(1, Math.min(limit, items.length));
	let cursor = 0;
	const run = async () => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			await worker(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: size }, run));
}

/**
 * A subscriber that throws must not abort the scan or starve other
 * subscribers.
 * @param {Function} subscriber
 * @param {object} frame
 */
function emitTo(subscriber, frame) {
	try {
		subscriber(frame);
	} catch {
		// Progress delivery is best effort.
	}
}

/**
 * @param {{ provider: object, id: string }} state
 * @param {{ account: object, index: number }} entry
 * @param {{ labelFilter: string | null, now: Date }} ctx
 * @returns {Promise<object>}
 */
async function fetchAccount(state, entry, ctx) {
	let result;
	try {
		result = await state.provider.fetch?.(entry.account, {
			labelFilter: ctx.labelFilter,
			now: ctx.now,
		});
	} catch (error) {
		return createErrorAccountSnapshot(entry.account, error, { index: entry.index });
	}
	try {
		const normalized = typeof state.provider.normalize === "function"
			? state.provider.normalize(entry.account, result, ctx.now, { index: entry.index })
			: (ACCOUNT_NORMALIZERS[state.id] ?? normalizeGenericAccount)(
				entry.account,
				result,
				ctx.now,
				{ index: entry.index },
			);
		return coerceAccountSnapshot(normalized, { account: entry.account, index: entry.index });
	} catch (error) {
		return createErrorAccountSnapshot(entry.account, error, { index: entry.index });
	}
}

/**
 * @param {object} state
 * @param {{ labelFilter: string | null, now: Date, concurrency: number, publish: Function }} ctx
 * @returns {Promise<void>}
 */
async function runProvider(state, ctx) {
	let discovered;
	try {
		discovered = await state.provider.discoverAccounts?.({ labelFilter: ctx.labelFilter });
	} catch (error) {
		state.error = sanitizeErrorText(error) ?? "Account discovery failed";
		state.loading = false;
		ctx.publish();
		return;
	}
	const accounts = (Array.isArray(discovered) ? discovered : [])
		.filter(account => account && typeof account === "object");
	const filtered = ctx.labelFilter
		? accounts.filter(account => matchesLabel(account, ctx.labelFilter))
		: accounts;
	state.entries = sortAccounts(filtered).map((account, index) => ({
		account,
		index,
		snapshot: createLoadingAccountSnapshot(account, { index }),
	}));
	if (state.entries.length > 0) ctx.publish();
	await runPool(state.entries, ctx.concurrency, async entry => {
		entry.snapshot = await fetchAccount(state, entry, ctx);
		ctx.publish();
	});
	state.loading = false;
	ctx.publish();
}

/**
 * @param {Array<object>} providers
 * @param {string | null} labelFilter
 * @param {{ subscribers: Set<Function>, latest: object | null }} flight
 * @param {object} options
 * @returns {Promise<object>}
 */
async function runFlight(providers, labelFilter, flight, options) {
	const now = resolveNow(options.now);
	const startedAt = now.toISOString();
	const requested = Number(options.concurrency);
	const concurrency = Number.isFinite(requested) && requested >= 1
		? Math.floor(requested)
		: DEFAULT_ACCOUNT_CONCURRENCY;

	const states = orderProviders(providers).map(provider => ({
		provider,
		id: typeof provider.id === "string" ? provider.id : "provider",
		name: provider.name,
		/** @type {Array<{ account: object, index: number, snapshot: object }>} */
		entries: [],
		/** @type {string | null} */
		error: null,
		loading: true,
	}));

	/**
	 * @param {boolean} complete
	 * @returns {object}
	 */
	const publish = (complete = false) => {
		const frame = buildSnapshot(
			states.map(state => ({
				id: state.id,
				name: state.name,
				accounts: state.entries.map(entry => entry.snapshot),
				error: state.error,
				loading: state.loading,
			})),
			{
				startedAt,
				generatedAt: complete ? resolveNow(options.now) : null,
				complete,
				allowLoading: true,
			},
		);
		flight.latest = frame;
		for (const subscriber of [...flight.subscribers]) emitTo(subscriber, frame);
		return frame;
	};

	publish(false);
	await Promise.all(states.map(state => runProvider(state, {
		labelFilter,
		now,
		concurrency,
		publish: () => publish(false),
	})));
	return publish(true);
}

/**
 * Scan every injected provider and resolve with a complete snapshot.
 *
 * Concurrent calls sharing the same provider set (by object identity) and
 * label filter join a single in-flight scan; a late caller's `onProgress`
 * receives the latest frame immediately, then every later frame. The first
 * frame carries `complete: false` and `generatedAt: null` — only the resolved
 * snapshot is stamped as finished.
 *
 * @param {{
 *   providers?: Array<object>,
 *   labelFilter?: string | null,
 *   onProgress?: (snapshot: object) => void,
 *   concurrency?: number,
 *   now?: Date | (() => Date),
 * }} [options]
 * @returns {Promise<object>}
 */
export function loadSnapshot(options = {}) {
	const providers = dedupeProviders(options.providers);
	const rawFilter = typeof options.labelFilter === "string" ? options.labelFilter.trim() : "";
	const labelFilter = rawFilter.toLowerCase() || null;
	const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
	const key = flightKey(providers, labelFilter);

	const existing = FLIGHTS.get(key);
	if (existing) {
		if (onProgress) {
			existing.subscribers.add(onProgress);
			if (existing.latest) emitTo(onProgress, existing.latest);
		}
		return /** @type {Promise<object>} */ (existing.promise);
	}

	/** @type {{ subscribers: Set<Function>, latest: object | null, promise: Promise<object> | null }} */
	const flight = { subscribers: new Set(), latest: null, promise: null };
	if (onProgress) flight.subscribers.add(onProgress);
	// `runFlight` publishes its first frame synchronously, so a subscriber that
	// calls back into `loadSnapshot` would otherwise observe a null promise.
	// Registering a deferred first keeps the flight joinable from frame zero.
	/** @type {(value: Promise<object>) => void} */
	let settle;
	flight.promise = new Promise(resolve => {
		settle = resolve;
	});
	FLIGHTS.set(key, flight);
	settle(runFlight(providers, labelFilter, flight, options).finally(() => {
		FLIGHTS.delete(key);
	}));
	return flight.promise;
}

/**
 * Number of scans currently in flight. Exposed for tests and for the TUI to
 * avoid stacking redundant refreshes.
 * @returns {number}
 */
export function pendingFlightCount() {
	return FLIGHTS.size;
}
