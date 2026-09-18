#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadEnvFile } from "./lib/env.js";

// Load configuration before importing modules that read provider environment.
loadEnvFile();

let invoked = process.argv[1];
try { invoked = realpathSync(invoked); } catch { /* Imported or missing argv[1]. */ }
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
	try {
		const { runCli } = await import("./lib/cli.js");
		await runCli();
	} catch (error) {
		console.error(error.message);
		process.exitCode = error.exitCode ?? 1;
	}
}
