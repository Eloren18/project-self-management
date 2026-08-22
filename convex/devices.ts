import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { deviceOf, requireSession, requireTrusted } from "./lib";

const pub = (d: any) => ({
  id: d._id, deviceId: d.deviceId, label: d.label, platform: d.platform, status: d.status,
  firstSeen: d.firstSeen, lastSeen: d.lastSeen, approvedBy: d.approvedBy, approvedAt: d.approvedAt,
});

// A trusted device sees every device; a pending/revoked one sees only itself.
export const list = query({
  args: { token: v.string(), deviceId: v.string() },
  handler: async (ctx, { token, deviceId }) => {
    const s = await requireSession(ctx, token).catch(() => null);
    if (!s) return null;
    const mine = await deviceOf(ctx, s.email, deviceId);
    if (!mine || mine.status !== "trusted") return mine ? [pub(mine)] : [];
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_email", (q) => q.eq("email", s.email))
      .collect();
    return rows.map(pub);
  },
});

// Register this browser. The very first device of an account is trusted
// automatically (bootstrap); every later one starts pending.
export const register = mutation({
  args: { token: v.string(), deviceId: v.string(), label: v.string(), platform: v.string() },
  handler: async (ctx, { token, deviceId, label, platform }) => {
    const s = await requireSession(ctx, token);
    const existing = await deviceOf(ctx, s.email, deviceId);
    if (existing) return { status: existing.status, created: false };
    const all = await ctx.db
      .query("devices")
      .withIndex("by_email", (q) => q.eq("email", s.email))
      .collect();
    const isFirst = all.length === 0;
    const now = Date.now();
    await ctx.db.insert("devices", {
      email: s.email, deviceId, label, platform,
      status: isFirst ? "trusted" : "pending",
      firstSeen: now, lastSeen: now,
      approvedBy: isFirst ? "bootstrap" : "", approvedAt: isFirst ? now : 0,
    });
    return { status: isFirst ? "trusted" : "pending", created: true, bootstrap: isFirst };
  },
});

export const touch = mutation({
  args: { token: v.string(), deviceId: v.string() },
  handler: async (ctx, { token, deviceId }) => {
    const s = await requireSession(ctx, token);
    const mine = await deviceOf(ctx, s.email, deviceId);
    if (mine) await ctx.db.patch(mine._id, { lastSeen: Date.now() });
  },
});

// Approve / revoke — only a TRUSTED device may change another device's status.
export const setStatus = mutation({
  args: { token: v.string(), byDeviceId: v.string(), id: v.id("devices"), status: v.string() },
  handler: async (ctx, { token, byDeviceId, id, status }) => {
    if (!["trusted", "revoked"].includes(status)) throw new ConvexError("Bad status.");
    const { session } = await requireTrusted(ctx, token, byDeviceId);
    const row = await ctx.db.get(id);
    if (!row || row.email !== session.email) throw new ConvexError("Unknown device.");
    const patch: any = { status };
    if (status === "trusted") { patch.approvedBy = byDeviceId; patch.approvedAt = Date.now(); }
    await ctx.db.patch(id, patch);
  },
});

// Reject a request / remove a device — trusted callers only.
export const remove = mutation({
  args: { token: v.string(), byDeviceId: v.string(), id: v.id("devices") },
  handler: async (ctx, { token, byDeviceId, id }) => {
    const { session } = await requireTrusted(ctx, token, byDeviceId);
    const row = await ctx.db.get(id);
    if (row && row.email === session.email) await ctx.db.delete(id);
  },
});

// "Sign out all other devices": revoke every other device and drop their sessions.
export const revokeOthers = mutation({
  args: { token: v.string(), byDeviceId: v.string() },
  handler: async (ctx, { token, byDeviceId }) => {
    const { session } = await requireTrusted(ctx, token, byDeviceId);
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_email", (q) => q.eq("email", session.email))
      .collect();
    let n = 0;
    for (const d of rows) if (d.deviceId !== byDeviceId && d.status !== "revoked") { await ctx.db.patch(d._id, { status: "revoked" }); n++; }
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_email", (q) => q.eq("email", session.email))
      .collect();
    for (const x of sessions) if (x.token !== token) await ctx.db.delete(x._id);
    return { revoked: n };
  },
});
