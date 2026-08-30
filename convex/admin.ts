import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// CLI-only sanity check that NEVER prints workspace contents:
//   npx convex run admin:stats            (dev)
//   npx convex run admin:stats --prod     (production)
export const stats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ws = await ctx.db.query("workspaces").collect();
    const snaps = await ctx.db.query("snapshots").collect();
    const devices = await ctx.db.query("devices").collect();
    const log = await ctx.db.query("securityLog").collect();
    const sessions = await ctx.db.query("sessions").collect();
    const counts = (json: string) => {
      try {
        const d = JSON.parse(json); const per = d.personal || {};
        return {
          projects: (d.projects || []).length,
          tasks: (d.tasks || []).length + (d.projects || []).reduce((a: number, p: any) => a + ((p && p.tasks) || []).length, 0) + (d.meetings || []).reduce((a: number, m: any) => a + ((m && m.tasks) || []).length, 0),
          glossary: (d.glossary || []).length, meetings: (d.meetings || []).length, docs: (d.docs || []).length,
          personalItems: (per.items || []).length, dayPlans: Object.keys(per.dayPlans || {}).length,
        };
      } catch { return null; }
    };
    return {
      workspaces: ws.map((r) => ({ email: r.email, updatedAt: new Date(r.updatedAt).toISOString(), bytes: r.data.length, counts: counts(r.data) })),
      snapshots: { count: snaps.length, totalBytes: snaps.reduce((a, s) => a + s.data.length, 0), newest: snaps.length ? new Date(Math.max(...snaps.map((s) => s.ts))).toISOString() : null },
      devices: devices.map((d) => ({ label: d.label, status: d.status, lastSeen: new Date(d.lastSeen).toISOString() })),
      securityLog: log.length,
      sessions: sessions.length,
    };
  },
});

// Read-only diagnostics for loss investigations: snapshot metadata only (labels
// carry counts, never contents) and recent security-log events.
export const snapshotIndex = internalQuery({
  args: {},
  handler: async (ctx) => {
    const snaps = await ctx.db.query("snapshots").collect();
    return snaps
      .sort((a, b) => b.ts - a.ts)
      .map((s) => ({ ts: new Date(s.ts).toISOString(), updatedAt: new Date(s.updatedAt).toISOString(), bytes: s.data.length, label: s.label }));
  },
});

export const recentLog = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("securityLog").collect();
    return rows
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 30)
      .map((l) => ({ ts: new Date(l.ts).toISOString(), event: l.event, detail: l.detail, device: (l.deviceId || "").slice(0, 8) }));
  },
});

// One-off recovery for the 2026-08-29 stale-device overwrite: graft the WORK
// collections back from a chosen snapshot while keeping the CURRENT personal
// side. Runs entirely server-side; dryRun reports per-collection deltas only.
export const mergeWorkFromSnapshot = internalMutation({
  args: { tsIsoPrefix: v.string(), dryRun: v.boolean() },
  handler: async (ctx, { tsIsoPrefix, dryRun }) => {
    const snaps = await ctx.db.query("snapshots").collect();
    const cand = snaps.filter((s) => new Date(s.ts).toISOString().startsWith(tsIsoPrefix)).sort((a, b) => b.ts - a.ts)[0];
    if (!cand) throw new Error("no snapshot matches " + tsIsoPrefix);
    const row = (await ctx.db.query("workspaces").collect())[0];
    if (!row) throw new Error("no workspace row");
    const cur = JSON.parse(row.data);
    const old = JSON.parse(cand.data);
    const WORK = ["projects", "tasks", "glossary", "meetings", "docs", "weekPrep", "glossaryCollapsed", "glossaryCatOrder", "quarterGoals"];
    const count = (d: any) => ({
      projects: (d.projects || []).length,
      tasks: (d.tasks || []).length + (d.projects || []).reduce((a: number, p: any) => a + ((p && p.tasks) || []).length, 0) + (d.meetings || []).reduce((a: number, m: any) => a + ((m && m.tasks) || []).length, 0),
      meetings: (d.meetings || []).length, docs: (d.docs || []).length, glossary: (d.glossary || []).length,
      personalItems: ((d.personal || {}).items || []).length, dayPlans: Object.keys((d.personal || {}).dayPlans || {}).length,
    });
    const merged = { ...cur };
    for (const k of WORK) if (old[k] !== undefined) (merged as any)[k] = old[k];
    merged.updatedAt = Date.now();
    const report = { snapshotUsed: new Date(cand.ts).toISOString(), snapshotLabel: cand.label, before: count(cur), fromSnapshot: count(old), after: count(merged), dryRun };
    if (!dryRun) {
      await ctx.db.insert("snapshots", { email: row.email, ts: Date.now(), updatedAt: row.updatedAt, label: "pre-merge safety — " + count(cur).tasks + " tasks · " + count(cur).meetings + " meetings · " + count(cur).docs + " docs", data: row.data });
      await ctx.db.patch(row._id, { data: JSON.stringify(merged), updatedAt: merged.updatedAt });
    }
    return report;
  },
});
