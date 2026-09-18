/**
 * Tests for the provider-agnostic v2 quota scan pipeline.
 * Run with: bun test test/quota.test.js
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_ACCOUNT_CONCURRENCY, loadSnapshot, pendingFlightCount } from "../lib/quota.js";
import { SNAPSHOT_SCHEMA_VERSION } from "../lib/snapshot.js";

const NOW = new Date("2026-01-10T00:00:00.000Z");

/** @returns {{ promise: Promise<void>, resolve: () => void }} */
function deferred() {
	let resolve;
	const promise = new Promise(done => {
		resolve = done;
	});
	return { promise, resolve: /** @type {() => void} */ (resolve) };
}

/** @param {number} ms */
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A healthy payload every built-in normalizer understands: Codex reads
 * `rate_limit`, Claude reads `five_hour`, Grok reads `creditUsagePercent`, and
 * the generic fallback reads `windows`. Tests that assert one provider's
 * parsing build their own payload instead.
 * @returns {object}
 */
function okUsage() {
	return {
		usage: {
			rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
			five_hour: { utilization: 10 },
			creditUsagePercent: 10,
			windows: [{ id: "session", label: "Session", used_percent: 10 }],
		},
	};
}

/**
 * A minimal injected provider. Nothing here imports production code.
 * @param {{
 *   id: string,
 *   name?: string,
 *   accounts?: Array<object>,
 *   discover?: Function,
 *   fetch?: Function,
 *   normalize?: Function,
 * }} config
 */
function makeProvider(config) {
	const provider = {
		id: config.id,
		discoverAccounts: config.discover
			?? (() => (config.accounts ?? []).map(account => ({ ...account }))),
		fetch: config.fetch ?? (account => ({ ...okUsage(), label: account.label })),
	};
	if (config.name) provider.name = config.name;
	if (config.normalize) provider.normalize = config.normalize;
	return provider;
}

/** @param {object} snapshot */
function shape(snapshot) {
	return snapshot.providers.map(provider => [
		provider.id,
		provider.accounts.map(account => account.label),
	]);
}

describe("loadSnapshot ordering", () => {
	test("emits providers in fixed display order regardless of input order", async () => {
		const snapshot = await loadSnapshot({
			providers: [
				makeProvider({ id: "antigravity", accounts: [{ label: "g" }] }),
				makeProvider({ id: "grok", accounts: [{ label: "x" }] }),
				makeProvider({ id: "claude", accounts: [{ label: "c" }] }),
				makeProvider({ id: "codex", accounts: [{ label: "o" }] }),
			],
			now: NOW,
		});
		expect(snapshot.providers.map(provider => provider.id))
			.toEqual(["codex", "claude", "grok", "antigravity"]);
	});

	test("places unknown providers after the known ones, keeping input order", async () => {
		const snapshot = await loadSnapshot({
			providers: [
				makeProvider({ id: "zeta" }),
				makeProvider({ id: "alpha" }),
				makeProvider({ id: "claude" }),
			],
			now: NOW,
		});
		expect(snapshot.providers.map(provider => provider.id)).toEqual(["claude", "zeta", "alpha"]);
	});

	test("sorts accounts by label, stably for ties", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				accounts: [{ label: "work" }, { label: "alpha" }, { label: "alpha" }, { label: "Beta" }],
			})],
			now: NOW,
		});
		expect(snapshot.providers[0].accounts.map(account => account.label))
			.toEqual(["Beta", "alpha", "alpha", "work"]);
	});

	test("names providers from the injected name, else the id", async () => {
		const snapshot = await loadSnapshot({
			providers: [
				makeProvider({ id: "grok" }),
				makeProvider({ id: "codex", name: "Codex CLI" }),
			],
			now: NOW,
		});
		expect(snapshot.providers.map(provider => provider.name)).toEqual(["Codex CLI", "SuperGrok"]);
	});
});

