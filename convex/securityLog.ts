import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { LOG_DETAIL_MAX, LOG_EVENT_MAX, deviceOf, requireSession, trustedOrNull } from "./lib";

// Events a device may write BEFORE it is trusted (its own sign-in / approval request).
// Everything else — approvals, restores, shrink alerts — is trusted-device only, so a
// pending device can't forge "device_approved" lines for the real devices to read.
const UNTRUSTED_EVENTS = new Set(["sign_in", "device_requested"]);

// Newest entries first. Trusted devices only (the log names every device).
export const list = query({
  args: { token: v.string(), deviceId: v.string(), limit: v.optional(v.number()) },
  returns: v.union(v.null(), v.array(v.object({ id: v.id("securityLog"), ts: v.number(), event: v.string(), detail: v.string(), deviceId: v.string() }))),
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

// Append-only, bounded. Rows older than LOG_RETENTION_MS are pruned by the daily cron.
export const add = mutation({
  args: { token: v.string(), deviceId: v.string(), event: v.string(), detail: v.string() },
  returns: v.null(),
  handler: async (ctx, { token, deviceId, event, detail }) => {
    const s = await requireSession(ctx, token);
    if (!/^[a-z][a-z0-9_]*$/.test(event) || event.length > LOG_EVENT_MAX) throw new ConvexError("Bad event.");
    const d = await deviceOf(ctx, s.email, deviceId);
    if ((!d || d.status !== "trusted") && !UNTRUSTED_EVENTS.has(event)) throw new ConvexError("This device isn't approved yet.");
    await ctx.db.insert("securityLog", { email: s.email, ts: Date.now(), event, detail: (detail || "").slice(0, LOG_DETAIL_MAX), deviceId: deviceId.slice(0, 128) });
    return null;
  },
});
