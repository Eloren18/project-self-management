// Builds vendor/tiptap.js — the self-contained rich-text editor bundle index.html loads.
//   npm run build:editor
// The output is committed on purpose: GitHub Pages serves the repo as-is (no build step),
// and the app must keep working offline. Rebuild only when bumping @tiptap/* in package.json.
import { build } from "esbuild";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ver = (pkg.devDependencies["@tiptap/core"] || "").replace(/^[^\d]*/, "");
const out = join(root, "vendor", "tiptap.js");

await build({
  entryPoints: [join(root, "tools", "editor-entry.js")],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "Tiptap",
  target: ["es2020"],
  legalComments: "none",
  outfile: out,
  banner: { js: `/* Tiptap ${ver} (+ ProseMirror) — built by tools/build-editor.mjs; do not edit by hand. MIT licensed. */` },
  define: { "process.env.NODE_ENV": '"production"' },
});
console.log("built", out, Math.round(statSync(out).size / 1024) + " KB");
