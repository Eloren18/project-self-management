// Convert an InstantDB export (from export-instantdb.mjs) into per-table JSONL files
// shaped for the Convex schema, ready for `npx convex import --table <name> <file> --append`.
//
//   node tools/convert-export.mjs instantdb-export-2026-08-22.json
//
// Writes migration/{workspaces,snapshots,securityLog,devices}.jsonl (git-ignored)
// and prints counts only.
import fs from "node:fs";
import path from "node:path";

const ADMIN_EMAIL = "keremladkeholland@gmail.com";
const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error("usage: node tools/convert-export.mjs <instantdb-export.json>"); process.exit(1); }
const ex = JSON.parse(fs.readFileSync(src, "utf8"));
const email = (((ex.$users || [])[0] || {}).email || ADMIN_EMAIL).trim().toLowerCase();
const outDir = "migration"; fs.mkdirSync(outDir, { recursive: true });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
const str = (d) => (typeof d === "string" ? d : JSON.stringify(d ?? {}));
const num = (x, f = 0) => (typeof x === "number" && isFinite(x) ? x : f);

// workspaces: keep only the NEWEST (there should be exactly one)
const ws = (ex.workspaces || []).slice().sort((a, b) => num(b.updatedAt) - num(a.updatedAt));
if (ws.length > 1) console.warn(`note: ${ws.length} workspace rows in export — importing the newest only`);
const wsRows = ws.slice(0, 1).map((w) => ({ email, data: str(w.data), updatedAt: num(w.updatedAt, (w.data && w.data.updatedAt) || 0) }));

const snapRows = (ex.snapshots || [])
  .filter((s) => s && s.data)
  .sort((a, b) => num(b.ts) - num(a.ts)).slice(0, 30)
  .map((s) => ({ email, ts: num(s.ts), updatedAt: num(s.updatedAt, (s.data && s.data.updatedAt) || 0), label: String(s.label || ""), data: str(s.data) }));

const logRows = (ex.securityLog || []).map((l) => ({ email, ts: num(l.ts), event: String(l.event || ""), detail: String(l.detail || ""), deviceId: String(l.deviceId || "") }));

const devRows = (ex.devices || []).map((d) => ({
  email, deviceId: String(d.deviceId || ""), label: String(d.label || "Device"), platform: String(d.platform || ""),
  status: ["trusted", "pending", "revoked"].includes(d.status) ? d.status : "pending",
  firstSeen: num(d.firstSeen), lastSeen: num(d.lastSeen), approvedBy: String(d.approvedBy || ""), approvedAt: num(d.approvedAt),
}));

fs.writeFileSync(path.join(outDir, "workspaces.jsonl"), jsonl(wsRows));
fs.writeFileSync(path.join(outDir, "snapshots.jsonl"), jsonl(snapRows));
fs.writeFileSync(path.join(outDir, "securityLog.jsonl"), jsonl(logRows));
fs.writeFileSync(path.join(outDir, "devices.jsonl"), jsonl(devRows));

const big = [...wsRows, ...snapRows].filter((r) => r.data.length > 950_000).length;
console.log(`converted for ${email}: workspaces ${wsRows.length} (${wsRows[0] ? wsRows[0].data.length.toLocaleString() + " bytes" : "-"}), snapshots ${snapRows.length}, securityLog ${logRows.length}, devices ${devRows.length}` + (big ? ` — WARNING: ${big} blob(s) exceed 950 KB` : ""));
