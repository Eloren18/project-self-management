// Copies the shared workspace chunk codec into the app.
//
// convex/chunks.js is the canonical copy (the backend imports it). index.html needs the
// very same functions — a device and the backend must split and hash a workspace
// identically, or the delta fetch falls back to the full fetch every time — so the page
// carries a generated copy between the two "ws-codec" markers, with the `export`
// keywords removed. tests/e2e-sync.mjs fails when the two copies differ.
//
//   node tools/sync-codec.mjs           rewrite the block in index.html
//   node tools/sync-codec.mjs --check   exit 1 when index.html is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const START = "/* ---- ws-codec:start (generated from convex/chunks.js by tools/sync-codec.mjs: edit THAT file, then run `npm run sync:codec`) ---- */";
const END = "/* ---- ws-codec:end ---- */";
const CRLF = String.fromCharCode(13, 10), LF = String.fromCharCode(10);
const toLF = (t) => t.split(CRLF).join(LF);

const codec = toLF(readFileSync(join(root, "convex", "chunks.js"), "utf8")).replace(/^export /gm, "").trim();
const pagePath = join(root, "index.html");
const pageRaw = readFileSync(pagePath, "utf8");
const pageHasCRLF = pageRaw.includes(CRLF); // a Windows checkout may hold CRLF: compare without them, write back in the page's own line endings
const page = toLF(pageRaw);
const i = page.indexOf(START), j = page.indexOf(END);
if (i < 0 || j < 0 || j < i) {
  console.error("ws-codec markers not found in index.html");
  process.exit(1);
}
const next = page.slice(0, i) + START + LF + codec + LF + page.slice(j);
if (process.argv.includes("--check")) {
  if (next !== page) { console.error("index.html carries a stale copy of convex/chunks.js — run: npm run sync:codec"); process.exit(1); }
  console.log("ws-codec: index.html is up to date");
} else if (next !== page) {
  writeFileSync(pagePath, pageHasCRLF ? next.split(LF).join(CRLF) : next);
  console.log("ws-codec: index.html updated (" + codec.length + " chars)");
} else console.log("ws-codec: index.html already up to date");
