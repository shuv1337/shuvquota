/**
 * Account-management panel for watch mode: account list, add and rename
 * forms, remove confirmation, and the sign-in screen. Pure state and key
 * handling; `manageKey` returns an effect for the app to perform and never
 * touches credentials itself. Depends on ./width.js.
 */

import { sanitize } from "./width.js";

/** Longest label the form accepts (characters). */
export const LABEL_MAX = 64;
const INPUT_MAX = 4096;

/**
 * @typedef {{ provider: string, providerName: string, label: string, email: string | null }} ManageRow
 * @typedef {{ id: string, name: string }} ManageProvider
 * @typedef {{ kind: "add" | "reauth", provider: string, providerName: string, label: string,
 *   url: string | null, status: "starting" | "waiting" | "exchanging" | "error",
 *   message: string | null, note: string | null, prompt: string | null, input: string, error: string | null }} ManageAuth
 * @typedef {{ view: "list" | "form" | "confirm" | "auth", providers: ManageProvider[], rows: ManageRow[],
 *   cursor: number, notice: { text: string, tone: "good" | "bad" } | null,
 *   form: { kind: "add" | "rename", providerIndex: number, row: ManageRow | null, input: string, error: string | null } | null,
 *   confirm: { row: ManageRow } | null, auth: ManageAuth | null }} ManageState
 * @typedef {{ type: "close" } | { type: "cancel" } | { type: "copy" } | { type: "open" }
 *   | { type: "submit", value: string }
 *   | { type: "add" | "reauth" | "remove", provider: string, label: string }
 *   | { type: "rename", provider: string, from: string, to: string }} ManageEffect
 */

/**
 * Open the panel. A provider tab scopes it to that provider when manageable.
 * @param {ManageProvider[]} providers - manageable providers, in display order
 * @param {ManageRow[]} rows
 * @param {{ providerFilter?: string | null, selectedKey?: string | null }} [options]
 * @returns {ManageState}
 */
export function openManage(providers, rows, { providerFilter = null, selectedKey = null } = {}) {
	const scoped = providers.filter(provider => provider.id === providerFilter);
	const manage = { view: "list", providers: scoped.length ? scoped : providers, rows: [], cursor: 0,
		notice: null, form: null, confirm: null, auth: null };
	setRows(manage, rows, selectedKey);
	return manage;
}

/**
 * Replace the listed rows, keeping the cursor on `key` ("provider:label") when present.
 * @param {ManageState} manage
 * @param {ManageRow[]} rows
 * @param {string | null} [key]
 */
export function setRows(manage, rows, key = null) {
	const ids = new Set(manage.providers.map(provider => provider.id));
	manage.rows = rows.filter(row => ids.has(row.provider));
	let index = -1;
	if (key !== null) {
		index = manage.rows.findIndex(row => `${row.provider}:${row.label}` === key
			|| `${row.provider}:${sanitize(row.label)}` === key);
		if (index < 0) index = manage.rows.findIndex(row => row.provider === key.slice(0, key.indexOf(":")));
	}
	manage.cursor = index >= 0 ? index : Math.max(0, Math.min(manage.cursor, manage.rows.length - 1));
}

/**
 * Apply one key to a single-line text field.
 * @param {string} value
 * @param {string | undefined} text
 * @param {{ name?: string, ctrl?: boolean, meta?: boolean }} key
 * @param {number} [max]
 * @returns {string | null} the new value, or null when the key is not an edit
 */
export function editLine(value, text, key = {}, max = INPUT_MAX) {
	if (key.name === "backspace") return [...value].slice(0, -1).join("");
	if (key.ctrl && key.name === "u") return "";
	if (key.ctrl && key.name === "w") return value.replace(/\S+\s*$|\s+$/, "");
	if (key.ctrl || key.meta || typeof text !== "string") return null;
	const clean = sanitize(text);
	if (!clean) return null;
	return [...value + clean].slice(0, max).join("");
}

/**
 * Enter the sign-in screen for an add or reauth.
 * @param {ManageState} manage
 * @param {{ kind: "add" | "reauth", provider: string, label: string }} target
 */
export function beginAuth(manage, { kind, provider, label }) {
	const providerName = manage.providers.find(item => item.id === provider)?.name ?? provider;
	manage.view = "auth";
	manage.notice = null;
	manage.auth = { kind, provider, providerName, label, url: null, status: "starting",
		message: null, note: null, prompt: null, input: "", error: null };
}

