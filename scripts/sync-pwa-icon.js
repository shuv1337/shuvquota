#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const webRoot = new URL("../web/", import.meta.url);
const icon = readFileSync(new URL("icons/icon-180.png", webRoot));
const indexPath = new URL("index.html", webRoot);
const html = readFileSync(indexPath, "utf8");
const inlineLink = /(<link id="apple-touch-icon-inline"[^>]*\bhref=")[^"]*(")/;
if (!inlineLink.test(html)) {
	throw new Error("Missing apple-touch-icon-inline link in web/index.html");
}

writeFileSync(indexPath, html.replace(inlineLink, `$1data:image/png;base64,${icon.toString("base64")}$2`));
writeFileSync(new URL("apple-touch-icon.png", webRoot), icon);
console.log("Synced embedded and root Apple touch icons from web/icons/icon-180.png");
