import fs from "node:fs";

/** The running version, from the server's package.json (the web build and the image carry the same number). */
export const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string; } catch { return null; } })();

const REPO = "https://github.com/00xE8/archigov";

/**
 * The notices every user of the interactive interface is shown (AGPL-3.0 §5(d): copyright, no warranty, the licence)
 * and the offer of this build's source (§13). The default points at the release the version names; SOURCE_URL is for
 * whoever runs a modified or untagged build, whom §13 obliges to offer their own source.
 */
export function about() {
  const tag = VERSION ? `v${VERSION}` : "main";
  return {
    name: "Archigov",
    version: VERSION,
    copyright: "Copyright © 2026 Skygge Ltd and contributors",
    licence: "AGPL-3.0-only",
    licence_url: `${REPO}/blob/${tag}/LICENSE`,
    apache_url: `${REPO}/blob/${tag}/LICENSE-APACHE`,
    source_url: process.env.SOURCE_URL?.trim() || `${REPO}/tree/${tag}`,
    trademarks_url: `${REPO}/blob/main/TRADEMARKS.md`,
  };
}
