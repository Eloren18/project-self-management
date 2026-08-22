// Export EVERYTHING from the InstantDB app (workspace, cloud snapshots, security log,
// devices, users) to a local JSON file, using an InstantDB ADMIN token (bypasses perms).
//
//   set INSTANT_ADMIN_TOKEN=...   (Export-InstantDB.bat prompts for it — never put it in chat)
//   node tools/export-instantdb.mjs
//
// Prints a SUMMARY only (counts / sizes / dates) — never the data itself.
// The output file is git-ignored (instantdb-export-*.json).
import { init } from "@instantdb/admin";
import fs from "node:fs";

const APP_ID = "62048635-507a-4feb-9d3b-69941179a9fc";
const token = process.env.INSTANT_ADMIN_TOKEN;
if (!token) { console.error("INSTANT_ADMIN_TOKEN is not set. Run Export-InstantDB.bat."); process.exit(1); }

const db = init({ appId: APP_ID, adminToken: token });
const res = await db.query({
  workspaces: { owner: {} },
  snapshots: { owner: {} },
  securityLog: { owner: {} },
  devices: { owner: {} },
  $users: {},
});

const out = { exportedAt: new Date().toISOString(), appId: APP_ID, ...res };
const file = `instantdb-export-${new Date().toISOString().slice(0, 10)}.json`;
fs.writeFileSync(file, JSON.stringify(out));

const ws = res.workspaces || [];
const countsOf = (d) => {
  d = d || {}; const per = d.personal || {};
  return {
    projects: (d.projects || []).length,
    tasks: (d.tasks || []).length + (d.projects || []).reduce((a, p) => a + ((p && p.tasks) || []).length, 0) + (d.meetings || []).reduce((a, m) => a + ((m && m.tasks) || []).length, 0),
    glossary: (d.glossary || []).length, meetings: (d.meetings || []).length, docs: (d.docs || []).length,
    personalItems: (per.items || []).length, dayPlans: Object.keys(per.dayPlans || {}).length,
  };
};
console.log("\n=== InstantDB export summary (no contents shown) ===");
console.log("file:", file, "(" + fs.statSync(file).size.toLocaleString() + " bytes)");
console.log("users:", (res.$users || []).map((u) => u.email).join(", ") || "(none)");
ws.forEach((w, i) => console.log(`workspace[${i}]: updatedAt ${w.updatedAt ? new Date(w.updatedAt).toISOString() : "?"} · ${JSON.stringify(w.data || {}).length.toLocaleString()} bytes ·`, JSON.stringify(countsOf(w.data))));
console.log("snapshots:", (res.snapshots || []).length, "· newest", (res.snapshots || []).length ? new Date(Math.max(...res.snapshots.map((s) => s.ts || 0))).toISOString() : "-");
console.log("securityLog entries:", (res.securityLog || []).length);
console.log("devices:", (res.devices || []).map((d) => `${d.label} [${d.status}]`).join(", ") || "(none)");
console.log("====================================================\n");
