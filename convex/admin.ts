import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { ADMIN_EMAIL, SNAPSHOT_KEEP, byteLen } from "./lib";

// Every scan below is index-bounded to the single account (ADMIN_EMAIL) and
// capped: workspaces/meta (1 row), snapshots (≤ 30 metadata rows), devices (≤ 20),
// sessions (≤ 10). Nothing here ever prints workspace contents.

// CLI-only sanity check:
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

// Read-only diagnostics for loss investigations: snapshot metadata only (labels
// carry counts, never contents) and recent security-log events.
export const snapshotIndex = internalQuery({
  args: {},
  returns: v.array(v.object({ ts: v.string(), updatedAt: v.string(), bytes: v.number(), label: v.string(), inline: v.boolean() })),
  handler: async (ctx) => {
    const snaps = await ctx.db.query("snapshots").withIndex("by_email_ts", (q) => q.eq("email", ADMIN_EMAIL)).order("desc").take(SNAPSHOT_KEEP + 10);
    return snaps.map((s) => ({ ts: new Date(s.ts).toISOString(), updatedAt: new Date(s.updatedAt).toISOString(), bytes: s.bytes ?? (s.data ? s.data.length : 0), label: s.label, inline: s.data !== undefined }));
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

// One-off migration (Sep 2026): move inline snapshot blobs into snapshotBlobs so
// listing/pruning never reads them again. Idempotent; runs in small batches:
//   npx convex run admin:migrateSnapshots --prod   (repeat until remaining = 0)
export const migrateSnapshots = internalMutation({
  args: { batch: v.optional(v.number()) },
  returns: v.object({ moved: v.number(), remaining: v.number() }),
  handler: async (ctx, { batch }) => {
    const all = await ctx.db.query("snapshots").withIndex("by_email_ts", (q) => q.eq("email", ADMIN_EMAIL)).take(SNAPSHOT_KEEP + 10);
    const pending = all.filter((s) => s.data !== undefined);
    let moved = 0;
    for (const s of pending.slice(0, batch ?? 5)) {
      const blobId = await ctx.db.insert("snapshotBlobs", { email: s.email, data: s.data! });
      await ctx.db.patch(s._id, { blobId, bytes: byteLen(s.data!), data: undefined });
      moved++;
    }
    return { moved, remaining: pending.length - moved };
  },
});

// DEV-ONLY helper for end-to-end testing: mark a device trusted so a test browser
// can exercise the full sync path against the dev deployment.
//   npx convex run admin:devTrustDevice '{"deviceId":"…"}'
export const devTrustDevice = internalMutation({
  args: { deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, { deviceId }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_email_device", (q) => q.eq("email", ADMIN_EMAIL).eq("deviceId", deviceId))
      .first();
    if (existing) await ctx.db.patch(existing._id, { status: "trusted", approvedBy: "dev-cli", approvedAt: now });
    else await ctx.db.insert("devices", { email: ADMIN_EMAIL, deviceId, label: "dev test browser", platform: "test", status: "trusted", firstSeen: now, lastSeen: now, approvedBy: "dev-cli", approvedAt: now });
    return null;
  },
});
