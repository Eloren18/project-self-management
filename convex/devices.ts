import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { MAX_DEVICES, deviceOf, requireSession, requireTrusted, sha256Hex } from "./lib";

const status = v.union(v.literal("trusted"), v.literal("pending"), v.literal("revoked"));
const pubShape = v.object({
  id: v.id("devices"), deviceId: v.string(), label: v.string(), platform: v.string(), status,
  firstSeen: v.number(), lastSeen: v.number(), approvedBy: v.string(), approvedAt: v.number(),
});
const pub = (d: Doc<"devices">) => ({
  id: d._id, deviceId: d.deviceId, label: d.label, platform: d.platform, status: d.status,
  firstSeen: d.firstSeen, lastSeen: d.lastSeen, approvedBy: d.approvedBy, approvedAt: d.approvedAt,
});

// A trusted device sees every device; a pending/revoked one sees only itself.
export const list = query({
  args: { token: v.string(), deviceId: v.string() },
  returns: v.union(v.null(), v.array(pubShape)),
  handler: async (ctx, { token, deviceId }) => {
    const s = await requireSession(ctx, token).catch(() => null);
    if (!s) return null;
    const mine = await deviceOf(ctx, s.email, deviceId);
    if (!mine || mine.status !== "trusted") return mine ? [pub(mine)] : [];
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_email_device", (q) => q.eq("email", s.email))
      .collect();
    return rows.map(pub);
  },
});

// Register this browser. The very first device of an account is trusted
// automatically (bootstrap); every later one starts pending.
export const register = mutation({
  args: { token: v.string(), deviceId: v.string(), label: v.string(), platform: v.string() },
  returns: v.object({ status, created: v.boolean(), bootstrap: v.optional(v.boolean()) }),
  handler: async (ctx, { token, deviceId, label, platform }) => {
    const s = await requireSession(ctx, token);
    const existing = await deviceOf(ctx, s.email, deviceId);
    if (existing) return { status: existing.status, created: false };
    const all = await ctx.db
      .query("devices")
      .withIndex("by_email_device", (q) => q.eq("email", s.email))
      .collect();
    if (all.length >= MAX_DEVICES) throw new ConvexError("Too many devices registered — remove some from Security → Devices first.");
    const isFirst = all.length === 0;
    const now = Date.now();
    await ctx.db.insert("devices", {
      email: s.email, deviceId, label: label.slice(0, 120), platform: platform.slice(0, 80),
      status: isFirst ? "trusted" : "pending",
      firstSeen: now, lastSeen: now,
      approvedBy: isFirst ? "bootstrap" : "", approvedAt: isFirst ? now : 0,
    });
    return { status: isFirst ? ("trusted" as const) : ("pending" as const), created: true, bootstrap: isFirst };
  },
});

// Called once per session start. Also the moment a pre-Sep-2026 session (raw token
// stored) is upgraded to a hashed one.
export const touch = mutation({
  args: { token: v.string(), deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, { token, deviceId }) => {
    const s = await requireSession(ctx, token);
    if (s.token && !s.tokenHash) await ctx.db.patch(s._id, { tokenHash: await sha256Hex(token), token: undefined });
    const mine = await deviceOf(ctx, s.email, deviceId);
    if (mine) await ctx.db.patch(mine._id, { lastSeen: Date.now() });
    return null;
  },
});

// Approve / revoke — only a TRUSTED device may change another device's status.
export const setStatus = mutation({
  args: { token: v.string(), byDeviceId: v.string(), id: v.id("devices"), status: v.union(v.literal("trusted"), v.literal("revoked")) },
  returns: v.null(),
  handler: async (ctx, { token, byDeviceId, id, status }) => {
    const { session } = await requireTrusted(ctx, token, byDeviceId);
    const row = await ctx.db.get(id);
    if (!row || row.email !== session.email) throw new ConvexError("Unknown device.");
    if (status === "trusted") await ctx.db.patch(id, { status, approvedBy: byDeviceId, approvedAt: Date.now() });
    else await ctx.db.patch(id, { status });
    return null;
  },
});

// Reject a request / remove a device — trusted callers only.
export const remove = mutation({
  args: { token: v.string(), byDeviceId: v.string(), id: v.id("devices") },
  returns: v.null(),
  handler: async (ctx, { token, byDeviceId, id }) => {
    const { session } = await requireTrusted(ctx, token, byDeviceId);
    const row = await ctx.db.get(id);
    if (row && row.email === session.email) await ctx.db.delete(id);
    return null;
  },
});

// "Sign out all other devices": revoke every other device and drop their sessions.
export const revokeOthers = mutation({
  args: { token: v.string(), byDeviceId: v.string() },
  returns: v.object({ revoked: v.number() }),
  handler: async (ctx, { token, byDeviceId }) => {
    const { session } = await requireTrusted(ctx, token, byDeviceId);
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_email_device", (q) => q.eq("email", session.email))
      .collect();
    let n = 0;
    for (const d of rows) if (d.deviceId !== byDeviceId && d.status !== "revoked") { await ctx.db.patch(d._id, { status: "revoked" }); n++; }
    const myHash = await sha256Hex(token);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_email", (q) => q.eq("email", session.email))
      .collect();
    for (const x of sessions) if (x.tokenHash !== myHash && x.token !== token) await ctx.db.delete(x._id);
    return { revoked: n };
  },
});