describe("loadSnapshot results", () => {
	test("resolves a completed schemaVersion 2 snapshot", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({ id: "codex", accounts: [{ label: "work" }] })],
			now: NOW,
		});
		expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
		expect(snapshot.complete).toBe(true);
		expect(snapshot.generatedAt).toBe(NOW.toISOString());
		expect(snapshot.startedAt).toBe(NOW.toISOString());
		expect(snapshot.providers[0].loading).toBe(false);
		expect(snapshot.providers[0].accounts[0]).toMatchObject({
			label: "work",
			status: "ok",
		});
	});

	test("passes the scan clock to the provider normalizer", async () => {
		const seen = [];
		const snapshot = await loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				accounts: [{ label: "work" }],
				normalize: (account, result, now) => {
					seen.push(now);
					return { label: account.label, windows: [] };
				},
			})],
			now: NOW,
		});
		expect(seen).toEqual([NOW]);
		expect(snapshot.providers[0].accounts[0]).toMatchObject({
			status: "error",
			error: "Quota data unavailable",
		});
	});

	test("uses the built-in normalizer for a known provider id", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({
				id: "grok",
				accounts: [{ label: "main" }],
				fetch: () => ({ tier: 5, usage: { creditUsagePercent: 25 } }),
			})],
			now: NOW,
		});
		const account = snapshot.providers[0].accounts[0];
		expect(account.plan).toBe("SuperGrok Heavy");
		expect(account.windows[0]).toMatchObject({ id: "credits", percentRemaining: 75 });
	});

	test("accepts an async discover and an async fetch", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				discover: async () => {
					await sleep(1);
					return [{ label: "work" }];
				},
				fetch: async () => {
					await sleep(1);
					return { usage: { rate_limit: { primary_window: { used_percent: 50 } } } };
				},
			})],
			now: NOW,
		});
		expect(snapshot.providers[0].accounts[0].windows[0].percentRemaining).toBe(50);
	});

	test("tolerates a provider missing discoverAccounts entirely", async () => {
		const snapshot = await loadSnapshot({ providers: [{ id: "codex" }], now: NOW });
		expect(snapshot.providers[0].accounts).toEqual([]);
		expect(snapshot.providers[0].error).toBeNull();
	});

	test("ignores non-object providers and deduplicates by identity", async () => {
		const provider = makeProvider({ id: "codex", accounts: [{ label: "work" }] });
		const snapshot = await loadSnapshot({
			providers: [provider, provider, null, "codex", 7],
			now: NOW,
		});
		expect(snapshot.providers).toHaveLength(1);
		expect(snapshot.summary.accountCount).toBe(1);
	});
});

describe("loadSnapshot error isolation", () => {
	test("a discovery failure marks one provider without failing the scan", async () => {
		const snapshot = await loadSnapshot({
			providers: [
				makeProvider({
					id: "codex",
					discover: () => {
						throw new Error("ENOENT /home/shuv/.codex/auth.json");
					},
				}),
				makeProvider({ id: "claude", accounts: [{ label: "personal" }] }),
			],
			now: NOW,
		});
		expect(snapshot.complete).toBe(true);
		expect(snapshot.providers[0].error).toBe("ENOENT [redacted]");
		expect(snapshot.providers[0].accounts).toEqual([]);
		expect(snapshot.providers[0].loading).toBe(false);
		expect(snapshot.providers[1].accounts[0].status).toBe("ok");
	});

	test("a fetch rejection becomes an error account, not a scan failure", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				accounts: [{ label: "bad" }, { label: "good" }],
				fetch: account => {
					if (account.label === "bad") throw new Error("HTTP 500 from upstream");
					return okUsage();
				},
			})],
			now: NOW,
		});
		const [bad, good] = snapshot.providers[0].accounts;
		expect(bad).toMatchObject({ label: "bad", status: "error", error: "HTTP 500 from upstream" });
		expect(good.status).toBe("ok");
	});

	test("a throwing normalizer becomes an error account", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				accounts: [{ label: "work" }],
				normalize: () => {
					throw new Error("normalizer exploded");
				},
			})],
			now: NOW,
		});
		expect(snapshot.providers[0].accounts[0]).toMatchObject({
			label: "work",
			status: "error",
			error: "normalizer exploded",
		});
	});

	test("resolves even when every provider and every account fails", async () => {
		const snapshot = await loadSnapshot({
			providers: [
				makeProvider({
					id: "codex",
					accounts: [{ label: "a" }, { label: "b" }],
					fetch: () => {
						throw new Error("boom");
					},
				}),
				makeProvider({
					id: "claude",
					discover: () => {
						throw new Error("boom");
					},
				}),
			],
			now: NOW,
		});
		expect(snapshot.complete).toBe(true);
		expect(snapshot.summary.errorCount).toBe(2);
		expect(snapshot.providers[1].error).toBe("boom");
	});

	test("a malformed fetch result yields an error account, not a crash", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				accounts: [{ label: "work" }],
				fetch: () => "not an object",
			})],
			now: NOW,
		});
		expect(snapshot.providers[0].accounts[0]).toMatchObject({
			label: "work",
			status: "error",
			error: "Quota data unavailable",
			windows: [],
		});
	});

	test("a hostile normalizer cannot smuggle credentials into the snapshot", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				accounts: [{ label: "work" }],
				normalize: () => ({
					label: "work",
					accessToken: "sk_" + "live_abcdefghijklmnopqrstuvwx",
					credentialsPath: "/home/shuv/.codex/auth.json",
					accountId: "acct_12345",
					status: "ok",
					windows: [{ id: "session", percentRemaining: 50, refreshToken: "rt_secret_value" }],
				}),
			})],
			now: NOW,
		});
		const account = snapshot.providers[0].accounts[0];
		expect(Object.keys(account).sort())
			.toEqual(["email", "error", "extras", "label", "plan", "status", "windows"]);
		const json = JSON.stringify(snapshot);
		expect(json).not.toContain("sk_live");
		expect(json).not.toContain("acct_12345");
		expect(json).not.toContain("/home/shuv");
		expect(json).not.toContain("rt_secret_value");
	});
});

