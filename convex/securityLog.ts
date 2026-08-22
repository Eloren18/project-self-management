import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSession, trustedOrNull } from "./lib";

// Newest entries first. Trusted devices only (the log names every device).
export const list = query({
  args: { token: v.string(), deviceId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { token, deviceId, limit }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    const rows = await ctx.db
      .query("securityLog")
      .withIndex("by_email_ts", (q) => q.eq("email", ok.session.email))
      .order("desc")
      .take(Math.min(100, Math.max(1, limit ?? 30)));
    return rows.map((r) => ({ id: r._id, ts: r.ts, event: r.event, detail: r.detail, deviceId: r.deviceId }));
  },
});

// Append-only. Any signed-in device may log (a pending device logs "device_requested").
export const add = mutation({
  args: { token: v.string(), deviceId: v.string(), event: v.string(), detail: v.string() },
  handler: async (ctx, { token, deviceId, event, detail }) => {
    const s = await requireSession(ctx, token);
    await ctx.db.insert("securityLog", { email: s.email, ts: Date.now(), event, detail: detail || "", deviceId });
  },
});
