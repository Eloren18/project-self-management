import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { ADMIN_EMAIL, SNAPSHOT_KEEP, byteLen } from "./lib";

// Read-only, CLI-only diagnostics. Every scan is index-bounded to the single
// account (ADMIN_EMAIL) and capped: workspaces/meta (1 row), snapshots (≤ 30
// metadata rows — the blobs live in snapshotBlobs and are never read here),
// devices (≤ 20), sessions (≤ 10). Nothing here ever prints workspace contents.
//   npx convex run admin:stats            (dev)
//   npx convex run admin:stats --prod     (production)
export const stats = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const email = ADMIN_EMAIL;
    const ws = await ctx.db.query("workspaces").withIndex("by_email", (q) => q.eq("email", email)).take(5);
    const metas = await ctx.db.query("workspaceMeta").withIndex("by_email", (q) => q.eq("email", email)).take(5);
    const snaps = await ctx.db.query("snapshots").withIndex("by_email_ts", (q) => q.eq("email", email)).order("desc").take(SNAPSHOT_KEEP + 10);
    const devices = await ctx.db.query("devices").withIndex("by_email_device", (q) => q.eq("email", email)).take(100);
    const sessions = await ctx.db.query("sessions").withIndex("by_email", (q) => q.eq("email", email)).take(100);
    const log = await ctx.db.query("securityLog").withIndex("by_email_ts", (q) => q.eq("email", email)).order("desc").take(1000);
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
      workspaces: ws.map((r) => ({ email: r.email, updatedAt: new Date(r.updatedAt).toISOString(), bytes: byteLen(r.data), counts: counts(r.data) })),
      workspaceMeta: metas.map((m) => ({ updatedAt: new Date(m.updatedAt).toISOString(), writerDeviceId: m.writerDeviceId.slice(0, 8), bytes: m.bytes })),
      snapshots: {
        count: snaps.length,
        totalBytes: snaps.reduce((a, s) => a + (s.bytes ?? (s.data ? s.data.length : 0)), 0),
        legacyInline: snaps.filter((s) => s.data !== undefined).length,
        newest: snaps.length ? new Date(snaps[0].ts).toISOString() : null,
      },
      devices: devices.map((d) => ({ label: d.label, status: d.status, lastSeen: new Date(d.lastSeen).toISOString() })),
      sessions: { count: sessions.length, hashed: sessions.filter((s) => !!s.tokenHash).length, legacyRaw: sessions.filter((s) => !!s.token).length },
      securityLog: log.length >= 1000 ? "1000+" : log.length,
    };
  },
});

// Snapshot metadata only (labels carry counts, never contents) — for loss investigations.
export const snapshotIndex = internalQuery({
  args: {},
  returns: v.array(v.object({ ts: v.string(), updatedAt: v.string(), bytes: v.number(), label: v.string() })),
  handler: async (ctx) => {
    const snaps = await ctx.db.query("snapshots").withIndex("by_email_ts", (q) => q.eq("email", ADMIN_EMAIL)).order("desc").take(SNAPSHOT_KEEP + 10);
    return snaps.map((s) => ({ ts: new Date(s.ts).toISOString(), updatedAt: new Date(s.updatedAt).toISOString(), bytes: s.bytes ?? (s.data ? s.data.length : 0), label: s.label }));
  },
});

export const recentLog = internalQuery({
  args: {},
  returns: v.array(v.object({ ts: v.string(), event: v.string(), detail: v.string(), device: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("securityLog").withIndex("by_email_ts", (q) => q.eq("email", ADMIN_EMAIL)).order("desc").take(30);
    return rows.map((l) => ({ ts: new Date(l.ts).toISOString(), event: l.event, detail: l.detail, device: (l.deviceId || "").slice(0, 8) }));
  },
});

// The one-off helpers used for the Sep-2026 rollout (admin:migrateSnapshots —
// inline snapshot blobs → snapshotBlobs — and admin:devTrustDevice for the dev
// end-to-end test) were removed after they ran; git history has them.