describe("loadSnapshot progress", () => {
	test("the first frame is incomplete and carries no generatedAt", async () => {
		const frames = [];
		await loadSnapshot({
			providers: [makeProvider({ id: "codex", accounts: [{ label: "work" }] })],
			onProgress: frame => frames.push(frame),
			now: NOW,
		});
		expect(frames[0].complete).toBe(false);
		expect(frames[0].generatedAt).toBeNull();
		expect(frames[0].startedAt).toBe(NOW.toISOString());
	});

	test("reports loading skeletons before the accounts resolve", async () => {
		const gate = deferred();
		const frames = [];
		const scan = loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				accounts: [{ label: "work" }],
				fetch: async () => {
					await gate.promise;
					return okUsage();
				},
			})],
			onProgress: frame => frames.push(frame),
			now: NOW,
		});
		await sleep(5);
		const skeleton = frames.at(-1).providers[0];
		expect(skeleton.loading).toBe(true);
		expect(skeleton.accounts[0]).toMatchObject({ label: "work", status: "loading", windows: [] });
		expect(frames.at(-1).summary.loadingCount).toBe(1);
		gate.resolve();
		const final = await scan;
		expect(final.providers[0].accounts[0].status).toBe("ok");
		expect(final.summary.loadingCount).toBe(0);
	});

	test("the last progress frame is the resolved snapshot", async () => {
		const frames = [];
		const snapshot = await loadSnapshot({
			providers: [makeProvider({ id: "codex", accounts: [{ label: "work" }] })],
			onProgress: frame => frames.push(frame),
			now: NOW,
		});
		expect(frames.at(-1)).toBe(snapshot);
		expect(frames.length).toBeGreaterThan(1);
	});

	test("a late subscriber receives the latest frame immediately, then later ones", async () => {
		const gate = deferred();
		const early = [];
		const late = [];
		const providers = [makeProvider({
			id: "codex",
			accounts: [{ label: "work" }],
			fetch: async () => {
				await gate.promise;
				return okUsage();
			},
		})];
		const first = loadSnapshot({ providers, onProgress: frame => early.push(frame), now: NOW });
		await sleep(5);
		const second = loadSnapshot({ providers, onProgress: frame => late.push(frame), now: NOW });
		expect(late).toHaveLength(1);
		expect(late[0]).toBe(early.at(-1));
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(late.at(-1)).toBe(a);
		expect(late.length).toBeGreaterThan(1);
	});

	test("a throwing subscriber neither breaks the scan nor starves other subscribers", async () => {
		const good = [];
		const gate = deferred();
		const slow = [makeProvider({
			id: "codex",
			accounts: [{ label: "work" }],
			fetch: async () => {
				await gate.promise;
				return okUsage();
			},
		})];
		const first = loadSnapshot({
			providers: slow,
			onProgress: () => {
				throw new Error("subscriber exploded");
			},
			now: NOW,
		});
		const second = loadSnapshot({ providers: slow, onProgress: frame => good.push(frame), now: NOW });
		gate.resolve();
		const snapshot = await first;
		await second;
		expect(snapshot.complete).toBe(true);
		expect(good.at(-1)).toBe(snapshot);
	});

	test("onProgress is optional", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({ id: "codex", accounts: [{ label: "work" }] })],
			onProgress: "not a function",
			now: NOW,
		});
		expect(snapshot.complete).toBe(true);
	});
});

