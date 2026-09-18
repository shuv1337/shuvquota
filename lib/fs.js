/**
 * File system helpers: symlink-aware write, atomic file operations.
 * Zero internal dependencies — only uses Node.js built-ins.
 */

import {
	existsSync,
	writeFileSync,
	mkdirSync,
	openSync,
	closeSync,
	unlinkSync,
	renameSync,
	realpathSync,
	lstatSync,
	readlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve, isAbsolute } from "node:path";

/**
 * Resolve the correct write target for a path, preserving symlink files.
 * @param {string} filePath - Intended path to write
 * @returns {{ path: string, isSymlink: boolean }}
 */
export function resolveWritePath(filePath) {
	try {
		const stats = lstatSync(filePath);
		if (!stats.isSymbolicLink()) {
			return { path: filePath, isSymlink: false };
		}
		try {
			return { path: realpathSync(filePath), isSymlink: true };
		} catch {
			let linkTarget = readlinkSync(filePath);
			if (!isAbsolute(linkTarget)) {
				linkTarget = resolve(dirname(filePath), linkTarget);
			}
			return { path: linkTarget, isSymlink: true };
		}
	} catch {
		return { path: filePath, isSymlink: false };
	}
}

/**
 * Write a file atomically while preserving existing symlink files.
 * @param {string} filePath - Intended path to write
 * @param {string} contents - File contents
 * @param {{ mode?: number, followSymlinks?: boolean }} [options]
 * @returns {string} Actual path written
 */
export function writeFileAtomic(filePath, contents, options = {}) {
	const resolved = resolveWritePath(filePath);
	if (options.followSymlinks === false && resolved.isSymlink) {
		throw new Error("Managed credential stores must not be symbolic links.");
	}
	const targetPath = resolved.path;
	const dir = dirname(targetPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const tempPath = `${targetPath}.${randomUUID()}.tmp`;
	let fd;
	let created = false;
	try {
		// Set permissions at creation, before any credential bytes are written.
		fd = openSync(tempPath, "wx", options.mode ?? 0o600);
		created = true;
		writeFileSync(fd, contents, "utf-8");
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, targetPath);
		created = false;
		return targetPath;
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (created) unlinkSync(tempPath);
	}
}
