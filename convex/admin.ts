import { internalQuery } from "./_generated/server";

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