describe("loadSnapshot concurrency", () => {
	/** @param {{ id: string, count: number, tracker: { active: number, peak: number } }} config */
	function trackingProvider({ id, count, tracker }) {
		return makeProvider({
			id,
			accounts: Array.from({ length: count }, (_unused, index) => ({ label: `a${index}` })),
			fetch: async () => {
				tracker.active += 1;
				tracker.peak = Math.max(tracker.peak, tracker.active);
				await sleep(5);
				tracker.active -= 1;
				return { usage: { windows: [{ id: "session", used_percent: 10 }] } };
			},
		});
	}

	test("caps account fetches at four per provider", async () => {
		const tracker = { active: 0, peak: 0 };
		const snapshot = await loadSnapshot({
			providers: [trackingProvider({ id: "codex", count: 12, tracker })],
			now: NOW,
		});
		expect(DEFAULT_ACCOUNT_CONCURRENCY).toBe(4);
		expect(tracker.peak).toBe(4);
		expect(snapshot.providers[0].accounts).toHaveLength(12);
	});

	test("the cap is per provider, so providers still run concurrently", async () => {
		const codex = { active: 0, peak: 0 };
		const claude = { active: 0, peak: 0 };
		const combined = { active: 0, peak: 0 };
		const wrap = tracker => async () => {
			tracker.active += 1;
			combined.active += 1;
			tracker.peak = Math.max(tracker.peak, tracker.active);
			combined.peak = Math.max(combined.peak, combined.active);
			await sleep(5);
			tracker.active -= 1;
			combined.active -= 1;
			return {};
		};
		await loadSnapshot({
			providers: [
				makeProvider({
					id: "codex",
					accounts: Array.from({ length: 8 }, (_u, i) => ({ label: `c${i}` })),
					fetch: wrap(codex),
				}),
				makeProvider({
					id: "claude",
					accounts: Array.from({ length: 8 }, (_u, i) => ({ label: `l${i}` })),
					fetch: wrap(claude),
				}),
			],
			now: NOW,
		});
		expect(codex.peak).toBe(4);
		expect(claude.peak).toBe(4);
		expect(combined.peak).toBeGreaterThan(4);
		expect(combined.peak).toBeLessThanOrEqual(8);
	});

	test("honours an explicit concurrency override", async () => {
		const tracker = { active: 0, peak: 0 };
		await loadSnapshot({
			providers: [trackingProvider({ id: "codex", count: 6, tracker })],
			concurrency: 2,
			now: NOW,
		});
		expect(tracker.peak).toBe(2);
	});
});

describe("loadSnapshot label filtering", () => {
	test("keeps only the exactly matching label, case-insensitively", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				accounts: [{ label: "work" }, { label: "WORK-2" }, { label: "Work" }],
			})],
			labelFilter: "work",
			now: NOW,
		});
		expect(snapshot.providers[0].accounts.map(account => account.label)).toEqual(["Work", "work"]);
	});

	test("a filter matching nothing yields an empty provider, not an error", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({ id: "codex", accounts: [{ label: "work" }] })],
			labelFilter: "absent",
			now: NOW,
		});
		expect(snapshot.providers[0].accounts).toEqual([]);
		expect(snapshot.providers[0].error).toBeNull();
		expect(snapshot.complete).toBe(true);
	});

	test("forwards the filter to discovery", async () => {
		const seen = [];
		await loadSnapshot({
			providers: [makeProvider({
				id: "codex",
				discover: options => {
					seen.push(options.labelFilter);
					return [{ label: "work" }];
				},
			})],
			labelFilter: "  work  ",
			now: NOW,
		});
		expect(seen).toEqual(["work"]);
	});

	test("a blank filter is treated as no filter", async () => {
		const snapshot = await loadSnapshot({
			providers: [makeProvider({ id: "codex", accounts: [{ label: "work" }, { label: "side" }] })],
			labelFilter: "   ",
			now: NOW,
		});
		expect(snapshot.providers[0].accounts).toHaveLength(2);
	});
});

