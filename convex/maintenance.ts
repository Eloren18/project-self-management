import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { ADMIN_EMAIL, LOG_RETENTION_MS, SESSION_MAX_AGE_MS } from "./lib";

// Daily cron target (see crons.ts). Every scan is index-bounded and the tables it
// touches are small by construction (otps ≤ 15/day, sessions ≤ 10, log rows pruned
// 500 at a time). Also runnable by hand: npx convex run maintenance:cleanup --prod
export const cleanup = internalMutation({
  args: {},
  returns: v.object({ otps: v.number(), sessions: v.number(), logRows: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let otps = 0, sessions = 0, logRows = 0;
    const staleOtps = await ctx.db
      .query("otps")
      .withIndex("by_email", (q) => q.eq("email", ADMIN_EMAIL))
      .take(200);
    for (const o of staleOtps) if (now - o.sentAt >= 24 * 60 * 60 * 1000) { await ctx.db.delete(o._id); otps++; }
    const allSessions = await ctx.db
      .query("sessions")
      .withIndex("by_email", (q) => q.eq("email", ADMIN_EMAIL))
      .take(100);
    for (const s of allSessions) if (now - s.createdAt > SESSION_MAX_AGE_MS) { await ctx.db.delete(s._id); sessions++; }
    const old = await ctx.db
      .query("securityLog")
      .withIndex("by_email_ts", (q) => q.eq("email", ADMIN_EMAIL).lt("ts", now - LOG_RETENTION_MS))
      .take(500);
    for (const r of old) { await ctx.db.delete(r._id); logRows++; }
    return { otps, sessions, logRows };
  },
});