/**
 * Leave the sign-in screen after a failure. Failures before any URL was shown
 * (duplicate label, missing client config) return to where the user started.
 * @param {ManageState} manage
 * @param {string} message
 */
export function failAuth(manage, message) {
	const auth = manage.auth;
	if (!auth) return;
	if (auth.url === null) {
		manage.auth = null;
		if (auth.kind === "add" && manage.form) {
			manage.view = "form";
			manage.form.error = message;
		} else {
			manage.view = "list";
			manage.notice = { text: message, tone: "bad" };
		}
		return;
	}
	auth.status = "error";
	auth.prompt = null;
	auth.error = message;
}

/**
 * Return to the list with a notice, keeping the cursor on `key` if given.
 * @param {ManageState} manage
 * @param {{ text: string, tone: "good" | "bad" } | null} notice
 * @param {ManageRow[]} [rows]
 * @param {string | null} [key]
 */
export function showList(manage, notice, rows, key = null) {
	manage.view = "list";
	manage.form = null;
	manage.confirm = null;
	manage.auth = null;
	manage.notice = notice;
	if (rows) setRows(manage, rows, key);
}

const isEnter = key => key.name === "return" || key.name === "enter";

/**
 * Handle one key while the panel is open.
 * @param {ManageState} manage
 * @param {string | undefined} text
 * @param {{ name?: string, ctrl?: boolean, meta?: boolean, shift?: boolean }} [key]
 * @returns {ManageEffect | null}
 */
export function manageKey(manage, text, key = {}) {
	const escape = key.name === "escape";
	if (manage.view === "list") {
		if (escape || text === "q" || text === "m") return { type: "close" };
		const row = manage.rows[manage.cursor];
		if (key.name === "up" || text === "k" || key.name === "down" || text === "j") {
			const delta = key.name === "up" || text === "k" ? -1 : 1;
			manage.cursor = Math.max(0, Math.min(manage.rows.length - 1, manage.cursor + delta));
			return null;
		}
		if (text === "a") {
			const index = manage.providers.findIndex(provider => provider.id === row?.provider);
			manage.form = { kind: "add", providerIndex: Math.max(0, index), row: null, input: "", error: null };
			manage.view = "form";
			manage.notice = null;
			return null;
		}
		if (!row) return null;
		if (text === "r") return { type: "reauth", provider: row.provider, label: row.label };
		if (text === "n") {
			manage.form = { kind: "rename", providerIndex: 0, row, input: row.label, error: null };
			manage.view = "form";
			manage.notice = null;
		} else if (text === "d") {
			manage.confirm = { row };
			manage.view = "confirm";
			manage.notice = null;
		}
		return null;
	}
	if (manage.view === "form") {
		const form = manage.form;
		if (escape) { showList(manage, null); return null; }
		if (form.kind === "add" && ["left", "right", "tab"].includes(key.name)) {
			const step = key.name === "left" || (key.name === "tab" && key.shift) ? -1 : 1;
			const count = manage.providers.length;
			form.providerIndex = (form.providerIndex + step + count) % count;
			form.error = null;
			return null;
		}
		if (isEnter(key)) {
			const label = form.input.trim();
			if (!label) { form.error = "Enter a label."; return null; }
			if (form.kind === "add") return { type: "add", provider: manage.providers[form.providerIndex].id, label };
			return { type: "rename", provider: form.row.provider, from: form.row.label, to: label };
		}
		const next = editLine(form.input, text, key, LABEL_MAX);
		if (next !== null) { form.input = next; form.error = null; }
		return null;
	}
	if (manage.view === "confirm") {
		const { row } = manage.confirm;
		if (text === "y" || text === "Y") return { type: "remove", provider: row.provider, label: row.label };
		if (escape || text === "n" || text === "N") showList(manage, null);
		return null;
	}
	const auth = manage.auth;
	if (auth.status === "error") {
		if (escape || isEnter(key)) showList(manage, null);
		return null;
	}
	if (escape) return { type: "cancel" };
	if (key.ctrl && key.name === "y") return auth.url ? { type: "copy" } : null;
	if (key.ctrl && key.name === "o") return auth.url ? { type: "open" } : null;
	if (auth.prompt === null) return null;
	if (isEnter(key)) {
		const value = auth.input.trim();
		return value ? { type: "submit", value } : null;
	}
	const next = editLine(auth.input, text, key);
	if (next !== null) auth.input = next;
	return null;
}