describe("loadSnapshot single-flight", () => {
	test("concurrent scans of the same providers and filter share one discovery", async () => {
		const gate = deferred();
		let discoveries = 0;
		const providers = [makeProvider({
			id: "codex",
			discover: async () => {
				discoveries += 1;
				await gate.promise;
				return [{ label: "work" }];
			},
		})];
		const first = loadSnapshot({ providers, now: NOW });
		const second = loadSnapshot({ providers, now: NOW });
		expect(pendingFlightCount()).toBe(1);
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(discoveries).toBe(1);
		expect(a).toBe(b);
		expect(pendingFlightCount()).toBe(0);
	});

	test("different label filters are different flights", async () => {
		const gate = deferred();
		const filters = [];
		const providers = [makeProvider({
			id: "codex",
			discover: async options => {
				filters.push(options.labelFilter);
				await gate.promise;
				return [{ label: "work" }];
			},
		})];
		const first = loadSnapshot({ providers, labelFilter: "work", now: NOW });
		const second = loadSnapshot({ providers, labelFilter: "side", now: NOW });
		expect(pendingFlightCount()).toBe(2);
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(filters.sort()).toEqual(["side", "work"]);
		expect(a).not.toBe(b);
		expect(pendingFlightCount()).toBe(0);
	});

	test("distinct provider instances sharing an id do not share a flight", async () => {
		const gate = deferred();
		let discoveries = 0;
		const build = () => makeProvider({
			id: "codex",
			discover: async () => {
				discoveries += 1;
				await gate.promise;
				return [{ label: "work" }];
			},
		});
		const first = loadSnapshot({ providers: [build()], now: NOW });
		const second = loadSnapshot({ providers: [build()], now: NOW });
		expect(pendingFlightCount()).toBe(2);
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(discoveries).toBe(2);
		expect(a).not.toBe(b);
	});

	test("a differing provider set is a different flight", async () => {
		const gate = deferred();
		const codex = makeProvider({
			id: "codex",
			discover: async () => {
				await gate.promise;
				return [{ label: "work" }];
			},
		});
		const claude = makeProvider({ id: "claude", accounts: [{ label: "personal" }] });
		const first = loadSnapshot({ providers: [codex], now: NOW });
		const second = loadSnapshot({ providers: [codex, claude], now: NOW });
		expect(pendingFlightCount()).toBe(2);
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(shape(a)).toEqual([["codex", ["work"]]]);
		expect(shape(b)).toEqual([["codex", ["work"]], ["claude", ["personal"]]]);
	});

	test("the same set in a different order joins the same flight", async () => {
		const gate = deferred();
		const codex = makeProvider({
			id: "codex",
			discover: async () => {
				await gate.promise;
				return [{ label: "work" }];
			},
		});
		const claude = makeProvider({ id: "claude", accounts: [{ label: "personal" }] });
		const first = loadSnapshot({ providers: [codex, claude], now: NOW });
		const second = loadSnapshot({ providers: [claude, codex], now: NOW });
		expect(pendingFlightCount()).toBe(1);
		gate.resolve();
		expect(await first).toBe(await second);
	});

	test("a settled flight is released so the next scan re-discovers", async () => {
		let discoveries = 0;
		const providers = [makeProvider({
			id: "codex",
			discover: () => {
				discoveries += 1;
				return [{ label: "work" }];
			},
		})];
		await loadSnapshot({ providers, now: NOW });
		await loadSnapshot({ providers, now: NOW });
		expect(discoveries).toBe(2);
		expect(pendingFlightCount()).toBe(0);
	});

	test("a failing flight is still released", async () => {
		const providers = [makeProvider({
			id: "codex",
			discover: () => {
				throw new Error("boom");
			},
		})];
		await loadSnapshot({ providers, now: NOW });
		expect(pendingFlightCount()).toBe(0);
	});
});
