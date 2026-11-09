/** Pure Claude reset-grant normalization. No redemption or credential access. */

const TYPES = ["fable", "weekly", "session", "full"];
const LABELS = { fable: "Fable", weekly: "Weekly", session: "5-hour", full: "Full" };

function instant(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Construct a safe, identifier-free reset group for snapshots and JSON. */
export function projectLimitReset(value) {
	if (!value || !TYPES.includes(value.type) || !Number.isSafeInteger(value.count) || value.count <= 0) return null;
	return { type: value.type, count: value.count, expiresAt: instant(value.expiresAt),
		...(instant(value.startsAt) ? { startsAt: instant(value.startsAt) } : {}) };
}

/** Parse cedar_ember grants, grouping held resets by kind AND expiry. */
export function parseClaudeLimitResets(usage, now = new Date()) {
	const block = usage?.cedar_ember;
	if (block?.eligible !== true || !Array.isArray(block.grants)) return [];
	const groups = new Map();
	for (const grant of block.grants) {
		if (!grant || !Number.isSafeInteger(grant.resets_left) || grant.resets_left <= 0 || grant.paused === true) continue;
		const expiresAt = instant(grant.ends_at);
		const startsAt = instant(grant.starts_at);
		// Invalid supplied dates are not evidence of a usable banked reset.
		if ((grant.ends_at != null && !expiresAt) || (grant.starts_at != null && !startsAt)) continue;
		if (expiresAt && Date.parse(expiresAt) <= +now) continue;
		const futureStart = startsAt && Date.parse(startsAt) > +now ? startsAt : null;
		let type = grant.gives_back_weekly === true ? "fable" : grant.type;
		if (!TYPES.includes(type)) {
			const clears = Array.isArray(grant.clears) ? grant.clears : [];
			const session = clears.includes("five_hour");
			const weekly = clears.some(value => typeof value === "string" && value.startsWith("seven_day"));
			if (!session && !weekly) continue;
			type = session && weekly ? "full" : session ? "session" : "weekly";
		}
		const key = `${type}:${expiresAt}:${futureStart}`;
		const group = groups.get(key) ?? { type, count: 0, expiresAt,
			...(futureStart ? { startsAt: futureStart } : {}) };
		group.count += grant.resets_left;
		groups.set(key, group);
	}
	return [...groups.values()].filter(group => Number.isSafeInteger(group.count)).sort((a, b) =>
		TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || (a.expiresAt ?? "z").localeCompare(b.expiresAt ?? "z")
		|| (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));
}

/** Build ordinary extras plus structured reset metadata; never copy grant IDs or labels. */
export function claudeLimitResetExtras(usage, now) {
	const groups = parseClaudeLimitResets(usage, now);
	if (!groups.length) return [];
	return [
		{ id: "limit-resets", label: "Limit resets", value: String(groups.reduce((sum, group) => sum + group.count, 0)) },
		...groups.map((reset, index) => ({
			id: `limit-reset-${reset.type}-${index + 1}`,
			label: `${LABELS[reset.type]} reset${reset.count === 1 ? "" : "s"}`,
			value: String(reset.count),
			reset,
		})),
	];
}
